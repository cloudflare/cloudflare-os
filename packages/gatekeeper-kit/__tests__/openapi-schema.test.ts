/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenAPIClient } from "../src/http";
import type { IssueInput, IssuesApi } from "./fixtures/openapi-schema/expected/issues.d.ts";
import type { UsersApi } from "./fixtures/openapi-schema/expected/users.d.ts";

const fixture = join(import.meta.dirname, "fixtures", "openapi-schema");
const bin = join(import.meta.dirname, "..", "bin", "openapi-schema.ts");

function generate(spec: string, out: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, spec, "--out", out, ...args], { encoding: "utf8" });
}

function readTree(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path.slice(dir.length + 1), readFileSync(path, "utf8")];
    }));
}

// Runs Forge and, the first time, compiles the plugin with jco, which takes some seconds.
describe("gatekeeper-openapi-schema", { timeout: 120_000 }, () => {
  it("generates the committed fixture output", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      const result = generate(join(fixture, "spec.json"), out, "--group-by", "tag");
      expect(result.status, result.stderr).toBe(0);
      expect(readTree(out)).toEqual(readTree(join(fixture, "expected")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps only the listed operations, and refuses one the document lacks", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      writeFileSync(join(dir, "ops.txt"), "# Users only\nusers/get\n");
      const kept = generate(join(fixture, "spec.json"), out, "--group-by", "tag",
        "--operations", join(dir, "ops.txt"));
      expect(kept.status, kept.stderr).toBe(0);
      expect(Object.keys(readTree(out))).toEqual(["users.d.ts"]);
      expect(readTree(out)["users.d.ts"]).toContain("export type SimpleUser =");

      writeFileSync(join(dir, "ops.txt"), "users/get\nusers/missing\n");
      const missing = generate(join(fixture, "spec.json"), out, "--operations", join(dir, "ops.txt"));
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("the document has no operation users/missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops the header parameters --omit-header names, in any case", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      const result = generate(join(fixture, "spec.json"), out, "--group-by", "tag",
        "--omit-header", "x-request-id");
      expect(result.status, result.stderr).toBe(0);
      const issues = readTree(out)["issues.d.ts"];
      expect(issues).not.toContain("X-Request-Id");
      expect(issues).toContain("body: IssueInput;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the properties --writable names, although the document marks them readOnly", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      const result = generate(join(fixture, "spec.json"), out, "--group-by", "tag", "--writable", "id");
      expect(result.status, result.stderr).toBe(0);
      const index = readTree(out)["index.d.ts"];
      // `id` was SimpleUser's only readOnly field, so it needs no request type of its own.
      expect(index).not.toContain("SimpleUserInput");
      expect(readTree(out)["issues.d.ts"]).toContain("export type IssueInput =");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies a JSON Patch to the document first, and refuses one whose path resolves to nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      writeFileSync(join(dir, "patch.json"), JSON.stringify([
        { op: "add", path: "/components/schemas/reactions/properties/heart", value: { type: "integer" },
          reason: "Tests a reason, which is ignored." },
        { op: "replace", path: "/components/schemas/issue/properties/labels/items", value: { type: "integer" } },
        { op: "remove", path: "/components/schemas/simple-user/properties/name" },
      ]));
      const patched = generate(join(fixture, "spec.json"), out, "--group-by", "tag",
        "--patch", join(dir, "patch.json"));
      expect(patched.status, patched.stderr).toBe(0);
      const tree = readTree(out);
      expect(tree["issues.d.ts"]).toContain("heart?: number;");
      expect(tree["issues.d.ts"]).toContain("labels?: number[];");
      expect(tree["index.d.ts"]).not.toContain("name?:");

      writeFileSync(join(dir, "patch.json"), JSON.stringify([{ op: "remove", path: "/components/schemas/nope" }]));
      const refused = generate(join(fixture, "spec.json"), out, "--patch", join(dir, "patch.json"));
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("nothing at /components/schemas/nope to remove");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to replace an output directory holding a file it did not generate", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      writeFileSync(join(dir, "handwritten.ts"), "export const x = 1;\n");
      const result = generate(join(fixture, "spec.json"), dir, "--group-by", "tag");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("handwritten.ts was not generated");
      expect(readFileSync(join(dir, "handwritten.ts"), "utf8")).toBe("export const x = 1;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Compile-time checks of the generated schemas against the client; never called.
async function typeChecks(owner: string, repo: string) {
  const issues = createOpenAPIClient<IssuesApi>({ baseUrl: "https://api.example.com" });
  const users = createOpenAPIClient<UsersApi>({ baseUrl: "https://api.example.com" });

  const list = await issues.get("/repos/{owner}/{repo}/issues", {
    path: { owner, repo }, query: { state: "open", labels: ["bug"] },
  });
  const number: number | undefined = list[0].number;
  const login: string | undefined = list[0].user?.login;
  const created = await issues.post("/repos/{owner}/{repo}/issues", {
    path: { owner, repo }, headers: { "X-Request-Id": "1" }, body: { title: "Hi" },
  });
  const deleted: undefined = await issues.delete("/repos/{owner}/{repo}/issues/{issue_number}", {
    path: { owner, repo, issue_number: 1 },
  });
  const user = await users.get("/users/{username}", { path: { username: "octocat" } });
  void [number, login, created, deleted, user.id];

  // @ts-expect-error a request leaves out readOnly fields
  const input: IssueInput = { title: "Hi", number: 1 };
  void input;
  // @ts-expect-error the required header is missing
  await issues.post("/repos/{owner}/{repo}/issues", { path: { owner, repo }, body: { title: "Hi" } });
  // @ts-expect-error the upload has a non-JSON body, so it was left out
  await issues.post("/repos/{owner}/{repo}/issues/{issue_number}/attachments");
  // @ts-expect-error the state is an enum
  await issues.get("/repos/{owner}/{repo}/issues", { path: { owner, repo }, query: { state: "all" } });
}
void typeChecks;
