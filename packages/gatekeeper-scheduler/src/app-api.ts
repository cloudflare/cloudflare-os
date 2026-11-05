// The interface of this gatekeeper's management app `ui`, the capability getGatekeeperApp("scheduler")
// returns. `pnpm cf-os api` types `get-gatekeeper-app scheduler ui ...` by it: its generator
// (packages/api-schema/scripts/generate.ts) reads every gatekeeper's `src/app-api.ts` for `AppApi`.
export type { ScheduleManagementApi as AppApi } from "./management-types.js";
