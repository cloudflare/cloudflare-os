// The Calendar configurator against the live contract tenant, as its test users. Opt-in: it runs only
// with MICROSOFT_LIVE=1, the app credentials in the root `.dev.vars`, and refresh tokens in
// `MICROSOFT_CONTRACT_TOKENS` (default ~/.config/gadgets-microsoft-contract/tokens.json, kept 0600, whose
// rotated tokens it writes back).
//
//   MICROSOFT_LIVE=1 npx vitest run __tests__/calendar-configurator.live.test.ts
//
// It relies on the tenant's "Gadgets Spike Team" calendar of Phillip's. It reads only; nothing is
// created.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CalendarConfiguratorUI } from "../src/calendar-configurator";
import type { ConfiguratorConnection } from "../src/configurator-connection";
import { GraphApi } from "../src/graph-api";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TOKENS_FILE = process.env.MICROSOFT_CONTRACT_TOKENS ?? join(homedir(), ".config", "gadgets-microsoft-contract", "tokens.json");
const enabled = process.env.MICROSOFT_LIVE === "1" && existsSync(TOKENS_FILE) && existsSync(join(ROOT, ".dev.vars"));
const TEAM = "Gadgets Spike Team";

type Label = "phillip" | "sarah" | "bob";
type User = { token: string; scopes: string[]; upn: string; name: string; tid: string; oid: string };
const users = new Map<Label, User>();

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
      users.set(label, {
        token: body.access_token, scopes: (body.scope ?? "").split(" ").map(scope => scope.replace(/^https:\/\/graph\.microsoft\.com\//, "")),
        upn: user.upn.toLowerCase(), name: user.name, tid: user.tid, oid: user.oid,
      });
    }
  } finally {
    writeFileSync(TOKENS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
    chmodSync(TOKENS_FILE, 0o600);
  }
}

function configurator(label: Label): CalendarConfiguratorUI {
  const user = users.get(label)!;
  const connection: ConfiguratorConnection = {
    identity: async () => ({ tenantId: user.tid, objectId: user.oid, name: user.name, username: user.upn, email: user.upn, fetchedAt: Date.now() }),
    grantedScopes: async () => user.scopes,
    read: async op => await op(new GraphApi(user.token)),
  };
  return new CalendarConfiguratorUI(connection, "schedule");
}

describe.skipIf(!enabled)("the Calendar configurator, live", () => {
  beforeAll(signIn, 60_000);

  it("lists Phillip's own calendars, main first", async () => {
    const ui = configurator("phillip");
    expect(await ui.getStatus()).toMatchObject({ state: "ready", me: { address: users.get("phillip")!.upn } });
    const calendars = await ui.listCalendars();
    expect(calendars[0]).toMatchObject({ isDefault: true, canEdit: true });
    expect(calendars.map(calendar => calendar.name)).toContain(TEAM);
  });

  it("writes a URL that reads back as the same binding", async () => {
    const ui = configurator("phillip");
    const team = (await ui.listCalendars()).find(calendar => calendar.name === TEAM)!;
    const url = await ui.resourceUrlFor({ kind: "calendar", calendarId: team.id, details: "limited", privateEvents: "busy", access: "read" });
    expect(url).toBe(`https://outlook.office.com/calendar/id/${encodeURIComponent(team.id)}?details=limited&access=read`);
    expect(await ui.locate(url)).toMatchObject({ kind: "calendar", calendar: { id: team.id, name: TEAM }, details: "limited", access: "read" });
  });

  it("opens Phillip's calendars for Sarah only with the shared-calendar grant", async () => {
    const ui = configurator("sarah");
    const status = await ui.getStatus();
    if (status.state !== "ready") throw new Error(status.state);
    if (status.sharedLevels.length === 0) {
      await expect(ui.openColleague(users.get("phillip")!.upn)).rejects.toThrow(/can't open calendars shared with you/);
      return;
    }
    // Exchange lists Phillip's calendars only to a delegate, and his main calendar shares only
    // free/busy, so there is nothing to find. His team calendar is shared with Sarah at `read`, yet
    // Graph won't open it through his mailbox for anyone but a delegate (404, verified live).
    await expect(ui.openColleague(users.get("phillip")!.upn)).rejects.toThrow(/hasn't shared a calendar with you/);
    const team = (await configurator("phillip").listCalendars()).find(calendar => calendar.name === TEAM)!;
    await expect(ui.resourceUrlFor({ kind: "calendar", owner: users.get("phillip")!.upn, calendarId: team.id, details: "full", privateEvents: "busy", access: "read" }))
      .rejects.toThrow(/isn't one of .* that you've been given access to/);
  });
});
