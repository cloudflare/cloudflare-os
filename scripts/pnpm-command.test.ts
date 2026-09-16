import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pnpmCommand } from "./pnpm-command.ts";

// Real `npm_execpath` values, as measured on Windows: pnpm installed through npm, pnpm installed
// standalone, and -- the case the guard exists for -- the same variable under `npm run`.
const PNPM_MJS = "C:\\nvm4w\\nodejs\\node_modules\\pnpm\\bin\\pnpm.mjs";
const PNPM_CJS = "C:\\Users\\dev\\AppData\\Local\\pnpm\\bin\\pnpm.cjs";
const NPM_CLI = "C:\\Users\\dev\\AppData\\Local\\nvm\\node_modules\\npm\\bin\\npm-cli.js";

describe("pnpmCommand", () => {
  it("runs pnpm's own entry point through node on Windows", () => {
    const [command, args] = pnpmCommand(["install"], { npm_execpath: PNPM_MJS }, "win32");
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [PNPM_MJS, "install"]);
  });

  it("recognises a .cjs entry as well as .mjs", () => {
    const [command, args] = pnpmCommand(["install"], { npm_execpath: PNPM_CJS }, "win32");
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [PNPM_CJS, "install"]);
  });

  // The reason `shell: true` was not an option: a shell would split this argument in two.
  it("passes arguments through untouched, including one containing a space", () => {
    const configPath = "C:\\Users\\Some Name\\cloudflare-os\\wrangler.jsonc";
    const [, args] = pnpmCommand(
        ["exec", "wrangler", "dev", "-c", configPath], { npm_execpath: PNPM_MJS }, "win32");
    assert.deepEqual(args, [PNPM_MJS, "exec", "wrangler", "dev", "-c", configPath]);
  });

  // Substituting this unchecked would run `npm install` against a pnpm workspace.
  it("rejects npm's CLI rather than using the wrong package manager", () => {
    assert.deepEqual(
        pnpmCommand(["install"], { npm_execpath: NPM_CLI }, "win32"), ["pnpm", ["install"]]);
  });

  // A direct `node scripts/run-local.ts` has no pnpm ancestor to inherit the variable from. Nothing
  // can be substituted, so the call keeps whatever behaviour it has today.
  it("falls back to bare pnpm when npm_execpath is absent or empty", () => {
    assert.deepEqual(pnpmCommand(["install"], {}, "win32"), ["pnpm", ["install"]]);
    assert.deepEqual(pnpmCommand(["install"], { npm_execpath: "" }, "win32"), ["pnpm", ["install"]]);
  });

  it("leaves other platforms exactly as they were", () => {
    assert.deepEqual(
        pnpmCommand(["install"], { npm_execpath: PNPM_MJS }, "linux"), ["pnpm", ["install"]]);
    assert.deepEqual(
        pnpmCommand(["install"], { npm_execpath: PNPM_MJS }, "darwin"), ["pnpm", ["install"]]);
  });
});
