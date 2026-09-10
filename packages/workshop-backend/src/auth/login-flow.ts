// Sign-in via authentication gatekeepers.
//
// Unlike the normal connect-account flow (which runs for an already-logged-in user), login happens
// before we know who the user is. The PublicApi starts a gatekeeper connect flow (in "auth" scope
// mode) with a `LoginConnectCallbackImpl` as the callback and a `PendingLogin` DO to bridge the
// result back to the waiting browser:
//
//   1. PublicApi.startGatekeeperLogin(vendorId) creates a PendingLogin DO (named by the hash of a
//      fresh nonce), hands the gatekeeper a LoginConnectCallbackImpl, and returns {url, nonce,
//      attempt}, where `attempt` is an RpcStub wrapping the DO (so the client awaits via a
//      capability, never a guessable id).
//   2. The browser opens `url` as a disowned popup, after writing the flow's nonce into the popup's
//      own sessionStorage.
//   3. When the gatekeeper finishes, it calls LoginConnectCallbackImpl.complete(user). We read the
//      verified email, resolve/create the email-keyed user DO, mint a session, and deliver the token
//      to the PendingLogin DO under the hash of a fresh handoff ticket, which complete() returns; the
//      gatekeeper's final page navigates the popup to the Workshop's /connect/handoff page with the
//      ticket in the URL fragment (see connect-handoff.ts).
//   4. That page calls PublicApi.confirmLogin(ticket, nonce), which finds the DO by the nonce's hash
//      and marks the delivered result confirmed. The login tab polls `attempt.receive()`, which
//      releases the token once the result is confirmed.
//
// The sign-in URL is a bearer capability, so step 4 is what binds the session to the browser that
// started the attempt: whoever holds `attempt` without a popup holding the nonce — an attacker who
// phished a victim into finishing the flow — gets nothing, and the unreceived token expires.
//
// Sign-in only requests minimal scopes and the gatekeeper grant is transient (it self-destructs
// shortly after we read the email) — so login does NOT create a persistent connected account.
// Capability access (repos, docs, billing) is granted later when the user explicitly connects the
// gatekeeper, which requests the full scopes and persists the connection.
//
// Cloudflare is the exception: signing in also links the account for billing, and the gatekeeper
// keeps this callback for that account's lifetime. The PendingLogin DO therefore also records which
// user and account the sign-in produced (`link`), outliving the login result, so expiry notices and
// reconnects for the account reach its user DO.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { ConnectHandoff, GatekeeperConnectCallback, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "../observability";
import { CLOUDFLARE_VENDOR_ID, type UserDurableObject } from "../user.js";
import { readAdminConfig } from "../admin-config.js";
import {
  handoffTargetOrigin, hashPresentedSecret, newSecretToken, PENDING_HANDOFF_LIFETIME_MS,
} from "../connect-handoff.js";

const logger = createWorkshopLogger("workshop.auth");

// `pending` is the attempt as started, before the OAuth callback has delivered anything: it lets
// receive() tell "not delivered yet" from an expired or never-started attempt. A delivered token is
// `confirmed` once the popup has presented the matching ticket, and released only then.
type PendingOutcome =
  | { pending: true }
  | { token: string; ticketHash: string; confirmed: boolean }
  | { error: string };
// `expiresAt` bounds the result absolutely: the alarm wipes it too, but receive() must not depend on
// the alarm having fired on time.
type PendingResult = PendingOutcome & { expiresAt: number };

/**
 * How long a started attempt waits for the gatekeeper to deliver, matching the gatekeepers' own
 * connect-nonce lifetime. The shorter PENDING_HANDOFF_LIFETIME_MS is for a delivered result and
 * would expire a user who is still at the provider's consent screen.
 */
export const LOGIN_PENDING_LIFETIME_MS = 10 * 60 * 1000;

// The connected account a sign-in persisted, by the user DO that owns it (see `PendingLogin.link`).
type AccountLink = { userId: string; accountId: number };

const RESULT_KEY = "result";
const LINK_KEY = "link";
/** What confirmLogin() and LoginAttempt.receive() throw for an attempt that cannot complete. */
export const EXPIRED_MESSAGE = "This sign-in attempt has expired. Please try again.";

