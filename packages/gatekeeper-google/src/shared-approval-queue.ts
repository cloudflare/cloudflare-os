// The approval-queue plumbing shared by the gatekeepers whose sessions hand out long-lived
// capabilities (Gmail, Chat).
//
// A message or draft capability can outlive the session that produced it, so the session's
// approval-queue stub is reference-counted rather than owned by whichever object happened to be
// created first: every capability retains it on construction and releases it on dispose, and the
// stub itself is disposed when the last holder goes away.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  ActionDescription, ApprovalQueue, Cursor, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { Pager } from "./cursor";

export class SharedApprovalQueue {
  #stub: RpcStub<ApprovalQueue>;
  // Nothing owns the stub until the first capability is constructed; the session itself is just
  // the first of those. Starting at one would leave the count permanently above zero.
  #references = 0;

  constructor(stub: RpcStub<ApprovalQueue>) {
    this.#stub = stub;
  }

  retain(): () => void {
    this.#references++;
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      if (--this.#references === 0) this.#stub[Symbol.dispose]();
    };
  }

  authorizeObservation(description: ObservationDescription): Promise<void> {
    return this.#stub.authorizeObservation(description);
  }

  submitAction(actionId: number, description: ActionDescription): Promise<void> {
    return this.#stub.submitAction(actionId, description);
  }
}

/** An RPC capability that holds one reference to the shared approval queue until disposed. */
export class ApprovalQueueRpcTarget extends RpcTarget {
  #release: () => void;

  constructor(approvalQueue: SharedApprovalQueue) {
    super();
    this.#release = approvalQueue.retain();
  }

  [Symbol.dispose](): void {
    this.#release();
  }
}

/** The one-method `RpcTarget` that carries a `CursorPager` across the wire. */
@validateRpc()
export class RpcCursor<Entry> extends ApprovalQueueRpcTarget implements Cursor<Entry> {
  #pager: Pager<Entry>;

  constructor(pager: Pager<Entry>, approvalQueue: SharedApprovalQueue) {
    super(approvalQueue);
    this.#pager = pager;
  }

  /** `next()` takes no arguments, so there is no argument surface to validate. */
  @skipRpcValidation()
  next(): Promise<Entry[] | null> {
    return this.#pager.next();
  }
}
