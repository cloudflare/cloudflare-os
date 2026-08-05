import type { GatekeeperDeployment } from "../Gatekeeper.ts";

/** Configuration for the scheduler gatekeeper. */
export interface SchedulerConfig {
  /** Set `false` to opt out of this default-enabled gatekeeper. */
  enabled?: boolean;
}

/**
 * Deploy the scheduled-tasks gatekeeper (ambient, core) as its own Worker,
 * wired into the OS (`GATEKEEPER_SCHEDULER` bindings +
 * `/gatekeeper/scheduler` route). Deploys by default; disable with
 * `Scheduler({ enabled: false })`. The entry, compat flags, and Durable
 * Objects derive from the package's `wrangler.jsonc` at deploy time.
 */
export const Scheduler = (
  config: SchedulerConfig = {},
): GatekeeperDeployment => ({
  name: "scheduler",
  package: "@gadgets/gatekeeper-scheduler",
  prebuild: "build:app",
  defaultEnabled: true,
  enabled: config.enabled,
});

export default Scheduler;
