// Runs upstream's configurator compiler, whichever layout this package is checked out in.
//
// In the cloudflare-os repo the script is a sibling at ../../scripts/. In a deployment repo that
// vendors cloudflare-os as a submodule, this package sits outside it and the script is instead at
// ../../cloudflare-os/scripts/. Resolving both keeps one package.json working in either place.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(fileURLToPath(import.meta.url), "..");
const candidates = [
  resolve(packageDirectory, "../../scripts/build-gatekeeper-configurator.mjs"),
  resolve(packageDirectory, "../../cloudflare-os/scripts/build-gatekeeper-configurator.mjs"),
];

const script = candidates.find((candidate) => existsSync(candidate));
if (!script) {
  throw new Error(
    `Could not find build-gatekeeper-configurator.mjs. Looked in:\n  ${candidates.join("\n  ")}`,
  );
}

execFileSync(process.execPath, [script, packageDirectory, ...process.argv.slice(2)], {
  cwd: packageDirectory,
  stdio: "inherit",
});
