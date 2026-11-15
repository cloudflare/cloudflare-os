/**
 * The branch harness (`./testing`) against a kit-based gatekeeper reached as the Workshop reaches
 * one, over RPC: every case passes for one built as the kit says, and the harness refuses one
 * whose reads cross branches.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RpcStub } from "cloudflare:workers";
import { branchHarnessCases, runBranchHarness, type BranchHarnessSubject } from "../../src/testing";
import type { BranchGatekeeper, MarkerSession } from "./branch-gatekeeper";

type Session = RpcStub<MarkerSession>;

function subject(name: string): BranchHarnessSubject<Session> {
  const facet: DurableObjectStub<BranchGatekeeper> = env.BRANCH_GATEKEEPER.getByName(name);
  return {
    // The stub's parameter type is the queue's unwrapped shape, which a generic method keeps a
    // stub from matching; the value is the stub the Workshop would pass.
    startSession: async (queue, branch) =>
      await facet.startSession(queue as never, branch) as unknown as Session,
    applyActions: (branch, actions, cache) => facet.applyActions(branch, actions, cache),
    submit: (session, marker) => session.write(marker),
    reads: (session, marker) => session.read(marker),
  };
}

describe("the branch harness", () => {
  for (const harnessCase of branchHarnessCases(subject("kit-built"))) {
    it(harnessCase.name, () => harnessCase.run());
  }

  it("refuses a gatekeeper whose reads cross branches", async () => {
    await expect(runBranchHarness(subject("leaky"))).rejects.toThrow(
      /two branches do not see each other's pending actions.*A session on another branch sees/);
  });
});
