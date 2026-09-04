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
 */

import { OAUTH_NONCE_LIFETIME_MS } from "./connect-nonce";
import type { KvMutable } from "./kv";

/** KV key holding the staged credentials. */
export const STAGED_CREDENTIALS_KEY = "stagedCredentials";

type StagedCredentials<T> = { creds: T; expiresAt: number };

/**
 * Stages credentials for a later `commitStagedCredentials`, replacing any earlier stage.
 * @param kv Durable Object storage.
 * @param creds Whatever the connector needs to write its live keys on commit.
 * @param now Current Unix time in milliseconds.
 * @param ttlMs How long the stage stays committable; the Workshop redeems well within the default.
 *
 * @example
 * ```ts
 * stageCredentials(this.ctx.storage.kv, { accessToken, scopes }, Date.now());
 * return callback.reconnectComplete();
 * ```
 */
export function stageCredentials<T>(
  kv: KvMutable,
  creds: T,
  now: number,
  ttlMs: number = OAUTH_NONCE_LIFETIME_MS,
): void {
  kv.put<StagedCredentials<T>>(STAGED_CREDENTIALS_KEY, { creds, expiresAt: now + ttlMs });
}

/**
 * Reads the staged credentials without consuming them, for a connector that must *use* them once
 * before commit — an MCP account re-probes the server with the tokens it just obtained. Every other
 * reader waits for `commitStagedCredentials`.
 * @param kv Durable Object storage.
 * @param now Current Unix time in milliseconds.
 * @returns The staged credentials, or `null` when nothing live is staged.
 */
export function peekStagedCredentials<T>(kv: KvMutable, now: number): T | null {
  const staged = kv.get<StagedCredentials<T>>(STAGED_CREDENTIALS_KEY);
  if (staged === undefined || !Number.isFinite(staged.expiresAt) || !Number.isFinite(now) ||
      now >= staged.expiresAt) {
    return null;
  }
  return staged.creds;
}

/**
 * Takes the staged credentials, if any are still live. The stage is deleted either way, so a commit
 * happens at most once and an expired stage is discarded rather than left for a later caller.
 * @param kv Durable Object storage.
 * @param now Current Unix time in milliseconds.
 * @returns The staged credentials, or `null` when nothing live was staged.
 *
 * @example
 * ```ts
 * const staged = commitStagedCredentials<Grant>(this.ctx.storage.kv, Date.now());
 * if (!staged) throw new Error("Nothing to commit.");
 * this.ctx.storage.kv.put("accessToken", staged.accessToken);
 * ```
 */
export function commitStagedCredentials<T>(kv: KvMutable, now: number): T | null {
  const staged = kv.get<StagedCredentials<T>>(STAGED_CREDENTIALS_KEY);
  if (staged === undefined) return null;
  kv.delete(STAGED_CREDENTIALS_KEY);
  if (!Number.isFinite(staged.expiresAt) || !Number.isFinite(now) || now >= staged.expiresAt) {
    return null;
  }
  return staged.creds;
}
