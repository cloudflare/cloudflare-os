import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { changedConfigs, evaluateMigrations } from "./migrations.ts";
import { parseDiff } from "./diff.ts";
import { asArray, asObject, parseJsonc, type JsonObject } from "./json.ts";

// packages/workshop-backend/wrangler.jsonc at both sides of two real commits: #474 appended the
// UserDirectoryDurableObject step, and aca1d4b5c (2025-08-10, before any deployment) rewrote step v0.
const config = (name: string) =>
  readFileSync(new URL(`./testdata/migrations/${name}.wrangler.jsonc`, import.meta.url), "utf8");
const PATH = "packages/workshop-backend/wrangler.jsonc";

describe("proof-migrations", () => {
  it("holds for #474, which appends one new SQLite class", () => {
    const outcome = evaluateMigrations([{ path: PATH, base: config("pr474-base"), head: config("pr474-head") }]);
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
    assert.deepEqual(outcome.details.packages, [{ path: PATH, appended: ["v3"] }]);
    assert.deepEqual(outcome.details.deletes, []);
  });

  it("fails aca1d4b5c, which edited a step already in the base", () => {
    const outcome = evaluateMigrations([{ path: PATH, base: config("aca1d4b5c-base"), head: config("aca1d4b5c-head") }]);
    assert.deepEqual(outcome.details.reasons,
      [`${PATH}: the base migrations are not an exact prefix of the head migrations`]);
  });

  it("fails a deleted config whose base had migrations", () => {
    const outcome = evaluateMigrations([{ path: PATH, base: config("pr474-base"), head: undefined }]);
    assert.equal(outcome.holds, false);
  });

  it("fails and reports a delete, and fails a rename, appended to #474's head", () => {
    const head = config("pr474-head");
    const parsed = asObject(parseJsonc(head), "config");
    const withStep = (step: JsonObject) =>
      JSON.stringify({ ...parsed, migrations: [...asArray(parsed.migrations, "migrations"), step] });
    const deleted = evaluateMigrations([{ path: PATH, base: head, head: withStep({ tag: "v4", deleted_classes: ["PendingLogin"] }) }]);
    assert.deepEqual(deleted.details.deletes, [`${PATH}: PendingLogin`]);
    assert.deepEqual(deleted.details.reasons, [
      `${PATH}: appended step v4 carries deleted_classes; only tag and new_sqlite_classes may be appended`,
      `${PATH}: appended step v4 needs a non-empty new_sqlite_classes list`,
    ]);
    const renamed = evaluateMigrations([{ path: PATH, base: head,
      head: withStep({ tag: "v4", renamed_classes: [{ from: "PendingLogin", to: "Login" }] }) }]);
    assert.equal(renamed.holds, false);
    const reused = evaluateMigrations([{ path: PATH, base: head, head: withStep({ tag: "v3", new_sqlite_classes: ["X"] }) }]);
    assert.deepEqual(reused.details.reasons, [`${PATH}: an appended step needs a new, non-empty tag`]);
  });

  it("holds when no worker config changed", () => {
    assert.equal(evaluateMigrations([]).holds, true);
  });

  it("reads only packages/*/wrangler.jsonc from a diff", () => {
    const files = parseDiff(readFileSync(new URL("./testdata/deps/pr686.diff", import.meta.url), "utf8"));
    assert.deepEqual(changedConfigs(files), []);
  });
});
