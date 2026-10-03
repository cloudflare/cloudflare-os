import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// This repository is public, and every consumer of it — forks, CI, external contributors — can
// only reach registry.npmjs.org, so every dependency has to resolve from there.
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const npmrc = readFileSync(new URL("../.npmrc", import.meta.url), "utf8");

describe("registry policy", () => {
  it("resolves every lockfile tarball from the public npm registry", () => {
    const offenders = lockfile
      .split("\n")
      .filter((line) => /tarball: (?!https:\/\/registry\.npmjs\.org\/)/.test(line))
      .map((line) => line.trim());

    assert.deepEqual(
      offenders,
      [],
      `pnpm-lock.yaml resolves packages from a registry other than ${PUBLIC_REGISTRY}, which ` +
        "forks, CI and external contributors cannot reach. Re-run the install with the " +
        "repository's root .npmrc in effect rather than under a config that points a scope " +
        "somewhere private.",
    );
  });

  it("configures the @cloudflare scope, and nothing else, in the root .npmrc", () => {
    const directives = npmrc
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    assert.deepEqual(
      directives,
      [`@cloudflare:registry=${PUBLIC_REGISTRY}`],
      "the root .npmrc must contain exactly the @cloudflare scope pin; it is what keeps a " +
        "resolving install from rewriting pnpm-lock.yaml to a registry this repository's " +
        "consumers cannot reach.",
    );
  });
});
