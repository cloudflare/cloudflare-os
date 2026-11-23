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
    stageActions: (branch, actions) => facet.stageActions(branch, actions),
    offersCreation: true,
    submit: (session, marker) => session.write(marker),
    reads: (session, marker) => session.read(marker),
  };
}

describe("the branch harness", () => {
  for (const harnessCase of branchHarnessCases(subject("kit-built"))) {
    it(harnessCase.name, () => harnessCase.run());
  }

  it("refuses a gatekeeper that offers creation without stageActions()", async () => {
    const { stageActions: _, ...without } = subject("unstaged");
    await expect(runBranchHarness(without)).rejects.toThrow(/must implement stageActions/);
  });

  it("refuses a gatekeeper that applies more than it was given", async () => {
    // Applies every action up to the last one named, and reports only those named.
    const honest = subject("over-applying");
    const overApplying: BranchHarnessSubject<Session> = {
      ...honest,
      applyActions: async (branch, actions, cache) => {
        const all = Array.from({ length: Math.max(...actions) }, (_, i) => i + 1);
        const result = await honest.applyActions(branch, all, cache);
        return { ...result, applied: result.applied.filter(id => actions.includes(id)) };
      },
    };
    await expect(runBranchHarness(overApplying)).rejects.toThrow(
      /After another branch applied, a session outside any chat sees/);
  });

  it("refuses a gatekeeper whose reads cross branches", async () => {
    await expect(runBranchHarness(subject("leaky"))).rejects.toThrow(
      /two branches do not see each other's pending actions.*A session on another branch sees/);
  });
});
