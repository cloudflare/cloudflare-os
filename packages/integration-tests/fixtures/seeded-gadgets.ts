import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Keep the seeded programs as ordinary JavaScript modules so TypeScript checks their real source
// through each file's @ts-check directive. The tests still need strings because seedGadget writes
// the modules into the workspace's Yjs document.
function readSource(name: string): string {
  return readFileSync(join(HERE, "seeded-gadgets", name), "utf8");
}

/**
 * Stores notes in SQL and deliberately also keeps state in memory, so a test can tell a restart
 * apart from a no-op: rows must survive one and instance/callsSinceStart must not.
 */
export const DURABLE_NOTES_SERVER = readSource("durable-notes.js");

/**
 * A booking gadget written the obvious wrong way: it reads the count, checks capacity, then awaits
 * before inserting. It proves concurrent RPC calls interleave in this environment.
 */
export const OVERSELLING_DESK_SERVER = readSource("overselling-desk.js");

/** A server that loads and answers, paired with a client.js that cannot parse. */
export const VALID_SERVER_ONLY = readSource("valid-server.js");
