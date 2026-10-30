// `cf-os api types [<service>]`: the API as TypeScript declarations, for a coding agent to write code
// against rather than walk commands. They are cloudflare-os's own agent declarations
// (packages/api-schema/generated/workshop-api.agent.d.ts and its fragments), what a holder of an
// `AuthenticatedApi` stub can call, read from the copy `pnpm api-schema:generate` writes beside the
// command table (generated/agent-types.ts), so it connects to nothing. The commands are their
// methods in kebab-case.

import { declarations, fragments } from "../generated/agent-types.ts";
import { UsageError } from "./output.ts";

/** The declarations to print: the whole file, or the fragment of one `service`. */
export function agentTypes(service?: string, agent = { declarations, fragments }): string {
  if (service === undefined) return agent.declarations;
  if (!Object.hasOwn(agent.fragments, service)) {
    throw new UsageError(`No service "${service}" in the API's declarations. The services: ${Object.keys(agent.fragments).join(", ")}.`);
  }
  return agent.fragments[service];
}

/** Help for `cf-os api types`. */
export function typesHelp(): string {
  return [
    "Usage: cf-os api types [<service>]",
    "",
    "The API as TypeScript declarations on stdout, as plain text: everything a signed-in session",
    "(AuthenticatedApi) can call, without the credential methods, or with a service name that",
    "service's declarations alone, other services referred to by name. They are cloudflare-os's own",
    "agent declarations (packages/api-schema/generated/workshop-api.agent.d.ts and its fragments),",
    "copied beside the command table by `pnpm api-schema:generate`, for writing code against the API;",
    "the commands are their methods in kebab-case. It connects to nothing.",
    "",
    `Services: ${Object.keys(fragments).join(", ")}.`,
  ].join("\n");
}
