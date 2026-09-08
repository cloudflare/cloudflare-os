// Sign-in via authentication gatekeepers.
//
// Unlike the normal connect-account flow (which runs for an already-logged-in user), login happens
// before we know who the user is. The PublicApi starts a gatekeeper connect flow (in "auth" scope
// mode) with a `LoginConnectCallbackImpl` as the callback and a `PendingLogin` DO to bridge the
// result back to the waiting browser:
//
//   1. PublicApi.startGatekeeperLogin(vendorId) creates a PendingLogin DO (keyed by a random DO id),
//      hands the gatekeeper a LoginConnectCallbackImpl, and returns {url, attempt}, where `attempt`
//      is an RpcStub wrapping the DO (so the client awaits via a capability, never a guessable id).
//   2. The browser opens `url` as a popup, keeping itself as the popup's opener.
//   3. When the gatekeeper finishes, it calls LoginConnectCallbackImpl.complete(user). We read the
//      verified email, resolve/create the email-keyed user DO, mint a session, and deliver the token
//      to the PendingLogin DO under the hash of a fresh handoff ticket, which complete() returns for
//      the gatekeeper's final page to post to its opener (see connect-handoff.ts).
//   4. The opener calls `attempt.claim(ticket)`, and the PendingLogin DO releases the token only for
//      a matching ticket.
//
// The sign-in URL is a bearer capability, so step 4 is what binds the session to the browser that
// started the attempt: whoever holds `attempt` but never receives the ticket — an attacker who
// phished a victim into finishing the flow — gets nothing, and the unclaimed token expires.
//
// Sign-in only requests minimal scopes and the gatekeeper grant is transient (it self-destructs
// shortly after we read the email) — so login does NOT create a persistent connected account.
// Capability access (repos, docs, billing) is granted later when the user explicitly connects the
// gatekeeper, which requests the full scopes and persists the connection.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { ConnectHandoff, GatekeeperConnectCallback, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "../observability";
import { CLOUDFLARE_VENDOR_ID } from "../user.js";
import { readAdminConfig } from "../admin-config.js";
import {
  handoffTargetOrigin, hashSecret, newSecretToken, PENDING_HANDOFF_LIFETIME_MS,
} from "../connect-handoff.js";

const logger = createWorkshopLogger("workshop.auth");

type PendingOutcome = { token: string; ticketHash: string } | { error: string };
// `expiresAt` bounds the result absolutely: the alarm wipes it too, but claim() must not depend on
// the alarm having fired on time.
type PendingResult = PendingOutcome & { expiresAt: number };

const RESULT_KEY = "result";
const EXPIRED_MESSAGE = "This sign-in attempt has expired. Please try again.";

/**
 * Bridges a login result from the (separate) OAuth-callback invocation back to the browser that
 * started the attempt. The result is written to storage: the ticket reaches the browser only after
 * deliver() has returned, so claim() always follows it, but nothing keeps this DO in memory across
 * that gap. It lives for PENDING_HANDOFF_LIFETIME_MS at most; an alarm then wipes an unclaimed token.
 */
export class PendingLogin extends DurableObject<Cloudflare.Env> {
  /** Called by LoginConnectCallbackImpl on success, with the hash of the ticket that may claim it. */
  async deliver(token: string, ticketHash: string): Promise<void> {
    await this.#store({ token, ticketHash });
  }

  /** Called by LoginConnectCallbackImpl when the sign-in cannot complete; claim() reports `reason`. */
  async fail(reason: string): Promise<void> {
    await this.#store({ error: reason });
  }

  async #store(result: PendingOutcome): Promise<void> {
    const expiresAt = Date.now() + PENDING_HANDOFF_LIFETIME_MS;
    this.ctx.storage.kv.put<PendingResult>(RESULT_KEY, { ...result, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt);
  }

  /**
   * Release the token to the holder of the matching ticket. Single use: the result is removed before
   * it is checked, so neither a wrong ticket nor a repeat gets a second try.
   */
  async claim(ticket: string): Promise<string> {
    const result = this.ctx.storage.kv.get<PendingResult>(RESULT_KEY);
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    if (!result || Date.now() >= result.expiresAt) throw new Error(EXPIRED_MESSAGE);
    if ("error" in result) throw new Error(result.error);
    if (!/^[0-9a-f]{64}$/.test(ticket) ||
        await hashSecret(Uint8Array.fromHex(ticket)) !== result.ticketHash) {
      throw new Error("This sign-in attempt could not be verified. Please try again.");
    }
    return result.token;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
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
   * handoff whose ticket `LoginAttempt.claim()` must present to receive it.
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
        await userStub.linkConnectedAccountFromLogin(account, this.ctx.props.vendorId, expiresAt);
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

  /**
   * No-ops: for transient sign-in grants there's nothing persisted to update. For the Cloudflare
   * billing connection (persisted on login) these would ideally flip the account's credential flag,
   * but the callback doesn't carry the user/account identity (it's only learned in complete()). The
   * billing path degrades gracefully regardless — getUsableAccessToken() returns null on expiry and
   * the user falls back to the free tier / a reconnect prompt.
   */
  async credentialsExpired(): Promise<void> {}
  async credentialsRestored(_expiresAt?: Date): Promise<void> {}

  /** Sign-in grants are never reconnected: there is no persisted account to restore. */
  async reconnectComplete(_stageId: string, _expiresAt?: Date): Promise<ConnectHandoff> {
    throw new Error("Sign-in flows cannot be reconnected.");
  }
}
