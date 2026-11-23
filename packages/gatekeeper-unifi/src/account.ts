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
import { wifiPutBody } from "./actions";
import { UnifiApi } from "./api";
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
import type { UnifiWifiNetworkChanges } from "./network-types";
import { probeConfirms, probeFor, type UnifiRequirement } from "./subresources";

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
  /**
   * What tells this account apart from every other, which the Workshop treats two accounts sharing
   * as one: the account's email, or the console's URL. Left out when UniFi didn't report an email.
   */
  uniqueName?: string;
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
      let handoff: ConnectHandoff;
      try {
        handoff = await callback.complete(this.ctx.exports.UnifiUser({ props: { accountId: this.ctx.id.toString() } }));
      } catch (error) {
        // Nothing in the Workshop records this account yet, so nothing would ever remove the key:
        // drop it, keep the attempt marked, and let the alarm collect the rest.
        kv.delete(CONNECTION_KEY);
        throw error;
      }
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
        ...(identity.email !== null && { uniqueName: identity.email }),
      };
    }
    return {
      mode: "direct", displayName: identity.consoleName,
      ...(credentials.mode === "direct" && { uniqueName: credentials.baseUrl }),
    };
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
   * Whether this connection's account can read each requirement within an application on a
   * console, for observer verification.
   *
   * It calls the endpoint each requirement's read calls (`probeFor`) with its own key, so whatever
   * its role is refused there -- another site, a camera it isn't allowed, a WiFi password -- is
   * refused here. A direct connection knows only what answered at the URL its owner chose, so it
   * vouches for a binding read through that same URL alone. A cloud connection finds the console
   * in Site Manager, which can't be forged, by host ID or MAC address, and calls it through the
   * Cloud Connector, which reaches only consoles the account owns. On a console it only
   * administers, nothing can show what its role may read, so it passes nothing.
   * @returns One answer per requirement, false for no access; throws for a failure that proves
   * nothing either way.
   */
  async canObserve(target: ObserveTarget, requirements: UnifiRequirement[]): Promise<boolean[]> {
    const connection = this.#connection();
    if (!connection) return requirements.map(() => false);
    const answers = await this.#observe(connection, target, requirements);
    // Every answer came from one key. One a reconnect replaced meanwhile answers for no one now.
    if (!sameCredentials(connection.credentials, this.#connection()?.credentials)) {
      throw new Error("This UniFi connection was reconnected during the check. Try again.");
    }
    return answers;
  }

  /**
   * Whether a connection's own site list includes a site, read as far as it takes: the list shows a
   * key only the sites its role covers, and a console can have more than one page of them.
   */
  async #listsSite(consoleId: string, siteId: string, connection: StoredConnection): Promise<boolean> {
    try {
      await new UnifiApi(request => this.#send(request, GET_TTL_MS, connection), consoleId).getSite(siteId);
      return true;
    } catch (error) {
      if (error instanceof UnifiError && ["notFound", "auth", "forbidden", "redirect"].includes(error.kind)) return false;
      throw error;
    }
  }

  /** `canObserve`'s answers, every request sent with `connection`'s credentials. */
  async #observe(connection: StoredConnection, target: ObserveTarget, requirements: UnifiRequirement[]): Promise<boolean[]> {
    const none = requirements.map(() => false);
    const { credentials, identity } = connection;
    /** The console to call with this connection's key, or null when it can't be called. */
    let consoleId: string | null;
    if (identity.mode === "direct") {
      if (credentials.mode !== "direct" || target.baseUrl !== credentials.baseUrl) return none;
      consoleId = identity.consoleId;
    } else {
      let consoles: ConsoleSummary[];
      try {
        consoles = (await listSiteManagerConsoles(request => this.#send(request, CONSOLES_TTL_MS, connection)))
          .map(cloudConsoleSummary);
      } catch (error) {
        if (error instanceof UnifiError && (error.kind === "auth" || error.kind === "forbidden")) return none;
        throw error;
      }
      const match = consoles.find(c => c.id === target.consoleId) ?? consoles.find(c => sameConsole(c.macs, target.macs));
      if (!match?.permissions[target.app]) return none;
      consoleId = match.reachable ? match.id : null;
    }
    const answers: boolean[] = [];
    // A few at a time: each is a request on this connection's own budget for the console.
    for (let start = 0; start < requirements.length; start += 6) {
      answers.push(...await Promise.all(requirements.slice(start, start + 6).map(async requirement => {
        if (consoleId === null) return false;
        if (requirement.kind === "site") return await this.#listsSite(consoleId, requirement.siteId, connection);
        const probe = await this.#send(
          { target: { kind: "app", app: target.app, consoleId }, method: "GET", ...probeFor(requirement, target.app) }, GET_TTL_MS, connection);
        if (probe.ok) return probeConfirms(requirement, "json" in probe ? probe.json : undefined, target.app);
        if (["auth", "forbidden", "notFound", "redirect"].includes(probe.failure.kind)) return false;
        throw new Error(probe.failure.message);
      })));
    }
    return answers;
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

  /**
   * Changes a WiFi network's settings. UniFi takes only the whole settings object, so this reads it
   * fresh, merges the change and writes it back, one change per network at a time. Every binding
   * to the console applies WiFi changes here, so a change approved through one can't write back
   * settings, such as a password, that another has just replaced.
   * @returns The failure, or null once the change is written.
   */
  async updateWifi(
    consoleId: string, siteId: string, wifiNetworkId: string, changes: UnifiWifiNetworkChanges,
  ): Promise<UnifiFailure | null> {
    // Queued in the network's lane, which every connection in the deployment shares (wifi-lane.ts).
    // The IDs are UUIDs, whose hex digits may be written in either case: lowercase names one lane.
    const lanes = this.ctx.exports.UnifiWifiLane;
    const lane = lanes.get(lanes.idFromName(JSON.stringify([siteId.toLowerCase(), wifiNetworkId.toLowerCase()])));
    return await lane.write(this.ctx.id.toString(), consoleId, siteId, wifiNetworkId, changes);
  }

  /**
   * `updateWifi`'s read, merge and write, run when the network's lane reaches it. Both go out with
   * the credentials stored when it starts: settings one key read must not be written with another,
   * so a reconnect in between refuses the write, and a retry reads afresh with the new key.
   */
  async writeWifi(
    consoleId: string, siteId: string, wifiNetworkId: string, changes: UnifiWifiNetworkChanges,
  ): Promise<UnifiFailure | null> {
    const connection = this.#connection();
    const api = new UnifiApi(request => this.#send(request, null, connection), consoleId);
    try {
      const raw = await api.getWifiRaw(siteId, wifiNetworkId);
      await api.putWifi(siteId, wifiNetworkId, wifiPutBody(raw, changes));
      return null;
    } catch (error) {
      if (error instanceof UnifiError) return error.toFailure();
      throw error;
    }
  }

  /**
   * Sends a request; a GET may be answered from the cache unless `ttlMs` is null.
   * @param connection The credentials to send with, if not the ones stored now.
   */
  async #send(request: UnifiRequest, ttlMs: number | null, connection = this.#connection()): Promise<UnifiResponse> {
    if (!connection) return failure({ kind: "auth", message: "This UniFi connection has been removed." });
    // A send pinned to credentials a reconnect has since replaced must not reach the cache, which
    // the new credentials share: an answer it loaded there would be served as theirs.
    if (!sameCredentials(connection.credentials, this.#connection()?.credentials)) {
      return failure({ kind: "auth", message: "This UniFi connection was reconnected. Try again." });
    }
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
    if (ttlMs === null) return await this.#dispatch(credentials, request, group);
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
    // The connection may have been removed or reconnected while this waited its turn, and UniFi
    // doesn't revoke a key: it must not go out under credentials that are no longer this connection's.
    if (!sameCredentials(credentials, this.#connection()?.credentials)) {
      return failure({ kind: "auth", message: "This UniFi connection was removed or reconnected. Try again." });
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
    // A refusal of a key a reconnect has since replaced says nothing about the key in use now.
    if (refusal.kind === "auth" && sameCredentials(credentials, this.#connection()?.credentials)) {
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
        // Only the account's email identifies it: Site Manager also lists consoles an account
        // merely administers, so a console in common could be anyone's.
        const before = existing.identity;
        if (before.email === null || email === null) {
          throw new ConnectRefusal("UniFi didn't say which account that key belongs to, so it can't replace this " +
            "connection's key. Remove the connection and connect again.");
        }
        if (before.email !== email) {
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
      // Bindings keep the console's ID across a reconnect, so it must prove it's the same console,
      // by MAC address, or they'd follow whatever now answers at the URL. One that never said who
      // it was when it connected has nothing to compare against.
      if (before.macs.length === 0) {
        throw new ConnectRefusal("This connection never confirmed which console it reaches, so it can't be " +
          "reconnected in place. Remove it and connect the console again.");
      }
      if (!sameConsole(before.macs, facts.macs)) {
        throw new ConnectRefusal(facts.macs.length === 0
          ? "Couldn't confirm that the address still reaches the same console. Try again in a moment."
          : "That address now reaches a different console. Reconnect to the original console.");
      }
      return { credentials, identity: { ...before, consoleName: facts.name, apps: facts.apps, macs: facts.macs } };
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

/** Whether `b` is the same key as `a`: what a request was sent with is still what's stored. */
function sameCredentials(a: UnifiCredentials, b: UnifiCredentials | undefined): boolean {
  return b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

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
