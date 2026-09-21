// Spawn pnpm from a script without going through a shell.
//
// On Windows the `pnpm` on PATH is a `.cmd` shim. Node spawns processes directly rather than through
// a shell, so there is no extensionless `pnpm` to execute and the call fails with ENOENT. Naming the
// shim explicitly does not help either: since the fix for CVE-2024-27980 Node refuses to spawn
// `.cmd`/`.bat` without a shell and fails with EINVAL instead.
//
// `shell: true` makes the call work but is not safe here. A shell re-splits the command line, and
// the callers pass absolute paths built from the checkout location -- on a checkout whose path
// contains a space (`C:\Users\Some Name\...`) those arguments break apart.
//
// `npm_execpath` is the way out: under `pnpm run` it holds pnpm's own JS entry point, which `node`
// executes directly with no shell, so every argument keeps its exact value. Under `npm run` the same
// variable points at npm's CLI instead, so it is checked before being used -- substituting it
// unchecked would silently run `npm install` against a pnpm workspace.

// pnpm's JS entry, as `npm_execpath` spells it (`.cjs` or `.mjs` depending on how pnpm was
// installed). npm's `npm-cli.js` and the standalone `pnpm.exe`/`pnpm.cmd` shims do not match.
const PNPM_JS_ENTRY = /[\\/]pnpm\.[cm]?js$/i;

/**
 * `[command, args]` for running pnpm with `args`, to hand to `spawn`, `spawnSync` or `execFileSync`.
 *
 * Off Windows, and on Windows whenever the launcher was not pnpm, this is a plain `["pnpm", args]`:
 * an entry path this cannot support keeps today's loud ENOENT rather than quietly reaching for a
 * different package manager.
 *
 * `env` and `platform` are parameters only so the Windows branch stays testable on other platforms.
 */
export function pnpmCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  const execPath = env.npm_execpath ?? "";
  return platform === "win32" && PNPM_JS_ENTRY.test(execPath)
    ? [process.execPath, [execPath, ...args]]
    : ["pnpm", args];
}
