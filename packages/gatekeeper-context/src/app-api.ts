// The interface of this gatekeeper's management app `ui`, the capability getGatekeeperApp("context")
// returns. `pnpm cf-os api` types `get-gatekeeper-app context ui ...` by it: its generator
// (packages/api-schema/scripts/generate.ts) reads every gatekeeper's `src/app-api.ts` for `AppApi`.
export type { ContextApi as AppApi } from "./context-types.js";
