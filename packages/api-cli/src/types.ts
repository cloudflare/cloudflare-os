// `cf-os api types [<service>|<vendor>]`: the API as TypeScript declarations, for a coding agent to
// write code against rather than walk commands. They are cloudflare-os's own agent declarations
// (packages/api-schema/generated/workshop-api.agent.d.ts and its fragments), what a holder of an
// `AuthenticatedApi` stub can call, and each gatekeeper app UI's
// (packages/api-schema/generated/gatekeeper-apps/<vendor>.d.ts), read from the copy
// `pnpm api-schema:generate` writes beside the command table (generated/agent-types.ts), so it
// connects to nothing. The commands are their methods in kebab-case.

import { apps, declarations, fragments } from "../generated/agent-types.ts";
import { UsageError } from "./output.ts";

/** The agent declarations: whole, per service, and per gatekeeper app UI by vendor id. */
export interface AgentDeclarations {
  declarations: string;
  fragments: Record<string, string>;
  apps?: Record<string, string>;
}

/**
 * The declarations to print: the whole file, the fragment of one `service`, or, for a gatekeeper's
 * vendor id, its app UI's.
 */
export function agentTypes(service?: string, agent: AgentDeclarations = { declarations, fragments, apps }): string {
  if (service === undefined) return agent.declarations;
  if (Object.hasOwn(agent.fragments, service)) return agent.fragments[service];
  if (agent.apps && Object.hasOwn(agent.apps, service)) return agent.apps[service];
  const vendors = Object.keys(agent.apps ?? {});
  throw new UsageError(`No service "${service}" in the API's declarations. The services: ${Object.keys(agent.fragments).join(", ")}.` +
    (vendors.length ? ` The gatekeeper app UIs, by vendor id: ${vendors.join(", ")}.` : ""));
}

/** Help for `cf-os api types`. */
export function typesHelp(): string {
  return [
    "Usage: cf-os api types [<service>|<vendor>]",
    "",
    "The API as TypeScript declarations on stdout, as plain text: everything a signed-in session",
    "(AuthenticatedApi) can call, without the credential methods, or with a service name that",
    "service's declarations alone, other services referred to by name. They are cloudflare-os's own",
    "agent declarations (packages/api-schema/generated/workshop-api.agent.d.ts and its fragments),",
    "copied beside the command table by `pnpm api-schema:generate`, for writing code against the API;",
    "the commands are their methods in kebab-case. With a gatekeeper's vendor id, the declarations of",
    "its app UI, `get-gatekeeper-app <vendor> ui`: the interface its package.json names",
    "(packages/api-schema/generated/gatekeeper-apps/<vendor>.d.ts). It connects to nothing.",
    "",
    `Services: ${Object.keys(fragments).join(", ")}.`,
    `Gatekeeper app UIs: ${Object.keys(apps).join(", ")}.`,
  ].join("\n");
}
