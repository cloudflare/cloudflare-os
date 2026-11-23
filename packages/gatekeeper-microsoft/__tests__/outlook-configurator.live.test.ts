// The Outlook configurator against the live contract tenant, as its test users. Opt-in: it runs only
// with MICROSOFT_LIVE=1, the app credentials in the root `.dev.vars`, and refresh tokens in
// `MICROSOFT_CONTRACT_TOKENS` (default ~/.config/gadgets-microsoft-contract/tokens.json, kept 0600, whose
// rotated tokens it writes back).
//
//   MICROSOFT_LIVE=1 npx vitest run __tests__/outlook-configurator.live.test.ts
//
// It sends tagged mail between the users and deletes what it sent. With OUTLOOK_FIXTURES=<file> it
// also saves what the capability answered, for rendering the frame.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutlookFolderRow } from "../src/configurator/outlook-configurator-types";
import { GraphApi } from "../src/graph-api";
import type { ConfiguratorConnection } from "../src/configurator-connection";
import { OutlookConfiguratorUI } from "../src/outlook-configurator";
import { parseOutlookUrl } from "../src/outlook-scope";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TOKENS_FILE = process.env.MICROSOFT_CONTRACT_TOKENS ?? join(homedir(), ".config", "gadgets-microsoft-contract", "tokens.json");
const enabled = process.env.MICROSOFT_LIVE === "1" && existsSync(TOKENS_FILE) && existsSync(join(ROOT, ".dev.vars"));
const GRAPH = "https://graph.microsoft.com/v1.0";

type Label = "phillip" | "sarah" | "bob";
type User = { label: Label; token: string; scopes: string[]; upn: string; name: string; tid: string; oid: string };

const users = new Map<Label, User>();
const tag = `olcfg${Date.now().toString(36)}`;
const started = new Date(Date.now() - 60_000).toISOString();
const fixtures: Record<string, unknown> = {};

async function signIn(): Promise<void> {
  const vars = Object.fromEntries(readFileSync(join(ROOT, ".dev.vars"), "utf8").split("\n")
    .map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line)).filter(match => match !== null).map(match => [match[1]!, match[2]!.trim()]));
  const stored = JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as Record<string, { refresh_token: string; upn: string; name: string; tid: string; oid: string }>;
  try {
    for (const label of ["phillip", "sarah", "bob"] as const) {
      const user = stored[label]!;
      const response = await fetch(`https://login.microsoftonline.com/${vars.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`, {
        method: "POST",
        body: new URLSearchParams({
          client_id: vars.MICROSOFT_CLIENT_ID!, client_secret: vars.MICROSOFT_CLIENT_SECRET!, grant_type: "refresh_token",
          refresh_token: user.refresh_token, scope: "offline_access https://graph.microsoft.com/.default",
        }),
      });
      const body = await response.json() as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
      if (!body.access_token || !body.refresh_token) throw new Error(`Couldn't redeem ${label}'s refresh token (${body.error}). Sign them in again.`);
      user.refresh_token = body.refresh_token;
      users.set(label, { label, token: body.access_token, scopes: (body.scope ?? "").split(" "), upn: user.upn.toLowerCase(), name: user.name, tid: user.tid, oid: user.oid });
    }
  } finally {
    writeFileSync(TOKENS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
    chmodSync(TOKENS_FILE, 0o600);
  }
}

const user = (label: Label) => users.get(label)!;

