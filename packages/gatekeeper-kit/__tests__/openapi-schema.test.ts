/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
          reason: "The API returns a heart count." },
        { op: "replace", path: "/components/schemas/issue/properties/labels/items", value: { type: "integer" },
          reason: "Labels are numeric ids." },
        { op: "remove", path: "/components/schemas/simple-user/properties/name", reason: "The API never sends it." },
      ]));
      const patched = generate(join(fixture, "spec.json"), out, "--group-by", "tag",
        "--patch", join(dir, "patch.json"));
      expect(patched.status, patched.stderr).toBe(0);
      const tree = readTree(out);
      expect(tree["issues.d.ts"]).toContain("heart?: number;");
      expect(tree["issues.d.ts"]).toContain("labels?: number[];");
      expect(tree["index.d.ts"]).not.toContain("name?:");

      writeFileSync(join(dir, "patch.json"), JSON.stringify([
        { op: "remove", path: "/components/schemas/nope", reason: "It is not there." },
      ]));
      const refused = generate(join(fixture, "spec.json"), out, "--patch", join(dir, "patch.json"));
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("nothing at /components/schemas/nope to remove");

      writeFileSync(join(dir, "patch.json"), JSON.stringify([
        { op: "remove", path: "/components/schemas/simple-user/properties/name", reason: " " },
      ]));
      const unexplained = generate(join(fixture, "spec.json"), out, "--patch", join(dir, "patch.json"));
      expect(unexplained.status).toBe(1);
      expect(unexplained.stderr).toContain("operation 0 needs a reason");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes one schema of every operation unless asked to group by tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      // Forge reads a group from a dot in an operationId, and makes no method of an aliased operation.
      writeFileSync(join(dir, "patch.json"), JSON.stringify([
        { op: "replace", path: "/paths/~1users~1{username}/get/operationId", value: "users.get",
          reason: "Tests an operationId with a dot." },
        { op: "add", path: "/paths/~1repos~1{owner}~1{repo}~1issues/get/x-forge-aliases",
          value: [{ "x-fern-sdk-group-name": "tickets", "x-fern-sdk-method-name": "list" }],
          reason: "Tests an operation with an alias." },
      ]));
      writeFileSync(join(dir, "ops.txt"), "users.get\nissues/list\nissues/delete\n");
      const result = generate(join(fixture, "spec.json"), out, "--patch", join(dir, "patch.json"),
        "--operations", join(dir, "ops.txt"));
      expect(result.status, result.stderr).toBe(0);
      const tree = readTree(out);
      expect(Object.keys(tree)).toEqual(["index.d.ts"]);
      expect(tree["index.d.ts"]).toContain("export type Api = {");
      for (const path of ["/users/{username}", "/repos/{owner}/{repo}/issues", "/repos/{owner}/{repo}/issues/{issue_number}"]) {
        expect(tree["index.d.ts"]).toContain(`      path: "${path}";`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a listed operation that a schema cannot hold", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      writeFileSync(join(dir, "ops.txt"), "issues/list\nissues/upload\nusers/avatar\n");
      const result = generate(join(fixture, "spec.json"), out, "--operations", join(dir, "ops.txt"));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "issues/upload, POST /repos/{owner}/{repo}/issues/{issue_number}/attachments cannot be in a schema: " +
        "its request body is not JSON (application/octet-stream). Take it out of");
      expect(result.stderr).toContain("users/avatar, GET /users/{username}/avatar cannot be in a schema");
      expect(result.stderr).not.toContain("issues/list");
      expect(readdirSync(dir)).toEqual(["ops.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks the document's SHA-256, which a URL needs", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      const spec = join(fixture, "spec.json");
      const sha256 = createHash("sha256").update(readFileSync(spec)).digest("hex");
      expect(generate(spec, out, "--sha256", sha256.toUpperCase()).status).toBe(0);

      const changed = generate(spec, out, "--sha256", "0".repeat(64));
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain(`has SHA-256 ${sha256}, not ${"0".repeat(64)}`);

      // Refused before any request is made.
      const unpinned = generate("https://example.invalid/openapi.json", out);
      expect(unpinned.status).toBe(1);
      expect(unpinned.stderr).toContain("a URL needs --sha256");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists every operation of the document with --list, and writes nothing", () => {
    const listed = spawnSync(process.execPath, [bin, join(fixture, "spec.json"), "--list"], { encoding: "utf8" });
    expect(listed.status, listed.stderr).toBe(0);
    const lines = listed.stdout.replace(/\n$/, "").split("\n").map(line => line.split("\t"));
    expect(lines.map(([id, method, path, tag]) => [id, method, path, tag])).toEqual([
      ["issues/list", "GET", "/repos/{owner}/{repo}/issues", "issues"],
      ["issues/create", "POST", "/repos/{owner}/{repo}/issues", "issues"],
      ["issues/delete", "DELETE", "/repos/{owner}/{repo}/issues/{issue_number}", "issues"],
      ["issues/upload", "POST", "/repos/{owner}/{repo}/issues/{issue_number}/attachments", "issues"],
      ["users/get", "GET", "/users/{username}", "users"],
      ["users/avatar", "GET", "/users/{username}/avatar", "users"],
    ]);
    expect(lines.every(line => line.length === 5)).toBe(true);

    const both = generate(join(fixture, "spec.json"), join(tmpdir(), "unused"), "--list");
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("usage:");
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
