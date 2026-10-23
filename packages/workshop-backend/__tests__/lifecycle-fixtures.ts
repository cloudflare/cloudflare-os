import type { OverseerDurableObject } from "../src/overseer";
import type { TestLifecycleGatekeeper, TestLifecycleParticipant } from "./test-worker";

/** The production Cloudflare.Exports omits test-only worker exports. */
export function lifecycleExports(impl: OverseerDurableObject["impl"]) {
  return impl.ctx.exports as typeof impl.ctx.exports & {
    TestLifecycleGatekeeper(options: {props: object}): DurableObjectClass<TestLifecycleGatekeeper>;
    TestLifecycleParticipant(options: {props: {name: string}}): Fetcher<TestLifecycleParticipant>;
  };
}
