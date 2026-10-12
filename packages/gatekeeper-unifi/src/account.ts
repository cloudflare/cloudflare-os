/**
 * One connected UniFi account: its credentials, its connect and reconnect flows, and the only
 * place requests to UniFi leave from. Bindings, pickers, and verifiers all send through
 * `request()`, so the API key never leaves this object, and every request to a console is paced
 * against that console's budget. Data, though not images, is briefly cached for the bindings that
 * share it.
 *
 * Not decorated with `@validateRpc()`: only this Worker's own code reaches it, through
 * `ctx.exports`.
 */

import { DurableObject } from "cloudflare:workers";
import type { ConnectHandoff, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import {
  CONNECT_TIMEOUT_MS, constantTimeEqual, INITIATION_NONCE_LIFETIME_MS, isLiveNonce, type TimedNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import { isConnectAttempted, markConnectAttempted, NONCE_KEY } from "@gadgets/gatekeeper-kit/connect-handshake";
import {
  commitStagedCredentials, discardStagedCredentials, stageCredentials,
} from "@gadgets/gatekeeper-kit/credential-stage";
import { clearCredentialExpiryLatch, notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import type { ConnectInput, ConnectPageMode } from "./connect-form";
import {
  cloudConsoleSummary, listSiteManagerConsoles, probeDirectConsole, sameConsole,
  type ConsoleSummary, type ObserveTarget, type UnifiSend,
} from "./consoles";
import { UnifiError, type UnifiFailure } from "./errors";
import {
  CLOUD_CONSOLE_BUDGET, DIRECT_CONSOLE_BUDGET, MAX_QUEUE_WAIT_MS, ResponseCache, SITE_MANAGER_BUDGET,
  TokenBucket, type Budget,
} from "./egress";
import { logger, VENDOR_ID, type UnifiEnv } from "./env";
import { sendUnifiRequest, type UnifiApp, type UnifiCredentials, type UnifiRequest, type UnifiResponse } from "./transport";

/** Who a connection belongs to, recorded when it connects. */
export type UnifiIdentity =
  | {
    mode: "cloud";
    email: string | null;
    fullName: string | null;
    /** Host IDs of the consoles the key reached when it connected. */
    consoleIds: string[];
  }
  | {
    mode: "direct";
    /** The ID resource URLs use for this console, generated when it connected. */
    consoleId: string;
    consoleName: string;
    /** The console's MAC addresses, which identify it across reconnects and connections. */
    macs: string[];
    apps: { network: boolean; protect: boolean };
  };

/** A live connection: credentials plus the identity they were proven to have. */
type StoredConnection = { credentials: UnifiCredentials; identity: UnifiIdentity };

/** The connect link's nonce, claimed while its submission is being checked. */
type FormNonce = TimedNonce & { stage: "initiation"; reconnect?: true; claimed?: true };

/** The outcome of a form submission. */
export type ConnectOutcome =
  | { kind: "invalid" }
  | { kind: "retry"; mode: "cloud" | "direct"; message: string }
  | { kind: "done"; handoff: ConnectHandoff };

/** How an account describes itself to the Workshop. */
export type AccountSummary = {
  mode: "cloud" | "direct";
  displayName: string;
  uniqueName: string;
};

const CONNECTION_KEY = "connection";
const CALLBACK_KEY = "callback";
const CONSOLES_TTL_MS = 60_000;
const GET_TTL_MS = 5_000;

/** One UniFi connection. */
export class UnifiAccount extends DurableObject<UnifiEnv> {
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #cache = new ResponseCache<UnifiResponse>();

  // -------------------------------------------------------------------------
  // Connect and reconnect

  /** Starts a connect flow: remembers the Workshop's callback and the link's nonce. */
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (!isConnectAttempted(kv)) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    kv.put(CALLBACK_KEY, callback);
    kv.put<FormNonce>(NONCE_KEY, { value: nonce, expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS, stage: "initiation" });
  }

  /** Starts a reconnect flow, whose result is staged until the Workshop commits it. */
  async prepareReconnect(nonce: string): Promise<void> {
    this.ctx.storage.kv.put<FormNonce>(NONCE_KEY, {
      value: nonce, expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS, stage: "initiation", reconnect: true,
    });
  }

  /** Which form a connect link should show, without consuming its nonce. */
  async connectPage(nonce: string): Promise<ConnectPageMode | null> {
    const stored = this.#liveNonce(nonce);
    if (!stored) return null;
    if (!stored.reconnect) return { kind: "connect" };
    const connection = this.#connection();
    if (!connection) return null;
    return connection.credentials.mode === "cloud"
      ? { kind: "reconnect", mode: "cloud" }
      : { kind: "reconnect", mode: "direct", baseUrl: connection.credentials.baseUrl };
  }

  /**
   * Checks a submitted form's credentials with UniFi, then connects, or stages a reconnect.
   * @param nonce The link's nonce.
   * @param input What the user submitted, already parsed.
   * @returns What to show next.
   */
  async submitConnectForm(nonce: string, input: ConnectInput): Promise<ConnectOutcome> {
    const kv = this.ctx.storage.kv;
    const stored = this.#liveNonce(nonce);
    if (!stored || stored.claimed) return { kind: "invalid" };
    const existing = this.#connection();
    if (stored.reconnect && (!existing || existing.credentials.mode !== input.mode)) return { kind: "invalid" };

    // Claimed before the first await: the input gate doesn't cover the outbound check, so a second
    // submission could otherwise pass the nonce check too.
    kv.put<FormNonce>(NONCE_KEY, { ...stored, claimed: true });

    let connection: StoredConnection;
    try {
      connection = await this.#check(input, stored.reconnect ? existing : undefined);
    } catch (error) {
      this.#releaseClaim(nonce);
      return { kind: "retry", mode: input.mode, message: connectErrorMessage(error, input) };
    }

    // The claim may have been replaced (a newer link) or wiped (revoke) during the check.
    const current = kv.get<FormNonce>(NONCE_KEY);
    if (!current?.claimed || !constantTimeEqual(current.value, nonce)) return { kind: "invalid" };
    kv.delete(NONCE_KEY);
    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY);
    if (!callback) return { kind: "invalid" };

    if (!stored.reconnect) {
      if (isConnectAttempted(kv)) return { kind: "invalid" };
      // Live before complete(): the Workshop describes the account during it.
      kv.put(CONNECTION_KEY, connection);
      clearCredentialExpiryLatch(kv);
      markConnectAttempted(kv);
      const handoff = await callback.complete(
        this.ctx.exports.UnifiUser({ props: { accountId: this.ctx.id.toString() } }));
      await this.ctx.storage.deleteAlarm();
      logger.info("connected", { event: "connect.completed", mode: connection.credentials.mode });
      return { kind: "done", handoff };
    }
    const stageId = stageCredentials<StoredConnection>(kv, connection, Date.now());
    return { kind: "done", handoff: await callback.reconnectComplete(stageId) };
  }

  /** Makes a staged reconnect live; see `GatekeeperUser.commitReconnect`. */
  async commitReconnect(stageId: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    const staged = commitStagedCredentials<StoredConnection>(kv, Date.now(), stageId);
    if (!staged) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    kv.put(CONNECTION_KEY, staged);
    clearCredentialExpiryLatch(kv);
    this.#cache.clear();
    this.#buckets.clear();
  }

  /** Forgets the connection. A UniFi API key can only be deleted where it was created. */
  async revoke(): Promise<void> {
    discardStagedCredentials(this.ctx.storage.kv);
    this.#cache.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Deletes an account whose connect flow was never completed. */
  override async alarm(): Promise<void> {
    if (!this.#connection()) await this.ctx.storage.deleteAll();
  }

  // -------------------------------------------------------------------------
  // What the connection is

  /** The account's identity, as recorded when it connected. */
  async identity(): Promise<UnifiIdentity | null> {
    return this.#connection()?.identity ?? null;
  }

  /** How the account describes itself. Served from storage, so it works during `complete()`. */
  async summary(): Promise<AccountSummary | null> {
    const connection = this.#connection();
    if (!connection) return null;
    const { identity, credentials } = connection;
    if (identity.mode === "cloud") {
      return {
        mode: "cloud",
        displayName: identity.fullName ?? identity.email ?? "UniFi account",
        uniqueName: identity.email ?? `UniFi account (${identity.consoleIds.length} consoles)`,
      };
    }
    const where = credentials.mode === "direct" ? new URL(credentials.baseUrl).host : identity.consoleId;
    return { mode: "direct", displayName: identity.consoleName, uniqueName: `${identity.consoleName} at ${where}` };
  }

  /**
   * The consoles this connection reaches. A cloud connection's list comes from Site Manager and is
   * cached for a minute; a direct connection's is its one console.
   */
  async listConsoles(): Promise<ConsoleSummary[]> {
    const connection = this.#connection();
    if (!connection) throw new UnifiError({ kind: "auth", message: "This UniFi connection has been removed." });
    const { identity } = connection;
    if (identity.mode === "direct") {
      return [{
        id: identity.consoleId, name: identity.consoleName, apps: identity.apps,
        permissions: identity.apps, reachable: true, macs: identity.macs,
      }];
    }
    const send: UnifiSend = request => this.#send(request, CONSOLES_TTL_MS);
    return (await listSiteManagerConsoles(send)).map(cloudConsoleSummary);
  }

  /**
   * What a collaborator must be able to see to observe a binding to `app` on one of this
   * connection's consoles, or null if the connection doesn't reach it.
   */
  async observeTarget(consoleId: string, app: UnifiApp): Promise<ObserveTarget | null> {
    const connection = this.#connection();
    const bound = connection && (await this.listConsoles()).find(c => c.id === consoleId);
    if (!connection || !bound) return null;
    const { credentials } = connection;
    return { app, consoleId, macs: bound.macs, ...(credentials.mode === "direct" && { baseUrl: credentials.baseUrl }) };
  }

  /**
   * Whether this connection's account can see an application on a console, for observer
   * verification. A cloud connection asks Site Manager, which can't be forged: it matches the
   * console by host ID or MAC address and says what the account's role there grants. A direct
   * connection knows only what answered at the URL its owner chose, so it vouches for a binding read
   * through that same URL alone, by calling the application there with its own key.
   * @returns false for no access; throws for a failure that proves nothing either way.
   */
  async canObserve(target: ObserveTarget): Promise<boolean> {
    const connection = this.#connection();
    if (!connection) return false;
    const { credentials, identity } = connection;
    if (identity.mode === "direct") {
      if (credentials.mode !== "direct" || target.baseUrl !== credentials.baseUrl) return false;
      const probe = await this.#send({
        target: { kind: "app", app: target.app, consoleId: identity.consoleId }, method: "GET",
        path: target.app === "network" ? "/v1/info" : "/v1/meta/info",
      }, GET_TTL_MS);
      if (probe.ok) return true;
      if (["auth", "forbidden", "notFound", "redirect"].includes(probe.failure.kind)) return false;
      throw new Error(probe.failure.message);
    }
    let consoles: ConsoleSummary[];
    try {
      consoles = await this.listConsoles();
    } catch (error) {
      if (error instanceof UnifiError && (error.kind === "auth" || error.kind === "forbidden")) return false;
      throw error;
    }
    const match = consoles.find(c => c.id === target.consoleId) ?? consoles.find(c => sameConsole(c.macs, target.macs));
    return match?.permissions[target.app] === true;
  }

  /** Where a console's web UI lives: under unifi.ui.com for a cloud connection, else its own URL. */
  async consoleWebUrl(consoleId: string): Promise<string> {
    const connection = this.#connection();
    if (connection?.credentials.mode === "direct") return connection.credentials.baseUrl;
    return `https://unifi.ui.com/consoles/${consoleId}`;
  }

  // -------------------------------------------------------------------------
  // Egress

  /**
   * Sends a request to UniFi with this connection's credentials. Failures come back as values,
   * since an error's class doesn't survive RPC.
   */
  async request(request: UnifiRequest): Promise<UnifiResponse> {
    return this.#send(request, GET_TTL_MS);
  }

  async #send(request: UnifiRequest, ttlMs: number): Promise<UnifiResponse> {
    const connection = this.#connection();
    if (!connection) return failure({ kind: "auth", message: "This UniFi connection has been removed." });
    const { credentials, identity } = connection;
    if (request.target.kind === "app" && identity.mode === "direct" && request.target.consoleId !== identity.consoleId) {
      return failure({ kind: "notFound", message: "This UniFi connection doesn't reach that console." });
    }
    const group = request.target.kind === "siteManager" ? "siteManager" : `console:${request.target.consoleId}`;
    if (request.method !== "GET") {
      this.#cache.invalidate(group);
      try {
        return await this.#dispatch(credentials, request, group);
      } finally {
        // Answers cached while the write was in flight may predate it.
        this.#cache.invalidate(group);
      }
    }
    const key = JSON.stringify([group, request.target, request.path, request.query ?? {}, request.accept ?? "json"]);
    // Images aren't kept: they're large, and a snapshot is asked for to see the camera now.
    // Concurrent requests for one still share a single load.
    return this.#cache.get(group, key, ttlMs, () => this.#dispatch(credentials, request, group),
      response => response.ok && "json" in response);
  }

  async #dispatch(credentials: UnifiCredentials, request: UnifiRequest, group: string): Promise<UnifiResponse> {
    const bucket = this.#bucket(group, credentials);
    const wait = await bucket.take(MAX_QUEUE_WAIT_MS, ms => new Promise(resolve => setTimeout(resolve, ms)));
    if (wait > 0) {
      return failure({
        kind: "rateLimited", retryAfterMs: wait,
        message: `The UniFi console is getting too many requests; retry in ${Math.ceil(wait / 1000)} seconds.`,
      });
    }
    const response = await sendUnifiRequest(credentials, request);
    if (response.ok) return response;
    const refusal = response.failure;
    if (refusal.kind === "rateLimited") bucket.block(Date.now() + (refusal.retryAfterMs ?? 10_000));
    // A refused change proves nothing about the key, which may only be allowed to read. Only a
    // refused read shows it stopped working.
    if (request.method !== "GET" && (refusal.kind === "auth" || refusal.kind === "forbidden")) {
      return failure({ ...refusal, kind: "forbidden", message: changeRefusedMessage(credentials.mode) });
    }
    if (refusal.kind === "auth") {
      logger.warn("UniFi rejected the API key", { event: "credentials.rejected", mode: credentials.mode });
      await notifyCredentialsExpiredOnce(
        this.ctx.storage.kv, this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY), VENDOR_ID);
    }
    return response;
  }

  #bucket(group: string, credentials: UnifiCredentials): TokenBucket {
    let bucket = this.#buckets.get(group);
    if (!bucket) {
      const budget: Budget = group === "siteManager" ? SITE_MANAGER_BUDGET
        : credentials.mode === "cloud" ? CLOUD_CONSOLE_BUDGET : DIRECT_CONSOLE_BUDGET;
      this.#buckets.set(group, bucket = new TokenBucket(budget));
    }
    return bucket;
  }

  // -------------------------------------------------------------------------
  // Internals

  #connection(): StoredConnection | undefined {
    return this.ctx.storage.kv.get<StoredConnection>(CONNECTION_KEY);
  }

  #liveNonce(nonce: string): FormNonce | null {
    const stored = this.ctx.storage.kv.get<FormNonce>(NONCE_KEY);
    return stored?.stage === "initiation" && isLiveNonce(stored, nonce, Date.now()) ? stored : null;
  }

  // Only the claim this submission took is released: a newer link, or a revoke, wins.
  #releaseClaim(nonce: string): void {
    const kv = this.ctx.storage.kv;
    const current = kv.get<FormNonce>(NONCE_KEY);
    if (current?.claimed && constantTimeEqual(current.value, nonce)) {
      const { claimed: _claimed, ...released } = current;
      kv.put<FormNonce>(NONCE_KEY, released);
    }
  }

  /**
   * Proves submitted credentials work and learns whose they are. A reconnect must reach the same
   * account (cloud) or the same console (direct) as before; a direct reconnect keeps its URL.
   */
  async #check(input: ConnectInput, existing: StoredConnection | undefined): Promise<StoredConnection> {
    if (input.mode === "cloud") {
      const credentials: UnifiCredentials = { mode: "cloud", apiKey: input.apiKey };
      const consoles = await listSiteManagerConsoles(request => sendUnifiRequest(credentials, request));
      if (consoles.length === 0) throw new ConnectRefusal("This UniFi account has no consoles to connect.");
      const email = consoles.find(c => c.email)?.email ?? null;
      const identity: UnifiIdentity = {
        mode: "cloud", email, fullName: consoles.find(c => c.fullName)?.fullName ?? null,
        consoleIds: consoles.map(c => c.id),
      };
      if (existing?.identity.mode === "cloud") {
        const before = existing.identity;
        const sameEmail = before.email === null || email === null || before.email === email;
        const overlap = identity.consoleIds.some(id => before.consoleIds.includes(id));
        if (!sameEmail || !overlap) {
          throw new ConnectRefusal("That key belongs to a different UniFi account. Reconnect with a key from the same account.");
        }
      }
      return { credentials, identity };
    }

    const baseUrl = existing?.credentials.mode === "direct" ? existing.credentials.baseUrl : input.baseUrl;
    if (!baseUrl) throw new ConnectRefusal("Enter the console's address.");
    const credentials: UnifiCredentials = {
      mode: "direct", baseUrl, apiKey: input.apiKey, ...(input.access && { access: input.access }),
    };
    const facts = await probeDirectConsole(request => sendUnifiRequest(credentials, request));
    if (existing?.identity.mode === "direct") {
      const before = existing.identity;
      if (before.macs.length > 0 && facts.macs.length > 0 && !sameConsole(before.macs, facts.macs)) {
        throw new ConnectRefusal("That address now reaches a different console. Reconnect to the original console.");
      }
      return { credentials, identity: { ...before, consoleName: facts.name, apps: facts.apps, macs: facts.macs.length ? facts.macs : before.macs } };
    }
    return {
      credentials,
      identity: {
        mode: "direct", consoleId: `local-${randomHex(8)}`, consoleName: facts.name,
        macs: facts.macs, apps: facts.apps,
      },
    };
  }
}

