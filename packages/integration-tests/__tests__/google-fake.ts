// Google, as the real Google gatekeeper reaches it from the integration harness: its OAuth token
// and userinfo endpoints, one Gmail mailbox per account, Chat spaces, Workspace Events
// subscriptions, and Pub/Sub pushes signed as Google signs them, delivered through the gatekeeper's
// own route. A handler module for the harness's NetworkInterceptor, as github-fake.ts is for GitHub.
//
// Each account is whoever completes OAuth with code `<code>`: its access token is `token-<code>`,
// its Google subject `sub-<code>`, and its mailbox `<code>@example.com`.

import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import { parse } from "jsonc-parser";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { UPGRADE_BASE_DIR } from "../scripts/build-upgrade-base.js";
import type { GatekeeperSpec, Harness, WorkerConfig } from "../src/harness.js";
import type { Handler } from "../src/network-interceptor.js";
import { listConnectedAccounts, waitFor } from "../src/rpc-client.js";

const GOOGLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../gatekeeper-google");
export const GOOGLE_WORKER = "gatekeeper-google";
export const GOOGLE_VENDOR_ID = "google";
/** Where browsers and Pub/Sub reach the gatekeeper, through the router, as `/gatekeeper/google`. */
export const GOOGLE_BASE_URL = "https://workshop.test/gatekeeper/google";
const PUSH_URL = `${GOOGLE_BASE_URL}/pubsub`;
const PUBSUB_TOPIC = "projects/workshop-test/topics/hooks";
const PUSH_ACCOUNT = "push@workshop-test.iam.gserviceaccount.com";
const CHAT_MESSAGE_CREATED = "google.workspace.chat.message.v1.created";

/** The settings every build is booted with: OAuth credentials, and push delivery for hooks. */
function configure(config: WorkerConfig): void {
  delete config.build;
  config.vars = {
    ...config.vars, BASE_URL: GOOGLE_BASE_URL, CLIENT_ID: "test-client", CLIENT_SECRET: "test-secret",
    PUBSUB_TOPIC, PUBSUB_PUSH_SERVICE_ACCOUNT: PUSH_ACCOUNT,
  };
}

function requireBuilt(path: string, task: string): string {
  if (!existsSync(path)) throw new Error(`No ${path}: run \`${task}\` first.`);
  return path;
}

/**
 * gatekeeper-google as the release before this one shipped it: the bundle `build:upgrade-base`
 * leaves, booted under the `wrangler.jsonc` it shipped with.
 */
export function baseGoogleGatekeeper(): GatekeeperSpec {
  const main = requireBuilt(join(UPGRADE_BASE_DIR, "bundle/google.js"),
    "vp run -F @gadgets/integration-tests build:upgrade-base");
  return {
    binding: "GOOGLE",
    dir: UPGRADE_BASE_DIR,
    patch: config => {
      configure(config);
      config.main = main;
    },
  };
}

/**
 * Deploy this tree's gatekeeper-google over the running one, as releasing it does: the same Worker,
 * so the same Durable Objects and storage, running this tree's code under its `wrangler.jsonc`.
 * Every Worker restarts, which breaks the RPC sessions open at the time.
 */
export async function upgradeGoogle(harness: Harness): Promise<void> {
  const main = requireBuilt(join(GOOGLE_DIR, ".wrangler/validate/src/google.ts"),
    "vp run -F @gadgets/google-gatekeeper build:integration-worker");
  const google = parse(readFileSync(join(GOOGLE_DIR, "wrangler.jsonc"), "utf8")) as WorkerConfig;
  configure(google);
  google.main = main;
  // update() resolves at the first reload, but each Worker rebuilds and reloads on its own, so
  // that reload can still be running either one's earlier build, with another to come. Every
  // Worker carries this upgrade's mark, and it is done once each reports it.
  const upgrade = randomUUID();
  const workers: string[] = [];
  await harness.server.update(current => ({
    ...current,
    workers: current.workers.map(worker => {
      if (!("config" in worker)) throw new Error("The harness boots inline configs only");
      const config = worker.config.name === GOOGLE_WORKER ? google : worker.config;
      workers.push(config.name!);
      return { config: { ...config, vars: { ...config.vars, TEST_UPGRADE: upgrade } } };
    }),
  }));
  await waitFor("every Worker to run the upgrade", async () => {
    for (const name of workers) {
      if ((await harness.server.getWorker(name).getEnv()).TEST_UPGRADE !== upgrade) return null;
    }
    return true;
  });
}

