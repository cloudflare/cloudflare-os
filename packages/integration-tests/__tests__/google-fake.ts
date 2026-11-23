// Google, as the real Google gatekeeper reaches it from the integration harness: its OAuth token
// and userinfo endpoints, one Gmail mailbox per account, Chat spaces, Workspace Events
// subscriptions, Drive files' comments and replies, permissions and parents, and Pub/Sub pushes
// signed as Google signs them, delivered through the gatekeeper's own route. A handler module for
// the harness's NetworkInterceptor, as github-fake.ts is for GitHub.
//
// Each account is whoever completes OAuth with code `<code>`: its access token is `token-<code>`,
// its Google subject `sub-<code>`, its mailbox `<code>@example.com`, and its Drive permission ID
// `perm-<code>`, with the code in lower case.
//
// Two of Drive's answers here are what Google documents, where no probe saw Google give them: the
// reason code of an organization's rule against sharing outside it, `shareOutNotPermitted`, and the
// refusal of a role change, a removal or a move by an account that cannot share the file,
// `insufficientFilePermissions`, which Google was seen to answer that account's listing and share.

import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import { parse } from "jsonc-parser";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { UPGRADE_BASE_DIR } from "../scripts/build-upgrade-base.js";
import { deploy, type GatekeeperSpec, type Harness, type WorkerConfig } from "../src/harness.js";
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

/**
 * The settings every build is booted with: OAuth credentials, and push delivery for hooks. The base
 * release reads one `PUBSUB_TOPIC` for both kinds of hook and this tree a topic per kind, here the
 * same one, as a deployment upgrading keeps its topic.
 */
