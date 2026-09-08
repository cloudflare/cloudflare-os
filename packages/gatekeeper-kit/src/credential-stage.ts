/**
 * Escrow for credentials a reconnect / ensureResources flow obtained but the Workshop has not yet
 * confirmed came from the account's owner (see `GatekeeperUser.reconnect` in workshop-shared).
 *
 * A reconnect URL is a bearer capability, and gadgets bound to the account read its live credentials
 * straight from the gatekeeper, so a flow that wrote its result live would hand those gadgets a
 * phished victim's tokens with nothing in the way. Instead the flow stages them here and reports
 * `reconnectComplete()`; only `GatekeeperUser.commitReconnect()`, called once the Workshop has
 * verified the completing browser, moves them to the live keys. Nothing else reads this key: staged
 * credentials are unusable until committed, and the next stage overwrites them.
 *
 * Every stage carries a random `stageId`, which the flow passes to `reconnectComplete()` so the
 * Workshop's ticket names the exact credentials whose completion minted it. Two reconnects can
 * overlap — the owner's and one a phished victim finished — and a commit that took "whatever is
 * staged" would let the ticket from the first activate the second's credentials.
 */

import { generateNonce, OAUTH_NONCE_LIFETIME_MS } from "./connect-nonce";
import type { KvMutable } from "./kv";

/** KV key holding the staged credentials. */
export const STAGED_CREDENTIALS_KEY = "stagedCredentials";

type StagedCredentials<T> = { creds: T; stageId: string; expiresAt: number };

/** A stage's credentials together with the id a commit must name to take them. */
export type StagedCredentialsView<T> = { creds: T; stageId: string };

/**
 * Stages credentials for a later `commitStagedCredentials`, replacing any earlier stage.
 * @param kv Durable Object storage.
 * @param creds Whatever the connector needs to write its live keys on commit.
 * @param now Current Unix time in milliseconds.
 * @param ttlMs How long the stage stays committable; the Workshop redeems well within the default.
 * @returns The new stage's id, to pass to `GatekeeperConnectCallback.reconnectComplete()`.
 *
 * @example
 * ```ts
 * const stageId = stageCredentials(this.ctx.storage.kv, { accessToken, scopes }, Date.now());
 * return callback.reconnectComplete(stageId);
 * ```
 */
export function stageCredentials<T>(
  kv: KvMutable,
  creds: T,
  now: number,
  ttlMs: number = OAUTH_NONCE_LIFETIME_MS,
): string {
  const stageId = generateNonce();
  kv.put<StagedCredentials<T>>(STAGED_CREDENTIALS_KEY, { creds, stageId, expiresAt: now + ttlMs });
  return stageId;
}

// The stage as stored, or `undefined` when there is none or it is unusable (expired, corrupt, or
// read with a non-finite clock).
function liveStage<T>(kv: KvMutable, now: number): StagedCredentials<T> | undefined {
  const staged = kv.get<StagedCredentials<T>>(STAGED_CREDENTIALS_KEY);
  if (staged === undefined || typeof staged.stageId !== "string" ||
      !Number.isFinite(staged.expiresAt) || !Number.isFinite(now) || now >= staged.expiresAt) {
    return undefined;
  }
  return staged;
}

/**
 * Reads the staged credentials without consuming them, for a connector that must *use* them once
 * before commit — an MCP account re-probes the server with the tokens it just obtained — or that
 * needs the id of a stage it wrote earlier in the same flow. Every other reader waits for
 * `commitStagedCredentials`.
 * @param kv Durable Object storage.
 * @param now Current Unix time in milliseconds.
 * @returns The staged credentials and their stage id, or `null` when nothing live is staged.
 */
export function peekStagedCredentials<T>(kv: KvMutable, now: number): StagedCredentialsView<T> | null {
  const staged = liveStage<T>(kv, now);
  return staged ? { creds: staged.creds, stageId: staged.stageId } : null;
}

/**
 * Takes the staged credentials, if the stage named by `stageId` is the current one and still live.
 * A matching stage is deleted, so a commit happens at most once; an expired or unusable stage is
 * deleted too rather than left for a later caller. A stage with a *different* id is left in place
 * and `null` is returned: it belongs to a newer flow, whose own ticket is the only thing that may
 * commit it.
 * @param kv Durable Object storage.
 * @param now Current Unix time in milliseconds.
 * @param stageId The id `stageCredentials` returned for the stage being committed.
 * @returns The staged credentials, or `null` when that stage is not live.
 *
 * @example
 * ```ts
 * const staged = commitStagedCredentials<Grant>(this.ctx.storage.kv, Date.now(), stageId);
 * if (!staged) throw new Error("Nothing to commit.");
 * this.ctx.storage.kv.put("accessToken", staged.accessToken);
 * ```
 */
export function commitStagedCredentials<T>(kv: KvMutable, now: number, stageId: string): T | null {
  const staged = liveStage<T>(kv, now);
  if (staged === undefined) {
    kv.delete(STAGED_CREDENTIALS_KEY);
    return null;
  }
  // Plain comparison: the id is an identity, not a secret. Only the Workshop can reach
  // `commitReconnect`, and it names the id its own record carries.
  if (staged.stageId !== stageId) return null;
  kv.delete(STAGED_CREDENTIALS_KEY);
  return staged.creds;
}

/**
 * Drops the stage, if any, leaving the live credentials alone. For a flow that is abandoning its
 * reconnect — an OAuth client told to invalidate the tokens it holds while one is in progress
 * should forget the staged ones, not the live ones.
 * @param kv Durable Object storage.
 */
export function discardStagedCredentials(kv: KvMutable): void {
  kv.delete(STAGED_CREDENTIALS_KEY);
}
