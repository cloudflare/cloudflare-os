// Where `cf-os api` writes, and the failure that means the command itself must change.
//
// The machine-readable result is JSON on stdout, and everything meant for a person -- progress,
// hints, failures -- goes to stderr, so `pnpm cf-os api ... | jq` works.

/** Where a command writes. */
export interface Output {
  /** The command's result, as JSON on stdout. */
  json(data: unknown): void;
  /** A line for the person running it, on stderr. */
  log(text: string): void;
}

/** The process's own stdout and stderr. */
export function consoleOutput(): Output {
  return {
    json: (data) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`),
    log: (text) => process.stderr.write(`${text}\n`),
  };
}

/**
 * A failure that means the command must change before it is run again. Either nothing was sent (a
 * usage error, a wrong-typed argument or answer, or no instance to call: `CFOS_API_URL_UNAVAILABLE`),
 * or the server asked through a callback for an answer the command did not give (`--answer`), and
 * the CLI refused it. It is printed alone, exit 2.
 */
export class UsageError extends Error {}
