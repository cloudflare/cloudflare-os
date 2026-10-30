// Where each capability of the command table is reached from: the hops a command line takes to get
// there. `cf-os api search` uses nodePrefixes to print whole command lines, and PUBLIC_SEGMENT is
// also the word the generator reserves on the root. Pure: no `node:` imports, so the generator can
// import it.

import type { ApiTable } from "./table.ts";

/** The segment selecting the public node. */
export const PUBLIC_SEGMENT = "public";

/**
 * The segments that reach each node of `table`, by node: the shortest from the root (or `public`),
 * preferring hops that get or open an existing capability (`open-gadget`) over ones that create one
 * (`new-gadget`). The root's is empty; the public node's is `public`. Nodes are in the order reached.
 */
export function nodePrefixes(table: ApiTable): Map<string, string[]> {
  const prefixes = new Map<string, string[]>([[table.root, []], [table.public, [PUBLIC_SEGMENT]]]);
  const queue = [table.root, table.public];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    const prefix = prefixes.get(node)!;
    const hops = Object.entries(table.nodes[node]!.commands)
      .toSorted(([a], [b]) => hopRank(a) - hopRank(b) || compare(a, b));
    for (const [name, command] of hops) {
      if (command.returns.kind !== "stub" || prefixes.has(command.returns.node)) continue;
      prefixes.set(command.returns.node, [...prefix, name]);
      queue.push(command.returns.node);
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