type Row = Record<string, unknown>;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A response held until the test releases it, flagging when the gatekeeper has asked for it. */
export class Gate {
  started = false;
  readonly #released = Promise.withResolvers<void>();
  readonly released = this.#released.promise;

  release(): void {
    this.#released.resolve();
  }
}

type GmailMessage = { id: string; threadId: string; subject: string; labelIds: string[] };
type Mailbox = {
  historyId: number;
  /** One messageAdded record per message, by history ID. */
  records: { id: string; message: { id: string; threadId: string; labelIds: string[] } }[];
  messages: Map<string, GmailMessage>;
};
type Subscription = {
  name: string; authority: string; state: string; expireTime: string;
  targetResource: string; notificationEndpoint: { pubsubTopic: string };
};

/** A Chat message as Workspace Events carries it, posted by someone other than the account. */
export type ChatMessage = Row & { name: string; text: string };

export class FakeGoogle {
  /** Each Google API request, as `METHOD host/path`. */
  readonly requests: string[] = [];
  /** The `startHistoryId` of each Gmail history read, in order. */
  readonly historyReads: string[] = [];
  /** Each refresh token revoked. */
  readonly revokedTokens: string[] = [];
  /** Gmail message IDs whose `messages.get` Google refuses with a 403. */
  readonly refused = new Set<string>();
  /** Workspace Events subscriptions, by name. */
  readonly subscriptions = new Map<string, Subscription>();
  readonly #mailboxes = new Map<string, Mailbox>();
  /** Gates holding every `messages.get` of a message until released, by message ID. */
  readonly #held = new Map<string, Gate>();
  readonly #keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  /** What the token endpoint grants: whatever the consent screen asked for (see connect()). */
  #grantedScopes = "";
  #nextId = 0x1000;

  /** The mailbox address of the account OAuth code `code` connects. */
  static mailboxOf(code: string): string {
    return `${code}@example.com`;
  }