/** A refusal whose message is written for the person connecting. */
class ConnectRefusal extends Error {}

/** What to tell someone whose submission failed. Never quotes the key. */
export function connectErrorMessage(error: unknown, input: ConnectInput): string {
  if (error instanceof ConnectRefusal) return error.message;
  if (error instanceof UnifiError) {
    switch (error.kind) {
      case "auth":
        return input.mode === "cloud"
          ? "UniFi didn't accept that API key. Copy the whole key from unifi.ui.com → Settings → API Keys."
          : "The console didn't accept that API key. Create one on the console under Integrations.";
      case "forbidden":
        return "That API key can't use the console's applications. Create it as an administrator.";
      case "notFound":
        return input.mode === "direct"
          ? "No UniFi console answered at that address. Check it, and that the console runs UniFi Network or Protect."
          : "UniFi couldn't find this account's consoles.";
      case "unreachable": case "timeout":
        return input.mode === "direct"
          ? "Couldn't reach the console at that address from this server. It must be reachable from here: on the same network for a self-hosted Workshop, or through a tunnel."
          : "Couldn't reach UniFi. Try again in a moment.";
      default:
        return error.message;
    }
  }
  logger.error("connect check failed unexpectedly", { event: "connect.check.failed", error });
  return "Something went wrong checking those details. Try again.";
}

/** What to say when UniFi won't let a connection's key make a change it asked for. */
function changeRefusedMessage(mode: UnifiCredentials["mode"]): string {
  return mode === "cloud"
    ? "UniFi didn't let this API key make the change. Site Manager API keys can be read-only: if reads " +
      "still work, reconnect with a key that can make changes, or connect to the console directly."
    : "The console didn't let this API key make the change.";
}

function failure(f: UnifiFailure): UnifiResponse {
  return { ok: false, failure: f };
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}