/**
 * Bridges a login result from the (separate) OAuth-callback invocation back to the browser that
 * started the attempt. Everything is written to storage, since nothing keeps this DO in memory
 * between the calls: begin() marks the attempt as started (for LOGIN_PENDING_LIFETIME_MS), so that
 * receive() answers null while the user is still at the provider rather than mistaking the wait for
 * an expired attempt; deliver()/fail() replace the marker with the result, which lives for
 * PENDING_HANDOFF_LIFETIME_MS at most; confirm() marks a delivered token as confirmed by the popup
 * holding its ticket, and receive() releases it only then. An alarm wipes whatever is left
 * unreceived. An account link (`link`) is kept for as long as the account exists.
 */
export class PendingLogin extends DurableObject<Cloudflare.Env> {
  /** Called by PublicApi.startGatekeeperLogin before the gatekeeper flow starts. */
  async begin(): Promise<void> {
    await this.#store({ pending: true }, LOGIN_PENDING_LIFETIME_MS);
  }

  /** Called by LoginConnectCallbackImpl on success, with the hash of the ticket that confirms it. */
  async deliver(token: string, ticketHash: string): Promise<void> {
    await this.#store({ token, ticketHash, confirmed: false });
  }

  /**
   * Called by LoginConnectCallbackImpl when the sign-in cannot complete; confirm() and receive()
   * report `reason`.
   */
  async fail(reason: string): Promise<void> {
    await this.#store({ error: reason });
  }

  async #store(result: PendingOutcome, lifetimeMs = PENDING_HANDOFF_LIFETIME_MS): Promise<void> {
    const expiresAt = Date.now() + lifetimeMs;
    this.ctx.storage.kv.put<PendingResult>(RESULT_KEY, { ...result, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt);
  }

  /**
   * Records the connected account this sign-in persisted, so the callback the gatekeeper holds for
   * it can reach the account's user DO. Independent of the login result: a sign-in whose token is
   * never received still linked the (owner's own) account.
   */
  async link(userId: string, accountId: number): Promise<void> {
    this.ctx.storage.kv.put<AccountLink>(LINK_KEY, { userId, accountId });
  }

  async getLink(): Promise<AccountLink | null> {
    return this.ctx.storage.kv.get<AccountLink>(LINK_KEY) ?? null;
  }

  /**
   * Called by PublicApiImpl.confirmLogin from the popup: marks the delivered token as confirmed by
   * the holder of the matching ticket, so receive() releases it. A wrong or malformed ticket, or one
   * arriving before delivery (a ticket cannot precede the delivery that minted it, so this is a
   * guess), throws EXPIRED_MESSAGE without touching the result: it must not consume what the right
   * ticket is about to confirm. The ticket is hashed before the read, so the read, check and rewrite
   * happen in one step under the input gate.
   */
  async confirm(ticket: string): Promise<void> {
    const hash = await hashPresentedSecret(ticket);
    const result = await this.#result();
    if ("pending" in result || hash !== result.ticketHash) throw new Error(EXPIRED_MESSAGE);
    this.ctx.storage.kv.put<PendingResult>(RESULT_KEY, { ...result, confirmed: true });
  }

  /**
   * Release the token to the holder of the attempt once the popup has confirmed it; null while the
   * attempt is still pending or the token is delivered but unconfirmed, so the caller polls. Single
   * use: the result is removed with the read, so a repeat gets no second try.
   */
  async receive(): Promise<string | null> {
    const result = await this.#result();
    if ("pending" in result || !result.confirmed) return null;
    await this.#clear();
    return result.token;
  }

  // The live result, or a throw for an attempt that cannot complete: none (never begun, wiped, or
  // already received), expired, or failed; the latter two are cleared as they are reported.
  async #result(): Promise<Exclude<PendingResult, { error: string }>> {
    const result = this.ctx.storage.kv.get<PendingResult>(RESULT_KEY);
    if (!result || Date.now() >= result.expiresAt) {
      await this.#clear();
      throw new Error(EXPIRED_MESSAGE);
    }
    if ("error" in result) {
      await this.#clear();
      throw new Error(result.error);
    }
    return result;
  }

  async #clear(): Promise<void> {
    this.ctx.storage.kv.delete(RESULT_KEY);
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    this.ctx.storage.kv.delete(RESULT_KEY);
  }
}

type LoginCallbackProps = { pendingId: string; vendorId: string };

