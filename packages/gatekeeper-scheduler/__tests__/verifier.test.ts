/// <reference types="@cloudflare/vitest-plugin/types" />
/// <reference types="../worker-configuration.d.ts" />

import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import type { SchedulerGatekeeper } from "../src/scheduler.js";

// The test config adds a namespace that production reaches only through workspace facets.
const testEnv = env as { SCHEDULER_GATEKEEPER: DurableObjectNamespace<SchedulerGatekeeper> };

it("admits every scheduler observer, including accounts other than the owner's", async () => {
  const worker = createExecutionContext().exports;
  const owner = worker.ScheduleAccount({ props: { accountId: "owner-account" } });
  const collaborator = worker.ScheduleAccount({ props: { accountId: "collaborator-account" } });
  const gatekeeper = testEnv.SCHEDULER_GATEKEEPER.getByName("observer-access");

  await expect(gatekeeper.verifyObserverAccess([
    { id: "owner", verifier: await owner.getVerifier() },
    { id: "collaborator", verifier: await collaborator.getVerifier() },
  ], [])).resolves.toEqual({ allowedObserverIds: ["owner", "collaborator"] });
  await expect(gatekeeper.verifyObserverAccess([], []))
    .resolves.toEqual({ allowedObserverIds: [] });
});
