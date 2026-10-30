// Where each capability of the command table is reached from: the command line that gets there, a
// property of a command's result among its hops. `cf-os api search` uses nodePrefixes to print whole
// command lines, and PUBLIC_SEGMENT is also the word the generator reserves on the root. Pure: no
// `node:` imports, so the generator can import it.

import type { ApiArg, ApiCommand, ApiTable } from "./table.ts";

/** The segment selecting the public node. */
export const PUBLIC_SEGMENT = "public";

/** The positional (required, token-taking) arguments of `command`, in order. */
export function positionalArgs(command: ApiCommand): ApiArg[] {
  return command.args.filter((arg) => !arg.flag && arg.encoding !== "callback" && arg.encoding !== "function");
}

/**
 * The command line, from after `cf-os api`, that reaches each node of `table`, by node: each hop's
 * command, then a `<name>` placeholder for each of its positionals, then, for a capability held in
 * a property of its result, that property. A gatekeeper app UI's node, typed by an argument
 * (ApiCapabilityProperty.byArgument), is reached with that argument's value in its placeholder's
 * place (`get-gatekeeper-app context ui`). The line is the shortest from the root (or `public`),
 * preferring hops that get or open an existing capability (`open-workspace`) over ones that create
 * one (`new-workspace`), and a command's own result over a capability held in a property of one
 * (`start-gatekeeper-login <vendorId> attempt`), which takes a segment more. The root's is empty;
 * the public node's is `public`. Nodes are in the order reached.
 */
export function nodePrefixes(table: ApiTable): Map<string, string[]> {
  const prefixes = new Map<string, string[]>([[table.root, []], [table.public, [PUBLIC_SEGMENT]]]);
  const queue = [table.root, table.public];
  const reach = (node: string, segments: string[]) => {
    if (prefixes.has(node)) return;
    prefixes.set(node, segments);
    queue.push(node);
  };
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    const prefix = prefixes.get(node)!;
    const hops = Object.entries(table.nodes[node]!.commands)
      .toSorted(([a], [b]) => hopRank(a) - hopRank(b) || compare(a, b));
    /** The hop's command and its positionals, those `fixed` holds, by argument index, as its values. */
    const hop = (name: string, command: ApiCommand, fixed: Record<number, string> = {}) =>
      [...prefix, name, ...positionalArgs(command).map((arg) => fixed[arg.index] ?? `<${arg.name}>`)];
    for (const [name, command] of hops) {
      if (command.returns.kind === "stub") reach(command.returns.node, hop(name, command));
    }
    for (const [name, command] of hops) {
      if (command.returns.kind !== "value") continue;
      for (const [property, capability] of Object.entries(command.returns.capabilities ?? {})) {
        if (capability.returns.kind === "stub") reach(capability.returns.node, [...hop(name, command), property]);
        const { index, nodes } = capability.byArgument ?? { index: -1, nodes: {} };
        for (const [value, typed] of Object.entries(nodes)) reach(typed, [...hop(name, command, { [index]: value }), property]);
      }
    }
  }
  return new Map(queue.map((node) => [node, prefixes.get(node)!]));
}

/** Hops that get or open an existing capability first. */
function hopRank(command: string): number {
  return /^(get|open)-/.test(command) ? 0 : 1;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
