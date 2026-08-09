// Resolve how to invoke pnpm on Windows without a shell.
//
// On Windows, `pnpm` on PATH is a `.cmd` shim. Node refuses to spawn `.cmd`/`.bat` without a
// shell (EINVAL, CVE-2024-27980), and `shell: true` re-splits arguments so absolute paths
// containing spaces break (see cloudflare/cloudflare-os#19).
//
// When the current process was launched by `pnpm run`, `npm_execpath` points at pnpm's JS entry
// (`.cjs` or `.mjs` depending on install). Running `node <execpath> …` keeps argv intact with no
// shell. Under `npm run` the same variable points at npm-cli.js — the guard below rejects that
// so the failure stays loud rather than silently using the wrong package manager.

import { execFileSync, spawnSync } from "node:child_process";

/**
 * Return `[executable, argv]` for spawning pnpm with the given arguments.
 * @param {string[]} args
 * @returns {[string, string[]]}
 */
export function pnpmCommand(args) {
  const execPath = process.env.npm_execpath ?? "";
  if (process.platform === "win32" && /[\\/]pnpm\.[cm]?js$/i.test(execPath)) {
    return [process.execPath, [execPath, ...args]];
  }
  return ["pnpm", args];
}

/** @type {typeof execFileSync} */
export function execPnpm(args, options) {
  const [file, argv] = pnpmCommand(args);
  return execFileSync(file, argv, options);
}

/** @type {typeof spawnSync} */
export function spawnPnpmSync(args, options) {
  const [file, argv] = pnpmCommand(args);
  return spawnSync(file, argv, options);
}
