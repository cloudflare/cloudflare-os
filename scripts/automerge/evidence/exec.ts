// Runs the commands an evidence producer measures. Unlike a thrown error, a command that exits
// non-zero is a result here: its exit code and the end of its output go into the artifact.

import { spawnSync } from "node:child_process";

/** How much of a failing command's output an artifact keeps. */
const TAIL_CHARS = 4_000;

/** What a command did. */
export interface CommandResult {
  ok: boolean;
  /** The exit code, or null when a signal ended it. */
  code: number | null;
  seconds: number;
  /** The last part of stdout and stderr together. */
  tail: string;
  /** All of stdout, for commands whose output is data. */
  stdout: string;
}

/**
 * Runs `command` in `cwd`, echoing its output to this process's log, and returns what happened.
 * Throws only when the command could not be started.
 */
export function runCommand(command: string, args: string[], cwd: string): CommandResult {
  console.log(`running in ${cwd}: ${command} ${args.join(" ")}`);
  const started = performance.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  process.stdout.write(output);
  return {
    ok: result.status === 0,
    code: result.status,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    tail: output.slice(-TAIL_CHARS),
    stdout: result.stdout,
  };
}
