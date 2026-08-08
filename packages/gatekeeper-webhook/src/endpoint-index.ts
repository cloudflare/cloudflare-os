import { DurableObject } from "cloudflare:workers";

// One Durable Object per endpoint ID, named by that ID. Its only job is to answer "which account
// owns this endpoint?" for the public receiver, which sees nothing but the URL.
//
// This indirection is what lets an endpoint URL carry no account identity: two endpoints handed to
// two different third parties are uncorrelated, even when the same account owns both. Everything
// else about an endpoint — its token hash, its hook capability, its delivery queue — lives in the
// account's EndpointRegistry.

type IndexRecord = {
  version: 1;
  accountId: string;
};

const RECORD_KEY = "record";

export class EndpointIndex extends DurableObject {
  /** Claims this endpoint ID for an account. IDs are 128-bit random, so a collision is a bug. */
  async claim(accountId: string): Promise<void> {
    const existing = this.ctx.storage.kv.get<IndexRecord>(RECORD_KEY);
    if (existing && existing.accountId !== accountId) {
      throw new Error("Endpoint ID is already claimed.");
    }
    this.ctx.storage.kv.put<IndexRecord>(RECORD_KEY, { version: 1, accountId });
  }

  /** Resolves the owning account, or null once the endpoint has been revoked. */
  async resolve(): Promise<string | null> {
    return this.ctx.storage.kv.get<IndexRecord>(RECORD_KEY)?.accountId ?? null;
  }

  /** Releases the ID so the public URL stops resolving. */
  async release(): Promise<void> {
    this.ctx.storage.kv.delete(RECORD_KEY);
  }
}
