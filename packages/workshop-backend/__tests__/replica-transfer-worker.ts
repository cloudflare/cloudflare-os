import {DurableObject, RpcTarget, restore, type RpcStub} from "cloudflare:workers";
import type {ReplicableWorktree, WorktreeSubscriber, WorktreeSubscription, WorktreeSyncSession, FileChangeByPath}
  from "@gadgets/workshop-shared/worktree-replica";
import {demuxGitFetchResponse, buildGitFetchRequest} from "@gadgets/gatekeeper-kit/git-transport";
import {decodePackStream, type PackableObject} from "../src/git-codec";

/** Persistent test receiver in a distinct Worker: no test-pool closures are stored in production. */
export class TestReplicaTransfer extends DurableObject {
  [restore](_params: unknown) { return new ReplicaSubscriberEndpoint(this); }
  async subscriber(): Promise<RpcStub<WorktreeSubscriber>> { return this.ctx.restore({type: "subscriber"}); }
  async receive(event: {kind: string; revision: string; head?: string | null; batchId?: string; changes?: FileChangeByPath[]}) {
    if (this.ctx.storage.kv.get("fail")) throw new Error("Injected callback failure");
    this.ctx.storage.kv.put("attempts", (this.ctx.storage.kv.get<number>("attempts") ?? 0) + 1);
    if (this.ctx.storage.kv.get("hold") === event.kind) {
      this.ctx.storage.kv.put("blocked", true);
      while (this.ctx.storage.kv.get("hold") === event.kind) await scheduler.wait(1);
      this.ctx.storage.kv.put("blocked", false);
    }
    const events = this.ctx.storage.kv.get<typeof event[]>("events") ?? [];
    // Idempotent ACK handling, including a producer reset after application but before receipt.
    if (!events.some(prior => JSON.stringify(prior) === JSON.stringify(event))) events.push(event);
    this.ctx.storage.kv.put("events", events);
    if (this.ctx.storage.kv.get("lose-ack")) {
      this.ctx.storage.kv.delete("lose-ack");
      throw new Error("Injected lost ACK after application");
    }
  }
  async hold(kind: string | null) { this.ctx.storage.kv.put("hold", kind); }
  async blocked() { return this.ctx.storage.kv.get<boolean>("blocked") ?? false; }
  async attempts() { return this.ctx.storage.kv.get<number>("attempts") ?? 0; }
  async loseAck() { this.ctx.storage.kv.put("lose-ack", true); }
  async events() { return this.ctx.storage.kv.get<unknown[]>("events") ?? []; }
  async fail(enabled: boolean) { this.ctx.storage.kv.put("fail", enabled); }
  async save(session: RpcStub<WorktreeSyncSession>) { this.ctx.storage.kv.put("session", session); }
  async listen(session: RpcStub<WorktreeSyncSession>) {
    using subscriber = await this.subscriber();
    using subscription = await session.subscribe(subscriber);
    this.ctx.storage.kv.put("subscription", subscription);
  }
  async stop() {
    using subscription = this.ctx.storage.kv.get<RpcStub<WorktreeSubscription>>("subscription");
    await subscription?.unsubscribe();
    this.ctx.storage.kv.delete("subscription");
  }
  async submit(id: string, revision: string, changes: FileChangeByPath[]) {
    return this.ctx.storage.kv.get<RpcStub<WorktreeSyncSession>>("session")!.submitChanges(id, revision, changes);
  }
  async mount(worktree: RpcStub<ReplicableWorktree>) {
    using session = await worktree.getSyncSession();
    using subscriber = await this.subscriber();
    using subscription = await session.subscribe(subscriber);
    await subscription.unsubscribe();
    return this.events();
  }
  async transfer(worktree: RpcStub<ReplicableWorktree>, head: string, haves?: string[]) {
    const response = await worktree.gitPull(new Request("https://git.invalid/git-upload-pack", {
      method: "POST", headers: {"git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request"},
      body: buildGitFetchRequest([head], {type: "commit", commitHistory: {kind: "full"}, haves}),
    }));
    const objects = [];
    const bases = new Map<string, PackableObject>();
    for await (const object of decodePackStream(demuxGitFetchResponse(response.body!),
      {maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024, resolveBase: oid => bases.get(oid)})) {
      bases.set(object.oid, object);
      objects.push({oid: object.oid, type: object.type, binary: object.payload.includes(0)});
    }
    return objects;
  }
}

/** The real persistable callback capability, minted inside its owning worker. */
class ReplicaSubscriberEndpoint extends RpcTarget implements WorktreeSubscriber {
  constructor(private target: TestReplicaTransfer) { super(); }
  async setBaseCommit(state: {revision: string; base: string | null; head: string | null; shallowCommit: string | null}) {
    await this.target.receive({kind: "base", ...state});
  }
  async change(revision: string, batchId: string, changes: FileChangeByPath[]) {
    await this.target.receive({kind: "change", revision, batchId, changes});
  }
}