  readonly handler: Handler = async (url, method, headers, request) => {
    if (url.href === "https://oauth2.googleapis.com/token" && method === "POST") {
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "authorization_code") {
        const code = form.get("code");
        return json({
          access_token: `token-${code}`, refresh_token: `refresh-${code}`, expires_in: 3600,
          token_type: "Bearer", scope: this.#grantedScopes,
        });
      }
      const code = form.get("refresh_token")?.replace(/^refresh-/, "");
      return json({ access_token: `token-${code}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (url.href === "https://oauth2.googleapis.com/revoke" && method === "POST") {
      this.revokedTokens.push(new URLSearchParams(await request.text()).get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") {
      return json({ keys: [{ ...this.#keys.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" }] });
    }
    const code = /^Bearer token-(\S+)$/.exec(headers.get("Authorization") ?? "")?.[1];
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") {
      if (code === undefined) return json({ error: "invalid_token" }, 401);
      return json({
        sub: `sub-${code}`, email: FakeGoogle.mailboxOf(code), email_verified: true, name: code,
        picture: `https://avatars.example/${code}`,
      });
    }
    const host = url.hostname;
    if (host !== "gmail.googleapis.com" && host !== "chat.googleapis.com" && host !== "workspaceevents.googleapis.com") {
      return null;
    }
    this.requests.push(`${method} ${host}${url.pathname}`);
    if (code === undefined) return json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401);
    if (host === "gmail.googleapis.com") return this.#gmail(url, method, code);
    if (host === "chat.googleapis.com") return this.#chat(url);
    return this.#events(url, method, code, request);
  };

  /** Connect `api`'s user to the Google account of OAuth code `code`, through the gatekeeper's own flow. */
  async connect(harness: Harness, api: RpcStub<AuthenticatedApi>, code: string) {
    const { url, nonce } = await api.connectAccount(GOOGLE_VENDOR_ID);
    const begun = await harness.fetchWorker(GOOGLE_WORKER, url, { redirect: "manual" });
    if (begun.status !== 302) throw new Error(`The connect link answered ${begun.status}`);
    const consent = new URL(begun.headers.get("Location")!);
    this.#grantedScopes = consent.searchParams.get("scope") ?? "";
    const state = consent.searchParams.get("state")!;
    const page = await harness.fetchWorker(GOOGLE_WORKER,
      `${GOOGLE_BASE_URL}/oauth?code=${code}&state=${encodeURIComponent(state)}`);
    const ticket = /var ticket = (".*?");\n/.exec(await page.text());
    if (!ticket) throw new Error("The handoff page carried no ticket");
    await api.completeConnectHandoff(JSON.parse(ticket[1]!), nonce);
    return await waitFor("the connected Google account", async () =>
      (await listConnectedAccounts(api)).find(account => account.vendorId === GOOGLE_VENDOR_ID) ?? null);
  }

  /** A new message from Bob lands in `mailbox`'s inbox, recorded in its history: returns its ID. */
  arrive(mailbox: string, subject: string): string {
    const box = this.#mailbox(mailbox);
    const id = (this.#nextId++).toString(16);
    const message = { id, threadId: id, subject, labelIds: ["INBOX", "UNREAD"] };
    box.messages.set(id, message);
    box.historyId += 3;
    box.records.push({ id: String(box.historyId), message: { id, threadId: id, labelIds: message.labelIds } });
    return id;
  }

  /** The history ID `mailbox` has reached. */
  historyId(mailbox: string): string {
    return String(this.#mailbox(mailbox).historyId);
  }

  /** Hold Google's answer to every read of Gmail message `id` until the gate is released. */
  hold(id: string): Gate {
    const gate = new Gate();
    this.#held.set(id, gate);
    return gate;
  }

  /** Push, as Gmail does through Pub/Sub, that `mailbox`'s history has moved on. */
  pushGmail(harness: Harness, mailbox: string): Promise<number> {
    return this.#push(harness, {
      data: Buffer.from(JSON.stringify({ emailAddress: mailbox, historyId: this.historyId(mailbox) })).toString("base64"),
    });
  }

  /** Push one new Chat message as Workspace Events does through Pub/Sub, for subscription `name`. */
  pushChat(harness: Harness, name: string, message: ChatMessage): Promise<number> {
    const subscription = this.subscriptions.get(name);
    if (!subscription) throw new Error(`No subscription ${name}`);
    return this.#push(harness, {
      attributes: {
        "ce-type": CHAT_MESSAGE_CREATED,
        "ce-source": `//workspaceevents.googleapis.com/${name}`,
        "ce-subject": subscription.targetResource,
      },
      data: Buffer.from(JSON.stringify({ message })).toString("base64"),
    });
  }

  /** Message `n` in `space`, posted by `Person <n>`. */
  chatMessage(space: string, n: number, text = `hello ${n}`): ChatMessage {
    return {
      name: `${space}/messages/m${n}`, text, createTime: new Date().toISOString(),
      sender: { name: `users/person${n}`, displayName: `Person ${n}`, type: "HUMAN" },
      thread: { name: `${space}/threads/t${n}` }, space: { name: space },
    };
  }

  async #push(harness: Harness, message: { attributes?: Record<string, string>; data: string }): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const signed = `${base64url({ alg: "RS256", kid: "test", typ: "JWT" })}.${base64url({
      iss: "https://accounts.google.com", aud: PUSH_URL, email: PUSH_ACCOUNT, email_verified: true,
      iat: now, exp: now + 300,
    })}`;
    const token = `${signed}.${createSign("RSA-SHA256").update(signed).sign(this.#keys.privateKey, "base64url")}`;
    const response = await harness.fetchWorker(GOOGLE_WORKER, PUSH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { ...message, messageId: randomUUID() }, subscription: "projects/workshop-test/subscriptions/push" }),
    });
    return response.status;
  }

  #mailbox(address: string): Mailbox {
    let box = this.#mailboxes.get(address);
    if (!box) {
      box = { historyId: 1000, records: [], messages: new Map() };
      this.#mailboxes.set(address, box);
    }
    return box;
  }

  async #gmail(url: URL, method: string, code: string): Promise<Response | null> {
    const address = FakeGoogle.mailboxOf(code);
    const box = this.#mailbox(address);
    const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    if (path === "/profile") return json({ emailAddress: address, historyId: String(box.historyId) });
    if (path === "/watch" && method === "POST") {
      return json({ historyId: String(box.historyId), expiration: String(Date.now() + 7 * 24 * 3_600_000) });
    }
    if (path === "/history") {
      const start = url.searchParams.get("startHistoryId")!;
      this.historyReads.push(start);
      return json({
        history: box.records.filter(record => BigInt(record.id) > BigInt(start))
          .map(record => ({ id: record.id, messagesAdded: [{ message: record.message }] })),
        historyId: String(box.historyId),
      });
    }
    if (path === "/labels") {
      return json({ labels: ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD"].map(id => ({ id, name: id, type: "system" })) });
    }
    const id = /^\/messages\/([a-f0-9]+)$/.exec(path)?.[1];
    if (id === undefined) return null;
    const gate = this.#held.get(id);
    if (gate) {
      gate.started = true;
      await gate.released;
    }
    if (this.refused.has(id)) return json({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403);
    const message = box.messages.get(id);
    if (!message) return notFound();
    return json({
      id, threadId: message.threadId, labelIds: message.labelIds, internalDate: String(Date.now()), sizeEstimate: 100,
      payload: { headers: [
        { name: "From", value: "Bob <bob@example.com>" }, { name: "To", value: address },
        { name: "Subject", value: message.subject }, { name: "Message-ID", value: `<${id}@example.com>` },
      ] },
    });
  }

  #chat(url: URL): Response | null {
    const space = /^\/v1\/(spaces\/[^/]+)$/.exec(url.pathname)?.[1];
    if (space === undefined) return null;
    return json({ name: space, displayName: "Project", spaceType: "SPACE", spaceThreadingState: "THREADED_MESSAGES" });
  }

  async #events(url: URL, method: string, code: string, request: Request): Promise<Response | null> {
    const done = (subscription: Subscription) => json({ name: `operations/${randomUUID()}`, done: true, response: subscription });
    if (url.pathname === "/v1/subscriptions" && method === "POST") {
      const { targetResource, notificationEndpoint } = await request.json() as Pick<Subscription, "targetResource" | "notificationEndpoint">;
      const subscription = {
        name: `subscriptions/${randomUUID()}`, authority: `users/sub-${code}`, state: "ACTIVE",
        expireTime: new Date(Date.now() + 4 * 3_600_000).toISOString(), targetResource, notificationEndpoint,
      };
      this.subscriptions.set(subscription.name, subscription);
      return done(subscription);
    }
    const name = /^\/v1\/(subscriptions\/[^/:]+)$/.exec(url.pathname)?.[1];
    const subscription = name === undefined ? undefined : this.subscriptions.get(name);
    if (!subscription) return name === undefined ? null : notFound();
    if (method === "GET") return json(subscription);
    if (method === "PATCH") {
      subscription.expireTime = new Date(Date.now() + 4 * 3_600_000).toISOString();
      return done(subscription);
    }
    if (method === "DELETE") {
      this.subscriptions.delete(subscription.name);
      return json({ name: `operations/${randomUUID()}`, done: true });
    }
    return null;
  }
}
