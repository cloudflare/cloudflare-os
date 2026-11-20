// The account Durable Object, which holds one connection's API key, and the HTTP routes of its
// connect flow: the connect link, which shows a form, and the form's submission.
//
// A key doesn't expire and can't be refreshed, so one the provider refuses is dead: the account
// marks it so and the user is asked to reconnect. A connection is pinned to the user whose key
// made it, and a reconnect with anyone else's key is refused.

import { DurableObject } from "cloudflare:workers";
import type { ConnectHandoff, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import {
  CONNECT_FORM_NONCE_FIELD, INVALID_LINK_HTML, connectFormHtml, connectHandoffPageHtml, errorPageHtml,
  formPageResponse, htmlResponse, readConnectForm,
} from "@gadgets/gatekeeper-kit/connect-pages";
import {
  NONCE_KEY, advanceToOAuth, claimOAuth, peekOAuth, putInitiation,
} from "@gadgets/gatekeeper-kit/connect-handshake";
import { CONNECT_TIMEOUT_MS, NONCE_BYTES } from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  CredentialCoordinator,
  CredentialSource,
  CredentialsExpiredError,
  isConnectionSuperseded,
  isCredentialsExpired,
  type CredentialsWithIdentity,
  type RejectionVerdict,
} from "@gadgets/gatekeeper-kit/credentials";
import { notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import { commitStagedCredentials, discardStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { createApi, isAuthError, isDenial } from "./acme-api";
import { KEY_HELP, MAX_KEY_LENGTH } from "./acme-auth";
import { RECONNECT_MESSAGE, accountStub, identityOf, type Identity, type PublicGrant } from "./acme-credentials";
import { VENDOR_ID, getBaseUrl, type Env } from "./acme-env";
// #if hooks
import { forgetHooks } from "./acme-hooks";
// #endif
import { parseSubresource } from "./acme-resources";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.acme", vendorId: VENDOR_ID });

/** How long the connected user's details are served before they are read from the provider again. */
const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;

// STOP(observer-cache): How long an observer-access answer is reused. A provider that doesn't say
// when access changes is only noticed to have removed it once the allowance expires.
const ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
const ACCESS_DENIED_TTL_MS = 15_000;
const accessTtl = (allowed: boolean): number => allowed ? ACCESS_ALLOWED_TTL_MS : ACCESS_DENIED_TTL_MS;
/** How many objects an access check probes at once. */
const PROBE_CONCURRENCY = 6;

/** The stored grant: the key, which is sent as the access token. */
type Grant = { accessToken: string };

/** What a connect attempt carries from the connect link to the form's submission. */
type ConnectAttempt = {
  /** The connection generation the attempt began under; a disconnect or reconnect since wins. */
  startedUnder: string;
  /** Set when the link was minted to connect a new account, whose key goes live. */
  firstConnect?: true;
};

/** A reconnect's key, staged until the Workshop confirms the browser that finished it. */
type ReconnectStage = { grant: Grant; identity: Identity; startedUnder: string };

/**
 * How a submission ended: a handoff for the browser, the form again with what was wrong with a
 * key the user may correct, or a refusal to show it.
 */
type CallbackResult =
  | { handoff: ConnectHandoff }
  | { retry: string }
  | { refused: { title: string; detail: string } };

// STOP(identity): How the provider says whose key this is. `userId` is what the connection and
// every binding are pinned to, so make it name the user AND the tenant (organization, workspace)
// the key acts in, where a user can belong to several. A key that belongs to an organization or a
// service account rather than a person still needs a stable ID to pin the connection to.
/** Reads the user a key belongs to. */
async function fetchUser(accessToken: string): Promise<Identity> {
  return identityOf(await createApi(accessToken).get("/me"));
}

// STOP(observer-probe): Whether the provider opens an object for the user whose key this is.
// Ask the same endpoint a read uses, not public metadata. A definite "no" is false; any other
// failure leaves access undetermined, so it throws. Where the provider can answer 200 without
// the object, an empty list for one, check the reply is the object asked for.
async function probe(accessToken: string, itemId: string): Promise<boolean> {
  try {
    await createApi(accessToken).get("/items/{id}", { path: { id: itemId } });
    return true;
  } catch (error) {
    if (isDenial(error)) return false;
    throw error;
  }
}

/** The account a connect link names; null when the id is not one of ours. */
function accountFor(ctx: ExecutionContext, doId: string): DurableObjectStub<UserAccount> | null {
  try {
    return accountStub(ctx.exports, doId);
  } catch {
    return null;
  }
}

/** The page that asks for the key, with `error` when it is shown again after a refused one. */
function keyFormResponse(env: Env, accountId: string, formNonce: string, error?: string): Response {
  // `formPageResponse`, not `htmlResponse`: a page that sends no referrer can't post its form.
  return formPageResponse(connectFormHtml({
    title: "Connect Acme Service",
    intro: KEY_HELP,
    action: `${getBaseUrl(env)}/${accountId}/key`,
    nonce: formNonce,
    fields: [{ name: "key", label: "API key", secret: true }],
    error,
  }), error === undefined ? 200 : 422);
}

/**
 * Serves the connect flow's routes: `GET /<account>/<nonce>`, the connect link, which shows the
 * form, and `POST /<account>/key`, its submission. `relPath` is the request path below the
 * Worker's base path.
 * @returns The response, or null for a path that is not one of the flow's.
 */
export async function handleConnect(
    req: Request, env: Env, ctx: ExecutionContext, relPath: string): Promise<Response | null> {
  const path = relPath.slice(1).split("/");
  if (path.length !== 2 || path[0].length !== 64) return null;

  if (req.method === "GET" && path[1].length === NONCE_BYTES * 2) {
    // The link is spent here: the form carries a second nonce, which only this page holds.
    const formNonce = await accountFor(ctx, path[0])?.beginKeyForm(path[1]);
    if (!formNonce) return htmlResponse(INVALID_LINK_HTML);
    return keyFormResponse(env, path[0], formNonce);
  }

  if (req.method === "POST" && path[1] === "key") {
    // A form only this Worker's own page may post, so no other site can submit a key of its choosing.
    const form = await readConnectForm(req, { origin: getBaseUrl(env) });
    if (form instanceof Response) return form;
    const formNonce = form.get(CONNECT_FORM_NONCE_FIELD) ?? "";
    const key = (form.get("key") ?? "").trim();
    const result = await accountFor(ctx, path[0])?.acceptKey(formNonce, key);
    if (!result) return htmlResponse(INVALID_LINK_HTML);
    // A refused key spent nothing, so the form goes out again with the nonce it came with.
    if ("retry" in result) return keyFormResponse(env, path[0], formNonce, result.retry);
    if ("refused" in result) return htmlResponse(errorPageHtml(result.refused.title, result.refused.detail), 409);
    return htmlResponse(connectHandoffPageHtml(result.handoff));
  }

  return null;
}

export class UserAccount extends DurableObject<Env> {
  readonly #creds = new CredentialCoordinator<Grant>(this.ctx.storage.kv, {
    // A key doesn't expire.
    expiresAt: () => undefined,
    vendorId: VENDOR_ID,
  });

  // A key can't be refreshed: one the provider refuses is dead.
  readonly #refresh = async (): Promise<Grant> => {
    throw new CredentialsExpiredError(RECONNECT_MESSAGE);
  };

  readonly #notify = (): Promise<void> => notifyCredentialsExpiredOnce(this.ctx.storage.kv,
    this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID);

  // The account's own reads (its user, its observer probes) run through the same rejection
  // handling as a facet's: a refused key is marked dead and the user asked to reconnect.
  readonly #source = new CredentialSource<PublicGrant>({
    account: () => this,
    isAuthError,
    expiredMessage: RECONNECT_MESSAGE,
    vendorId: VENDOR_ID,
  });

  // This account's answers about its own access to subresources, partitioned by the connection
  // that learned them, so none outlives a disconnect or survives a reconnect. Bypassed while the
  // account holds no grant.
  readonly #access = new KvTtlCache(this.ctx.storage.kv,
    () => this.#creds.stored() ? this.#creds.connectionGeneration() : undefined, { name: "access" });

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.#creds.stored()) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    this.ctx.storage.kv.put("callback", callback);
    putInitiation<Pick<ConnectAttempt, "firstConnect">>(this.ctx.storage.kv, initiationNonce, Date.now(),
      { firstConnect: true });
  }

  /** Arms a reconnect flow. */
  async prepareReconnect(initiationNonce: string): Promise<void> {
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  /**
   * Spends the connect link: swaps its nonce for the one the form carries.
   * @returns The form's nonce, or null when the link's doesn't match.
   */
  async beginKeyForm(initiationNonce: string): Promise<string | null> {
    // Reading the generation below writes one, which an old link to a deleted account must not.
    if (this.ctx.storage.kv.get(NONCE_KEY) === undefined) return null;
    // The kit's two-stage handshake, its second stage being the form rather than an OAuth redirect.
    return advanceToOAuth<ConnectAttempt>(this.ctx.storage.kv, initiationNonce, Date.now(), {
      startedUnder: this.#creds.connectionGeneration(),
    });
  }

  /**
   * Finishes the flow with the key the form posted. The form's nonce is checked first and spent
   * only once the provider has taken the key, so one it refuses gets the same form again. Two
   * submissions of one form may both reach the provider; only one of them can finish.
   * @returns The handoff, the form again, a refusal to show, or null when the form's nonce
   * doesn't match.
   */
  async acceptKey(formNonce: string, key: string): Promise<CallbackResult | null> {
    const kv = this.ctx.storage.kv;
    if (peekOAuth(kv, formNonce, Date.now()) === null) return null;
    if (key === "" || key.length > MAX_KEY_LENGTH) return { retry: "That isn't an Acme Service API key." };
    const grant: Grant = { accessToken: key };
    let identity: Identity;
    try {
      identity = await fetchUser(key);
    } catch (error) {
      if (isAuthError(error)) {
        // The attempt may have ended meanwhile, and a form shown for it could not be posted.
        return peekOAuth(kv, formNonce, Date.now()) === null
          ? null : { retry: "Acme Service refused that key. Check it and paste it again." };
      }
      logger.error("could not read whose key an Acme Service connection was given", { event: "acme.connect.identity.failed", error });
      throw new Error("Could not read which Acme Service user the key belongs to. Please try again.", { cause: error });
    }

    // A newer link, a disconnect or the attempt's expiry while the provider was asked ends it here.
    const attempt = claimOAuth<ConnectAttempt>(kv, formNonce, Date.now());
    if (attempt === null) return null;

    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback === undefined) {
      throw new Error("The Acme Service account was disconnected while it was being connected. Connect it again.");
    }

    let handoff: ConnectHandoff;
    if (!attempt.firstConnect) {
      const pinned = kv.get<Identity>("identity");
      if (pinned !== undefined && pinned.userId !== identity.userId) {
        return {
          refused: {
            title: "That's a different Acme Service user",
            detail: `This connection is for ${pinned.name}, but that key belongs to ${identity.name}. ` +
              `Reconnect with a key of ${pinned.name}'s, or connect the other user as a separate account.`,
          },
        };
      }
      // The reconnect URL is a bearer capability, so the new key is only staged until the
      // Workshop has confirmed the browser that finished the flow is the owner's.
      discardStagedCredentials<ReconnectStage>(kv);
      const stageId = stageCredentials<ReconnectStage>(kv,
        { grant, identity, startedUnder: attempt.startedUnder }, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      try {
        this.#creds.connect(grant, { ifGeneration: attempt.startedUnder });
      } catch (error) {
        if (!isConnectionSuperseded(error)) throw error;
        throw new Error("The Acme Service account was disconnected while it was being connected. Connect it again.",
          { cause: error });
      }
      kv.put<Identity>("identity", identity);
      try {
        const props = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        // A connection the Workshop never took leaves its grant with nobody: drop it.
        this.#creds.clear();
        kv.delete("identity");
        throw error;
      }
    }
    await this.ctx.storage.deleteAlarm();
    return { handoff };
  }

  /**
   * Makes the key staged under `stageId` live. One a newer reconnect overtook is discarded, and
   * the connection stays pinned to the user it was made with.
   */
  async commitReconnect(stageId: string): Promise<void> {
    const staged = commitStagedCredentials<ReconnectStage>(this.ctx.storage.kv, Date.now(), stageId);
    if (!staged) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    try {
      this.#creds.connect(staged.grant, { ifGeneration: staged.startedUnder });
    } catch (error) {
      if (!isConnectionSuperseded(error)) throw error;
      throw new Error("This Acme Service account was reconnected again while this reconnect was finishing, " +
        "so this one was discarded.", { cause: error });
    }
    this.ctx.storage.kv.put<Identity>("identity", staged.identity);
  }

  /** The credential triple a facet's `CredentialSource` reads. */
  async getCredentials(): Promise<CredentialsWithIdentity<PublicGrant>> {
    try {
      return await this.#creds.snapshot(this.#refresh, { notify: this.#notify });
    } catch (error) {
      // A dead grant, a disconnect, a revoke mid-refresh: to the gadget each means one thing.
      if (isCredentialsExpired(error)) throw new CredentialsExpiredError(RECONNECT_MESSAGE, { cause: error });
      throw error;
    }
  }

  /** Adjudicates the provider's refusal of the credential with `identity`. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return await this.#creds.adjudicateRejection(identity, { notify: this.#notify });
  }

  /**
   * The connected user, read again from the provider once a day old. A failed re-read serves the
   * stored copy.
   */
  async getIdentity(): Promise<Identity> {
    const stored = this.ctx.storage.kv.get<Identity>("identity");
    if (stored === undefined || !this.#creds.stored()) throw new CredentialsExpiredError(RECONNECT_MESSAGE);
    if (Date.now() - stored.fetchedAt < IDENTITY_TTL_MS) return stored;
    try {
      const fresh = await this.#source.run(creds => fetchUser(creds.accessToken), { replayable: true });
      this.ctx.storage.kv.put<Identity>("identity", fresh);
      return fresh;
    } catch (error) {
      logger.warn("failed to refresh the Acme Service identity", { event: "acme.identity.refresh.failed", error });
      return stored;
    }
  }

  /**
   * Whether this connection can read each subresource (see `itemSubresourceId`), in order. An
   * allowed answer is reused for up to 15 minutes and a denial for 15 seconds, until the next
   * reconnect. Throws for an ID it can't check, or when access can't be determined, which is never
   * reused. A key the provider refuses is marked dead, and the user asked to reconnect.
   */
  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    // Parsed before anything is asked, so an ID this account can't check is refused outright.
    const items = subresources.map(id => parseSubresource(id).itemId);
    // A connection that is gone fails the check outright, rather than serve answers it cached.
    await this.getCredentials();
    const unique = [...new Set(items)];
    const allowed = new Map<string, boolean>();
    for (let start = 0; start < unique.length; start += PROBE_CONCURRENCY) {
      await Promise.all(unique.slice(start, start + PROBE_CONCURRENCY).map(async itemId => {
        allowed.set(itemId, await this.#access.cached(itemId, accessTtl, () =>
          this.#source.run(creds => probe(creds.accessToken, itemId), { replayable: true })));
      }));
    }
    return items.map(itemId => allowed.get(itemId)!);
  }

  async alarm(): Promise<void> {
    // Drop the account if the connect flow never completed.
    if (!this.#creds.stored()) await this.ctx.storage.deleteAll();
  }

  // STOP(revoke): If the provider can revoke a key by API, do it here; say so to the user if not.
  /** Disconnects: the key is forgotten here, and stays valid at the provider until the user deletes it there. */
  async revoke(): Promise<void> {
    // Before any await, so no credential read or connect completion gets in.
    this.#creds.clear();
    // #if hooks
    // Best effort: should it fail, nothing retries it, and the hooks' firings fail without a grant.
    await forgetHooks(this.ctx.exports, this.ctx.id.toString()).catch((error: unknown) => {
      logger.warn("failed to drop the hooks of a disconnected connection", { event: "acme.hooks.forget.failed", error });
    });
    // #endif
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