export class LoginConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, LoginCallbackProps>
    implements GatekeeperConnectCallback {
  #pending() {
    const id = this.ctx.exports.PendingLogin.idFromString(this.ctx.props.pendingId);
    return this.ctx.exports.PendingLogin.get(id);
  }

  /**
   * Mints the session and parks it in the PendingLogin DO under a fresh ticket's hash; returns the
   * handoff whose ticket the popup's page must present to confirmLogin().
   */
  async complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<ConnectHandoff> {
    const targetOrigin = handoffTargetOrigin(this.env);
    const { secret, hash } = await newSecretToken();
    await this.#deliver(account, expiresAt, hash);
    return { targetOrigin, ticket: secret.toHex() };
  }

  async #deliver(account: Fetcher<GatekeeperUser>, expiresAt: Date | undefined,
                 ticketHash: string): Promise<void> {
    const loginLogger = logger.with({
      operation: "gatekeeper.login",
      vendorId: this.ctx.props.vendorId,
    });
    const pending = this.#pending();
    // `account` is a call parameter, so Cap'n Web disposes it automatically when this method
    // returns — no explicit disposal needed. We read the verified email to resolve/create the user.
    // The email's local-part seeds the initial display name, like the Cloudflare Access flow.
    try {
      const email = await account.getAuthenticatedEmail();
      if (!email) {
        loginLogger.info("gatekeeper login finished", {
          event: "gatekeeper.login.finished", outcome: "no_email",
        });
        await pending.fail("This account has no verified email, so it can't be used to sign in.");
        return;
      }
      const userStub = this.ctx.exports.UserDurableObject.get(
          this.ctx.exports.UserDurableObject.idFromName(email));
      // Closed signups block first-time account creation here too (not just password signup); an
      // existing user signing in is unaffected.
      const signupsEnabled = (await readAdminConfig(this.env)).signupsEnabled;
      const secret = await userStub.loginOrCreateViaGatekeeper(email, signupsEnabled);
      if (secret === null) {
        loginLogger.info("gatekeeper login finished", {
          event: "gatekeeper.login.finished", outcome: "signups_disabled",
        });
        await pending.fail("New sign-ups are currently disabled on this deployment.");
        return;
      }
      // For Cloudflare, signing in also links the account for AI Gateway billing: startGatekeeperLogin
      // requested full (non-transient) scopes, so persist the grant as a connected account before
      // handing back the session. Other providers use minimal, transient sign-in grants (no persist).
      if (this.ctx.props.vendorId === CLOUDFLARE_VENDOR_ID) {
        const accountId = await userStub.linkConnectedAccountFromLogin(
            account, this.ctx.props.vendorId, expiresAt);
        await pending.link(userStub.id.toString(), accountId);
      }
      // Session tokens are "<doName>:<secret>"; PublicApi.authenticate() routes via idFromName of
      // the first part. The user DO is keyed by email, so the prefix must be the email.
      await pending.deliver(`${email}:${secret}`, ticketHash);
      loginLogger.info("gatekeeper login finished", {
        event: "gatekeeper.login.finished", outcome: "ok",
      });
    } catch (err) {
      loginLogger.error("gatekeeper login failed", {
        event: "gatekeeper.login.failed", error: err,
      });
      loginLogger.info("gatekeeper login finished", {
        event: "gatekeeper.login.finished", outcome: "error",
      });
      await pending.fail("Sign-in failed. Please try again.");
    }
  }

  // The user DO and account id a sign-in linked (Cloudflare), or null for a transient sign-in
  // grant, which persists nothing there is to update.
  async #linked(): Promise<{ user: DurableObjectStub<UserDurableObject>; accountId: number } | null> {
    const link = await this.#pending().getLink();
    if (!link) return null;
    const id = this.ctx.exports.UserDurableObject.idFromString(link.userId);
    return { user: this.ctx.exports.UserDurableObject.get(id), accountId: link.accountId };
  }

  async credentialsExpired(): Promise<void> {
    const linked = await this.#linked();
    if (linked) await linked.user.markCredentialsExpired(linked.accountId);
  }

  async credentialsRestored(expiresAt?: Date): Promise<void> {
    const linked = await this.#linked();
    if (linked) await linked.user.markCredentialsRestored(linked.accountId, expiresAt);
  }

  async reconnectComplete(stageId: string, expiresAt?: Date): Promise<ConnectHandoff> {
    const linked = await this.#linked();
    if (!linked) throw new Error("Sign-in flows cannot be reconnected.");
    return linked.user.stagePendingRestore(linked.accountId, stageId, expiresAt);
  }
}