async function graph<T = Record<string, unknown>>(label: Label, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path.startsWith("https:") ? path : GRAPH + path, {
    method,
    headers: { authorization: `Bearer ${user(label).token}`, prefer: 'IdType="ImmutableId"', ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${path.slice(0, 120)}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  return (response.status === 202 || response.status === 204 ? {} : await response.json()) as T;
}

/** Sends a tagged message from one user to another, returning its ID in the recipient's mailbox. */
async function send(from: Label, to: Label, subject: string): Promise<string> {
  const internetMessageId = `<${tag}-${Math.random().toString(36).slice(2)}@gadgets.test>`;
  const draft = await graph<{ id: string }>(from, "POST", "/me/messages", {
    subject: `${subject} ${tag}`, body: { contentType: "Text", content: "Outlook configurator live check. Safe to delete." },
    toRecipients: [{ emailAddress: { address: user(to).upn } }], internetMessageId,
  });
  await graph(from, "POST", `/me/messages/${encodeURIComponent(draft.id)}/send`);
  return await arrival(to, internetMessageId);
}

async function arrival(label: Label, internetMessageId: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const page = await graph<{ value: { id: string }[] }>(label, "GET",
      `/me/messages?$filter=${encodeURIComponent(`internetMessageId eq '${internetMessageId}'`)}&$select=id`);
    if (page.value[0]) return page.value[0].id;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`${internetMessageId} never reached ${label}`);
}

function connection(label: Label): ConfiguratorConnection {
  const { token, scopes, upn, name, tid, oid } = user(label);
  return {
    identity: async () => ({ tenantId: tid, objectId: oid, name, username: upn, fetchedAt: Date.now() }),
    grantedScopes: async () => scopes,
    read: async op => await op(new GraphApi(token)),
  };
}

describe.skipIf(!enabled)("the Outlook configurator, live", { timeout: 60_000 }, () => {
  let ui: OutlookConfiguratorUI;
  let inbox: OutlookFolderRow;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await signIn();
    ui = new OutlookConfiguratorUI(connection("phillip"), "send");
    ids.budget = await send("sarah", "phillip", "Q3 budget review");
    ids.specs = await send("sarah", "phillip", "Apollo specs");
    ids.lunch = await send("bob", "phillip", "Team lunch Friday");
    await graph("phillip", "POST", `/me/messages/${encodeURIComponent(ids.budget)}/reply`, { comment: "Thanks, looking now." });
    // The reply lands in Sent Items a moment after it is accepted.
    for (let attempt = 0; attempt < 20; attempt++) {
      const sent = await graph<{ value: unknown[] }>("phillip", "GET",
        `/me/mailFolders/sentitems/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${started}`)}&$select=subject&$top=50`);
      if ((sent.value as { subject: string }[]).some(message => message.subject.includes(tag))) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }, 180_000);

  afterAll(async () => {
    for (const label of ["phillip", "sarah", "bob"] as const) {
      if (!users.has(label)) continue;
      const page = await graph<{ value: { id: string; subject: string }[] }>(label, "GET",
        `/me/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${started}`)}&$select=id,subject&$top=200`);
      for (const message of page.value.filter(candidate => candidate.subject.includes(tag))) {
        await graph(label, "POST", `/me/messages/${encodeURIComponent(message.id)}/permanentDelete`).catch(() => {});
      }
    }
    if (process.env.OUTLOOK_FIXTURES) writeFileSync(process.env.OUTLOOK_FIXTURES, JSON.stringify(fixtures, null, 2));
  }, 120_000);

  it("is ready, with every level for the user's own mailbox", async () => {
    const status = await ui.getStatus();
    fixtures.status = status;
    expect(status).toMatchObject({ state: "ready", me: { address: user("phillip").upn }, levels: ["read", "draft", "send"] });
  });

  it("lists folders with Inbox first", async () => {
    const list = await ui.listFolders(null);
    fixtures.folders = list;
    inbox = list.folders[0]!;
    expect(inbox).toMatchObject({ kind: "inbox", depth: 0 });
    expect(list.folders.map(folder => folder.kind)).toEqual(expect.arrayContaining(["drafts", "sent", "deleted", "junk", "archive"]));
  });

  it("finds colleagues through the People API", async () => {
    const sarah = await ui.searchPeople("Sarah");
    const bob = await ui.searchPeople("bo");
    fixtures.people = { sarah, bob };
    expect(sarah).toEqual(expect.arrayContaining([{ address: user("sarah").upn, name: user("sarah").name }]));
  });

  it("finds conversations by subject, recent ones, and the one a pasted link names", async () => {
    let found = await ui.findConversations(null, `budget ${tag}`);
    for (let attempt = 0; found.items.length === 0 && attempt < 30; attempt++) {
      // Exchange indexes new mail for search within a minute or so.
      await new Promise(resolve => setTimeout(resolve, 3000));
      found = await ui.findConversations(null, `budget ${tag}`);
    }
    expect(found.items).toHaveLength(1);
    expect(found.items[0]!.subject).toBe(`RE: Q3 budget review ${tag}`);
    const recent = await ui.findConversations(null, "");
    fixtures.conversations = { recent, search: await ui.findConversations(null, tag) };
    expect(recent.items.map(item => item.subject)).toEqual(expect.arrayContaining([`Team lunch Friday ${tag}`, `Apollo specs ${tag}`]));
    expect(recent.items.some(item => item.subject.includes("Unsent notes"))).toBe(false);

    const message = await graph<{ webLink: string; conversationId: string }>("phillip", "GET", `/me/messages/${encodeURIComponent(ids.specs)}?$select=webLink,conversationId`);
    expect((await ui.findConversations(null, message.webLink)).items[0]!.id).toBe(message.conversationId);
    expect((await ui.findConversations(null, `https://outlook.office.com/mail/inbox/id/${encodeURIComponent(ids.specs)}`)).items[0]!.id).toBe(message.conversationId);
  }, 120_000);

  it("writes a binding URL the parser accepts, and reads it back", async () => {
    const url = await ui.resourceUrlFor({ folder: { id: inbox.id, subfolders: false }, senders: [user("sarah").upn], access: "draft" });
    fixtures.resourceUrl = url;
    expect(parseOutlookUrl(url)).toMatchObject({ folder: `id:${inbox.id}`, subfolders: false, senders: [user("sarah").upn], access: "draft" });
    expect(await ui.locate(url)).toEqual({
      access: "draft", folder: { id: inbox.id, path: "Inbox", subfolders: false }, senders: [user("sarah").upn],
    });
  });

  it("explains each way opening a shared mailbox fails", async () => {
    const domain = user("sarah").upn.split("@")[1];
    await expect(ui.openSharedMailbox(user("sarah").upn)).rejects.toThrow(`You haven't been given access to ${user("sarah").upn}`);
    await expect(ui.openSharedMailbox(`nobody-${tag}@${domain}`)).rejects.toThrow("There's no mailbox");
    await expect(ui.openSharedMailbox(user("phillip").upn.toUpperCase())).rejects.toThrow("That's your own mailbox");
  });
});
