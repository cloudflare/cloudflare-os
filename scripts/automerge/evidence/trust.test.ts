import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { asObject, asString, parseJson } from "../proofs/json.ts";
import { maintainers, untrusted, type Author } from "./trust.ts";

// The maintainers the build plan records (Ashish, 2026-11-02), in the `.github/maintainers` format
// the gate parses, and the authors of #966 (a maintainer's branch) and #686 (Dependabot) as the
// pulls API returned them on 2026-11-03.
const DIR = new URL("./testdata/trust/", import.meta.url);
const LISTED = maintainers(readFileSync(new URL("maintainers", DIR), "utf8"));

function author(name: string): Author {
  const pull = asObject(parseJson(readFileSync(new URL(`${name}-author.json`, DIR), "utf8")), name);
  return {
    login: asString(pull.login, "login"), type: asString(pull.type, "type"),
    headRepoId: String(pull.head_repo_id), baseRepoId: String(pull.base_repo_id),
  };
}

describe("untrusted", () => {
  it("trusts #966's maintainer author with write access", () => {
    assert.equal(untrusted(author("pr966"), LISTED, "admin"), undefined);
  });

  it("refuses Dependabot's #686", () => {
    assert.equal(untrusted(author("pr686"), LISTED, "write"), "the author is a Bot, not a person");
  });

  it("refuses a maintainer's pull request from a fork", () => {
    assert.equal(untrusted({ ...author("pr966"), headRepoId: "1" }, LISTED, "admin"), "the head branch is not in this repository");
  });

  it("refuses everyone while the base has no maintainers file, as main does today", () => {
    assert.match(String(untrusted(author("pr966"), maintainers(undefined), "admin")), /not in \.github\/maintainers/);
  });

  it("refuses everyone when one line of the file is malformed", () => {
    assert.equal(maintainers("kentonv\n@ndisidore\n").size, 0);
  });

  it("refuses a listed author who no longer has write access", () => {
    assert.match(String(untrusted(author("pr966"), LISTED, "read")), /has read permission, not write/);
    assert.match(String(untrusted(author("pr966"), LISTED, undefined)), /has no permission/);
  });
});