function configure(config: WorkerConfig): void {
  delete config.build;
  // Workers AI has no local simulator, so wrangler would open a remote session that needs Cloudflare
  // credentials; run-dev-server.ts drops it the same way, and nothing here reads a PDF.
  delete config.ai;
  // The Worker that draws PDF pages is not booted here, and the runtime does not start with a
  // binding to a Worker outside the session. The gatekeeper takes a missing binding for no renderer.
  config.services = config.services?.filter(service => service.binding !== "PDF_RENDERER");
  config.vars = {
    ...config.vars, BASE_URL: GOOGLE_BASE_URL, CLIENT_ID: "test-client", CLIENT_SECRET: "test-secret",
    PUBSUB_TOPIC, PUBSUB_CHAT_TOPIC: PUBSUB_TOPIC, PUBSUB_GMAIL_TOPIC: PUBSUB_TOPIC,
    PUBSUB_PUSH_SERVICE_ACCOUNT: PUSH_ACCOUNT,
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
 * This tree's gatekeeper-google, prebuilt rather than built by each test file, booted under its
 * own `wrangler.jsonc`.
 */
export function googleGatekeeper(): GatekeeperSpec {
  requireBuilt(join(GOOGLE_DIR, ".wrangler/validate/src/google.ts"),
    "vp run -F @gadgets/google-gatekeeper build:integration-worker");
  return { binding: "GOOGLE", dir: GOOGLE_DIR, patch: configure };
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
  await deploy(harness.server, current => ({
    ...current,
    workers: current.workers.map(worker =>
      "config" in worker && worker.config.name === GOOGLE_WORKER ? { config: google } : worker),
  }));
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

/** A Drive reply as stored: `code` is the OAuth code of the account that wrote it. */
type DriveReply = {
  id: string; content: string; code: string; createdTime: string; modifiedTime: string;
  action?: "resolve" | "reopen";
};
/** A Drive comment as stored. `resolved` stays absent until it is first resolved, as Drive sends it. */
type DriveComment = Omit<DriveReply, "action"> & { replies: DriveReply[]; resolved?: boolean };

/** The roles Drive's permission calls give, lowest first. */
const DRIVE_SHARE_ROLES = ["reader", "commenter", "writer"] as const;
type DriveShareRole = typeof DRIVE_SHARE_ROLES[number];

/** A permission as Drive holds it on the file or folder it was given on. */
export type DrivePermission = {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: DriveShareRole;
  emailAddress?: string;
  domain?: string;
  allowFileDiscovery?: boolean;
};
/** A permission as stored. Its ID is not kept: {@link permissionId} tells it from its grantee. */
type StoredPermission = Omit<DrivePermission, "id">;
/**
 * A permission as Drive lists it on one file: the higher of its roles, with one detail for what
 * the folder the file is in gives the grantee and one for what is given on the file itself.
 */
type ListedPermission = DrivePermission & {
  permissionDetails: { permissionType: "file"; role: DriveShareRole; inherited: boolean }[];
};

/**
 * A Drive file or folder: who may only view it, who cannot see it, who can share and move it
 * (every account that can see it, when absent), the folder it is in, the permissions given on it
 * itself, and its comments.
 */
type DriveFile = {
  viewOnly: Set<string>; hidden: Set<string>; sharers?: Set<string>; folder: boolean;
  parent?: string; permissions: StoredPermission[]; comments: DriveComment[];
};

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DOCUMENT_MIME_TYPE = "application/vnd.google-apps.document";

/** Drive's error body: `errors[0].reason` is what a caller tells failures apart by. */
const driveErrorBody = (status: number, reason: string, message: string, location?: string) => ({
  error: {
    code: status, message,
    errors: [{ message, domain: "global", reason, ...(location ? { location, locationType: "parameter" } : {}) }],
  },
});
/** Drive's answer to a request it refuses. */
const driveError = (status: number, reason: string, message: string, location?: string) =>
  json(driveErrorBody(status, reason, message, location), status);
/** Drive's error body for a file it does not hold, or does not show the caller. */
const fileNotFound = (fileId: string) =>
  driveErrorBody(404, "notFound", `File not found: ${fileId}.`, "fileId");

/** Drive's refusal to show or change a file's sharing, or to move it, for an account that may not. */
const insufficientFilePermissions = (fileId: string) => driveError(
  403, "insufficientFilePermissions", `The user does not have sufficient permissions for file ${fileId}.`);
/** Drive's answer for a permission ID that names nothing it can act on. */
const permissionNotFound = (id: string) =>
  driveError(404, "notFound", `Permission not found: ${id}.`, "permissionId");

/** Where a role ranks: the higher the number, the more it allows. */
const rank = (role: DriveShareRole) => DRIVE_SHARE_ROLES.indexOf(role);

/** `value` as an ID can hold it: letters, digits, `_` and `-`, with `-` for anything else. */
const idPart = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "-");

/**
 * The permission ID of the mailbox at `address`, which is its own on every file: `perm-<code>` for
 * the address of the account of OAuth code `code`, and `perm-<address>` for any other. A mailbox is
 * one grantee however its address is capitalized, so the ID is made from the address in lower case.
 */
const mailboxPermissionId = (address: string) =>
  `perm-${idPart(address.toLowerCase().replace(/@example\.com$/, ""))}`;

/**
 * The ID Drive lists a permission under. A person's or a group's is their mailbox's
 * ({@link mailboxPermissionId}), and a domain's is `perm-domain-<domain>`, from the domain in lower
 * case. Each has `-` where the address or the domain has a character an ID cannot hold. Anyone's
 * follows its form: `anyone` when the file can be found by searching, and `anyoneWithLink` when it
 * cannot.
 */
function permissionId(permission: StoredPermission): string {
  if (permission.type === "anyone") return permission.allowFileDiscovery ? "anyone" : "anyoneWithLink";
  if (permission.type === "domain") {
    return `perm-domain-${idPart((permission.domain ?? "").toLowerCase())}`;
  }
  return mailboxPermissionId(permission.emailAddress ?? "");
}

/** What tells one grantee from another on a file. Anyone's access is one permission, in either form. */
const granteeOf = (permission: StoredPermission) =>
  permission.type === "anyone" ? "anyone" : permissionId(permission);
/** The grantee a permission ID names: either of anyone's two IDs reaches whichever form exists. */
const granteeNamed = (id: string) => id === "anyoneWithLink" ? "anyone" : id;

/** One source of a listed permission's role: the folder the file is in, or the file itself. */
const permissionDetail = (role: DriveShareRole, inherited: boolean) =>
  ({ permissionType: "file" as const, role, inherited });

/** Google's limit on a comment's or reply's content, in bytes of UTF-8. */
const MAX_COMMENT_BYTES = 4096;

/** An ID shaped as Drive's are for a comment and for a reply: `doco.` and 22 characters. */
const driveCommentId = () => `doco.${randomUUID().replaceAll("-", "").slice(0, 22)}`;

export class FakeGoogle {
  /** Each Google API request, as `METHOD host/path`. */
  readonly requests: string[] = [];
  /** The `startHistoryId` of each Gmail history read, in order. */
  readonly historyReads: string[] = [];
  /** Each refresh token revoked. */
  readonly revokedTokens: string[] = [];
  /** Gmail message IDs whose `messages.get` Google refuses with a 403. */
  readonly refused = new Set<string>();
  /** Each `files.get` an account made, single or in a batch, as `<code> <fileId>`. */
  readonly driveLookups: string[] = [];
  /** Workspace Events subscriptions, by name. */
  readonly subscriptions = new Map<string, Subscription>();
  readonly #mailboxes = new Map<string, Mailbox>();
  /** Drive files by ID, each with its comments. */
  readonly #driveFiles = new Map<string, DriveFile>();
  /** Gates holding every `messages.get` of a message until released, by message ID. */
  readonly #held = new Map<string, Gate>();
  readonly #keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  /** What each account consented to last, by its OAuth code (see #consent). */
  readonly #consented = new Map<string, string>();
  /** The domain each account's organization keeps sharing within, by its OAuth code. */
  readonly #sharingWithin = new Map<string, string>();
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
          token_type: "Bearer", scope: this.#consented.get(code ?? "") ?? "",
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
    const batch = host === "www.googleapis.com" && url.pathname === "/batch/drive/v3" && method === "POST";
    const drive = host === "www.googleapis.com" &&
      (url.pathname.startsWith("/drive/v3/files/") || url.pathname === "/drive/v3/about");
    if (!batch && !drive && host !== "gmail.googleapis.com" && host !== "chat.googleapis.com" &&
        host !== "workspaceevents.googleapis.com") {
      return null;
    }
    this.requests.push(`${method} ${host}${url.pathname}`);
    if (code === undefined) return json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401);
    if (batch) return this.#driveBatch(code, request);
    if (drive) return this.#drive(url, method, code, request);
    if (host === "gmail.googleapis.com") return this.#gmail(url, method, code);
    if (host === "chat.googleapis.com") return this.#chat(url);
    return this.#events(url, method, code, request);
  };

  /** Connect `api`'s user to the Google account of OAuth code `code`, through the gatekeeper's own flow. */
  async connect(harness: Harness, api: RpcStub<AuthenticatedApi>, code: string) {
    await this.#consent(harness, api, await api.connectAccount(GOOGLE_VENDOR_ID), code);
    return await waitFor("the connected Google account", async () =>
      (await listConnectedAccounts(api)).find(account => account.vendorId === GOOGLE_VENDOR_ID) ?? null);
  }

  /**
   * Have the account of OAuth code `code`, already connected as `account`, grant
   * `resourceUrlPatterns` too, through the gatekeeper's own consent flow. Resolves once the
   * Workshop has committed the wider credentials; a no-op when the account holds them already.
   */
  async grant(
    harness: Harness, api: RpcStub<AuthenticatedApi>, account: { id: number }, code: string,
    resourceUrlPatterns: string[],
  ): Promise<void> {
    const flow = await api.ensureAccountResources(account.id, resourceUrlPatterns);
    if (flow) await this.#consent(harness, api, flow, code);
  }

  /**
   * Complete consent flow `flow` as the account of OAuth code `code`: Google grants every scope the
   * consent screen asks for, and the ticket on the handoff page is redeemed with the flow's nonce.
   */
  async #consent(
    harness: Harness, api: RpcStub<AuthenticatedApi>, { url, nonce }: { url: string; nonce: string },
    code: string,
  ): Promise<void> {
    const begun = await harness.fetchWorker(GOOGLE_WORKER, url, { redirect: "manual" });
    if (begun.status !== 302) throw new Error(`The connect link answered ${begun.status}`);
    const consent = new URL(begun.headers.get("Location")!);
    this.#consented.set(code, consent.searchParams.get("scope") ?? "");
    const state = consent.searchParams.get("state")!;
    const page = await harness.fetchWorker(GOOGLE_WORKER,
      `${GOOGLE_BASE_URL}/oauth?code=${code}&state=${encodeURIComponent(state)}`);
    const ticket = /var ticket = (".*?");\n/.exec(await page.text());
    if (!ticket) throw new Error("The handoff page carried no ticket");
    await api.completeConnectHandoff(JSON.parse(ticket[1]!), nonce);
  }

  /** A Drive folder every account can open, list and add to. */
  driveFolder(folderId: string, options: { parent?: string; sharers?: string[] } = {}): void {
    this.#driveEntry(folderId, true, options);
  }

  /**
   * A Google Doc every account can open and comment on, except the accounts whose OAuth codes
   * `viewOnly` names, which can open it and not comment, and those `hidden` names, which cannot
   * see it. `parent` is the folder it is in, and `sharers` the accounts (by OAuth code) that can
   * share and move it: every account that can see it, unless given.
   */
  driveFile(
    fileId: string,
    options: { viewOnly?: string[]; hidden?: string[]; parent?: string; sharers?: string[] } = {},
  ): void {
    this.#driveEntry(fileId, false, options);
  }

  /** Holds a Drive file or folder as described, with the comments and permissions its ID has. */
  #driveEntry(
    id: string, folder: boolean,
    { viewOnly = [], hidden = [], parent, sharers }:
      { viewOnly?: string[]; hidden?: string[]; parent?: string; sharers?: string[] },
  ): void {
    const held = this.#driveFiles.get(id);
    this.#driveFiles.set(id, {
      viewOnly: new Set(viewOnly), hidden: new Set(hidden), folder,
      ...(sharers ? { sharers: new Set(sharers) } : {}),
      ...(parent === undefined ? {} : { parent }),
      permissions: held?.permissions ?? [], comments: held?.comments ?? [],
    });
  }

  /** The comments on Drive file `fileId`, as stored, oldest first. */
  driveComments(fileId: string): readonly DriveComment[] {
    return this.#driveFiles.get(fileId)?.comments ?? [];
  }

  /** The permissions given on a file itself, as stored. */
  drivePermissions(fileId: string): readonly DrivePermission[] {
    return (this.#driveFiles.get(fileId)?.permissions ?? [])
      .map(permission => ({ id: permissionId(permission), ...permission }));
  }

  /** The folder a file is in. */
  driveParent(fileId: string): string | undefined {
    return this.#driveFiles.get(fileId)?.parent;
  }

  /**
   * Makes Google refuse, as the rule of its organization would, every share the account of OAuth
   * code `code` makes with an address or domain outside `domain`.
   */
  forbidSharingOutside(code: string, domain: string): void {
    this.#sharingWithin.set(code, domain);
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

  /** The Drive file `fileId` as the account of OAuth code `code` sees it, if it can see it. */
  #driveFileFor(code: string, fileId: string): DriveFile | undefined {
    const file = this.#driveFiles.get(fileId);
    return file?.hidden.has(code) ? undefined : file;
  }

  /** Whether the account of OAuth code `code` can share and move `file`. */
  #shares(code: string, file: DriveFile): boolean {
    return file.sharers?.has(code) ?? true;
  }

  /**
   * `files.get` of `fileId` as the account of OAuth code `code`: the file, or Drive's refusal.
   * Drive's alias `root` answers the account's own My Drive root, a folder under an ID of its own
   * that is in no folder and in no shared drive.
   */
  #filesGet(code: string, fileId: string): { status: number; body: Row } {
    this.driveLookups.push(`${code} ${fileId}`);
    const modifiedTime = new Date().toISOString();
    if (fileId === "root") {
      return {
        status: 200,
        body: {
          id: `my-drive-${code}`, name: "My Drive", mimeType: FOLDER_MIME_TYPE, modifiedTime,
          trashed: false,
          capabilities: {
            canListChildren: true, canAddChildren: true, canComment: true, canShare: true,
            canMoveItemWithinDrive: true,
          },
        },
      };
    }
    const file = this.#driveFileFor(code, fileId);
    if (!file) return { status: 404, body: fileNotFound(fileId) };
    const shares = this.#shares(code, file);
    return {
      status: 200,
      body: {
        id: fileId, name: fileId, mimeType: file.folder ? FOLDER_MIME_TYPE : DOCUMENT_MIME_TYPE,
        modifiedTime, trashed: false, ...(file.parent === undefined ? {} : { parents: [file.parent] }),
        capabilities: {
          canListChildren: file.folder, canAddChildren: file.folder,
          canComment: !file.viewOnly.has(code), canShare: shares, canMoveItemWithinDrive: shares,
        },
      },
    };
  }

  /**
   * Drive's batch endpoint, for the `files.get` requests it carries: one part per request, in the
   * order given, each named by the index the request had.
   */
  async #driveBatch(code: string, request: Request): Promise<Response> {
    const lines = (await request.text()).matchAll(/^GET \/drive\/v3\/files\/([^/?\s]+)\?\S* HTTP\/1\.1\r?$/gm);
    const boundary = `batch_${randomUUID()}`;
    const parts = [...lines].map((match, index) => {
      const { status, body } = this.#filesGet(code, decodeURIComponent(match[1] ?? ""));
      return [
        `--${boundary}`,
        "Content-Type: application/http",
        `Content-ID: <response-item-${index}>`,
        "",
        status === 200 ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found",
        "Content-Type: application/json",
        "",
        JSON.stringify(body),
      ].join("\r\n");
    });
    return new Response(`${parts.join("\r\n")}\r\n--${boundary}--\r\n`, {
      headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
    });
  }

  /**
   * A file's permissions as Drive lists them to an account that can share it: those given on the
   * file itself, then those of the folder it is in that it does not have itself, which it inherits.
   * A grantee both have is one permission, with a detail for each.
   */
  #listedPermissions(file: DriveFile): ListedPermission[] {
    const inherited = this.#driveFiles.get(file.parent ?? "")?.permissions ?? [];
    const listed = (permission: StoredPermission, details: ListedPermission["permissionDetails"]) => ({
      id: permissionId(permission), ...permission,
      role: details.map(detail => detail.role).reduce((a, b) => rank(a) < rank(b) ? b : a),
      permissionDetails: details,
    });
    return [
      ...file.permissions.map(own => listed(own, [
        ...inherited.filter(above => granteeOf(above) === granteeOf(own))
          .map(above => permissionDetail(above.role, true)),
        permissionDetail(own.role, false),
      ])),
      ...inherited.filter(above => !file.permissions.some(own => granteeOf(own) === granteeOf(above)))
        .map(above => listed(above, [permissionDetail(above.role, true)])),
    ];
  }

  /**
   * Drive's permissions of one file: the list, a create, and the role change or the removal of the
   * permission `named`. Each is refused to an account that cannot share the file. A create without
   * `fields` is refused as a comment write is, takes no `emailMessage` without a notification, is
   * refused by the sharing rule of the caller's organization, and otherwise only ever raises: a
   * grantee who already has the role or a higher one, on the file or from its folder, is answered
   * unchanged, and anyone's link is made searchable and never the reverse. A role cannot be set
   * below what the folder gives, and set to exactly that, what is given on the file itself is gone.
   * A permission the folder also gives cannot be deleted. Any other request is declined, so that it
   * is reported unmocked.
   */
  async #drivePermissions(
    url: URL, method: string, code: string, request: Request, fileId: string,
    named: string | undefined,
  ): Promise<Response | null> {
    const lists = method === "GET" && named === undefined;
    const creates = method === "POST" && named === undefined;
    const changes = (method === "PATCH" || method === "DELETE") && named !== undefined;
    if (!lists && !creates && !changes) return null;
    const file = this.#driveFileFor(code, fileId);
    if (!file) return json(fileNotFound(fileId), 404);
    if (creates && !url.searchParams.has("fields")) {
      return driveError(400, "required", "The 'fields' parameter is required for this method.", "fields");
    }
    if (!this.#shares(code, file)) return insufficientFilePermissions(fileId);
    if (lists) return json({ permissions: this.#listedPermissions(file) });

    const inherited = this.#driveFiles.get(file.parent ?? "")?.permissions ?? [];
    /** The permission of `grantee` as the file lists it, which is what a write answers with. */
    const answer = (grantee: string) => {
      const listed = this.#listedPermissions(file)
        .find(permission => granteeNamed(permission.id) === grantee);
      return listed ? json(listed) : permissionNotFound(grantee);
    };
    if (named === undefined) {
      const sent = await request.json() as StoredPermission;
      const within = this.#sharingWithin.get(code);
      const outside = sent.domain ?? sent.emailAddress?.split("@").at(-1);
      if (within !== undefined && outside !== undefined &&
          outside.toLowerCase() !== within.toLowerCase()) {
        return driveError(403, "shareOutNotPermitted",
          "The user is not permitted to share this item outside their organization.");
      }
      if (url.searchParams.has("emailMessage") &&
          url.searchParams.get("sendNotificationEmail") === "false") {
        return driveError(403, "forbidden", "The emailMessage parameter is only applicable when " +
          "sendNotificationEmail=true and the permission type is 'user' or 'group'.", "emailMessage");
      }
      const grant: StoredPermission = {
        type: sent.type, role: sent.role,
        ...(sent.emailAddress === undefined ? {} : { emailAddress: sent.emailAddress }),
        ...(sent.domain === undefined ? {} : { domain: sent.domain }),
        ...(sent.type === "domain" || sent.type === "anyone"
          ? { allowFileDiscovery: sent.allowFileDiscovery === true } : {}),
      };
      const grantee = granteeOf(grant);
      let own = file.permissions.find(permission => granteeOf(permission) === grantee);
      const above = inherited.find(permission => granteeOf(permission) === grantee);
      // True of a grantee with no access at all, too.
      const raises = [own, above].every(held => !held || rank(held.role) < rank(grant.role));
      if (raises && own) own.role = grant.role;
      else if (raises) file.permissions.push(own = grant);
      // A create widens a link and never narrows one.
      if (own?.type === "anyone" && grant.allowFileDiscovery) own.allowFileDiscovery = true;
      return answer(grantee);
    }

    const id = decodeURIComponent(named);
    const grantee = granteeNamed(id);
    const at = file.permissions.findIndex(permission => granteeOf(permission) === grantee);
    const own = file.permissions[at];
    const above = inherited.find(permission => granteeOf(permission) === grantee);
    if (method === "DELETE") {
      if (above) {
        return driveError(403, "cannotDeletePermission",
          "The authenticated user does not have the required access to delete the permission.");
      }
      if (!own) return permissionNotFound(id);
      file.permissions.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    const held = own ?? above;
    if (!held) return permissionNotFound(id);
    const { role } = await request.json() as { role: DriveShareRole };
    if (above && rank(role) < rank(above.role)) {
      return driveError(403, "cannotModifyInheritedPermission", "Cannot modify a permission on an " +
        "item to be less than the inherited access from a direct or indirect parent.");
    }
    // Set to exactly what the folder gives, nothing is left on the file itself.
    if (above && role === above.role) {
      if (own) file.permissions.splice(at, 1);
    } else if (own) {
      own.role = role;
    } else {
      file.permissions.push({ ...held, role });
    }
    return answer(grantee);
  }

  /** Whether folder `folderId` is `fileId` itself, or is inside it at any depth. */
  #isWithin(folderId: string, fileId: string): boolean {
    const seen = new Set<string>();
    for (let at: string | undefined = folderId; at !== undefined && !seen.has(at);
        at = this.#driveFiles.get(at)?.parent) {
      if (at === fileId) return true;
      seen.add(at);
    }
    return false;
  }

  /**
   * Drive's move of a file or folder into folder `to`, as the gatekeeper sends it, with the folder
   * it leaves named too. That one is not looked at: Drive ignores one that is not the file's
   * parent, so a repeat changes nothing. A folder is not moved into itself, or into a folder
   * inside it.
   */
  #driveMove(code: string, fileId: string, to: string): Response {
    const file = this.#driveFileFor(code, fileId);
    if (!file) return json(fileNotFound(fileId), 404);
    if (!this.#shares(code, file)) return insufficientFilePermissions(fileId);
    const destination = this.#driveFileFor(code, to);
    if (!destination) return json(fileNotFound(to), 404);
    if (!destination.folder) {
      return driveError(403, "parentNotAFolder", "The specified parent is not a folder.");
    }
    if (this.#isWithin(to, fileId)) return driveError(400, "badRequest", "Bad Request");
    file.parent = to;
    return json({ id: fileId, parents: [to] });
  }

  /**
   * Drive's about.get, files.get, permissions, moves, and comments and replies, answering as Google
   * was seen to: a comment write needs `fields`, an empty resolve is stored as `""`, a plain reply
   * to a resolved comment reopens it, and resolving a resolved one adds another reply. Content is
   * stored without the spaces, tabs and line breaks at its ends, and refused over 4096 bytes of
   * UTF-8. An account that can only view a file is listed none of its comments, and is refused a
   * write.
   */
  async #drive(url: URL, method: string, code: string, request: Request): Promise<Response | null> {
    if (url.pathname === "/drive/v3/about") {
      if (method !== "GET") return null;
      const emailAddress = FakeGoogle.mailboxOf(code);
      return json({ user: { permissionId: mailboxPermissionId(emailAddress), emailAddress } });
    }
    const permissions = /^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/.exec(url.pathname);
    if (permissions) {
      return this.#drivePermissions(
        url, method, code, request, decodeURIComponent(permissions[1] ?? ""), permissions[2]);
    }
    const match = /^\/drive\/v3\/files\/([^/]+)(\/comments(?:\/([^/]+)(\/replies)?)?)?$/.exec(url.pathname);
    if (!match) return null;
    const [, rawFileId, commentsPath, rawCommentId, repliesPath] = match;
    const fileId = decodeURIComponent(rawFileId ?? "");
    // A move names the folder a file leaves as well as the one it enters, as the gatekeeper always
    // does: with either alone Drive moves the file somewhere else, and it is declined here.
    const to = url.searchParams.get("addParents");
    if (method === "PATCH" && !commentsPath && to !== null && url.searchParams.has("removeParents")) {
      return this.#driveMove(code, fileId, to);
    }
    // Reads, and the two writes that make a comment and a reply: any other request is declined,
    // so that it is reported unmocked rather than answered as a read.
    const creates = method === "POST" && commentsPath !== undefined &&
      (rawCommentId === undefined || repliesPath !== undefined);
    if (method !== "GET" && !creates) return null;
    if (!commentsPath) {
      // A download is not the metadata read answered here.
      if (url.searchParams.get("alt") === "media") return null;
      const { status, body } = this.#filesGet(code, fileId);
      return json(body, status);
    }
    const file = this.#driveFileFor(code, fileId);
    if (!file) return json(fileNotFound(fileId), 404);
    if (creates && !url.searchParams.has("fields")) {
      return driveError(400, "required", "The 'fields' parameter is required for this method.", "fields");
    }
    const canComment = !file.viewOnly.has(code);
    const wireReply = (reply: DriveReply) => ({
      id: reply.id, content: reply.content, htmlContent: reply.content.replaceAll("\n", "<br>"),
      author: { displayName: reply.code, me: reply.code === code }, createdTime: reply.createdTime,
      modifiedTime: reply.modifiedTime, deleted: false, ...(reply.action ? { action: reply.action } : {}),
    });
    const wireComment = (comment: DriveComment) => ({
      ...wireReply(comment), replies: comment.replies.map(wireReply),
      ...(comment.resolved === undefined ? {} : { resolved: comment.resolved }),
    });
    const now = new Date().toISOString();
    const write = async () => {
      const body = await request.json() as { content?: string; action?: string };
      const content = (body.content ?? "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
      if (!canComment) {
        return driveError(403, "insufficientFilePermissions",
          `The user does not have sufficient permissions for file ${fileId}.`);
      }
      if (Buffer.byteLength(content, "utf8") > MAX_COMMENT_BYTES) {
        return driveError(403, "commentLengthLimitExceeded",
          "Comment content is limited to 4096 bytes in UTF-8 encoding.");
      }
      return { content, action: body.action };
    };
    if (rawCommentId === undefined) {
      if (method === "POST") {
        const sent = await write();
        if (sent instanceof Response) return sent;
        const comment: DriveComment = {
          id: driveCommentId(), content: sent.content, code, createdTime: now, modifiedTime: now, replies: [],
        };
        file.comments.push(comment);
        return json(wireComment(comment));
      }
      const since = url.searchParams.get("startModifiedTime");
      if (since !== null && Number.isNaN(Date.parse(since))) {
        return driveError(400, "badRequest", "Invalid value for startModifiedTime.", "startModifiedTime");
      }
      return json({
        comments: (canComment ? file.comments : [])
          .filter(comment => since === null || Date.parse(comment.modifiedTime) >= Date.parse(since))
          .map(wireComment),
      });
    }
    const commentId = decodeURIComponent(rawCommentId);
    const comment = file.comments.find(candidate => candidate.id === commentId);
    if (!comment) return driveError(404, "notFound", `Comment not found: ${commentId}.`, "commentId");
    if (!repliesPath) return json(wireComment(comment));
    if (method !== "POST") return json({ replies: comment.replies.map(wireReply) });
    const sent = await write();
    if (sent instanceof Response) return sent;
    const action = sent.action === "resolve" ? "resolve"
      : sent.action === "reopen" || comment.resolved ? "reopen" : undefined;
    const reply: DriveReply = {
      id: driveCommentId(), content: sent.content, code, createdTime: now, modifiedTime: now,
      ...(action ? { action } : {}),
    };
    comment.replies.push(reply);
    comment.modifiedTime = now;
    if (action) comment.resolved = action === "resolve";
    return json(wireReply(reply));
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
