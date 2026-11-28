/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createOpenAPIClient } from "../src/http";
import type { IssueInput, IssuesApi } from "./fixtures/openapi-schema/expected/issues.d.ts";
import type { UsersApi } from "./fixtures/openapi-schema/expected/users.d.ts";

const fixture = join(import.meta.dirname, "fixtures", "openapi-schema");
const bin = join(import.meta.dirname, "..", "bin", "openapi-schema.ts");

function generate(spec: string, out: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, spec, "--out", out, ...args], { encoding: "utf8" });
}

/** An --operations file of these operationIds, with nothing else on a line. */
const listing = (...ids: string[]): string => ids.map(operationId => `${JSON.stringify({ operationId })}\n`).join("");

function readTree(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path.slice(dir.length + 1), readFileSync(path, "utf8")];
    }));
}

// Each case runs the bin, and Forge in it, as a process.
describe("gatekeeper-openapi-schema", { timeout: 30_000 }, () => {
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

  it("keeps only the listed operations, and refuses one the document lacks or a list of none", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      writeFileSync(join(dir, "ops.jsonl"), listing("users/get"));
      const kept = generate(join(fixture, "spec.json"), out, "--group-by", "tag",
        "--operations", join(dir, "ops.jsonl"));
      expect(kept.status, kept.stderr).toBe(0);
      expect(Object.keys(readTree(out))).toEqual(["users.d.ts"]);
      expect(readTree(out)["users.d.ts"]).toContain("export type SimpleUser =");

      writeFileSync(join(dir, "ops.jsonl"), listing("users/get", "users/missing"));
      const missing = generate(join(fixture, "spec.json"), out, "--operations", join(dir, "ops.jsonl"));
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("the document has no operation users/missing");

      const before = readTree(out);
      writeFileSync(join(dir, "ops.jsonl"), "\n");
      const none = generate(join(fixture, "spec.json"), out, "--operations", join(dir, "ops.jsonl"));
      expect(none.status).toBe(1);
      expect(none.stderr).toContain("ops.jsonl lists no operation");
      expect(readTree(out)).toEqual(before);
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

      // An empty token is no index, though as a number it is 0.
      for (const [op, path, said] of [
        ["replace", "/components/schemas/simple-user/required/", "nothing at /components/schemas/simple-user/required/ to replace"],
        ["add", "/components/schemas/simple-user/required/01", "/components/schemas/simple-user/required/01 is not an index"],
      ]) {
        writeFileSync(join(dir, "patch.json"), JSON.stringify([{ op, path, value: "name", reason: "Tests an index." }]));
        const malformed = generate(join(fixture, "spec.json"), out, "--patch", join(dir, "patch.json"));
        expect(malformed.status).toBe(1);
        expect(malformed.stderr).toContain(said);
      }
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
      writeFileSync(join(dir, "ops.jsonl"), listing("users.get", "issues/list", "issues/delete"));
      const result = generate(join(fixture, "spec.json"), out, "--patch", join(dir, "patch.json"),
        "--operations", join(dir, "ops.jsonl"));
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

  it("takes the lines --list prints as its --operations file, and refuses one that has moved", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      const listed = spawnSync(process.execPath, [bin, join(fixture, "spec.json"), "--list"], { encoding: "utf8" });
      const chosen = listed.stdout.split("\n").filter(line => line.includes('"users/get"'));
      expect(chosen).toHaveLength(1);
      writeFileSync(join(dir, "ops.jsonl"), `${chosen[0]}\n\n`);
      const kept = generate(join(fixture, "spec.json"), out, "--operations", join(dir, "ops.jsonl"));
      expect(kept.status, kept.stderr).toBe(0);
      expect(readTree(out)["index.d.ts"]).toContain('      path: "/users/{username}";');

      writeFileSync(join(dir, "ops.jsonl"), chosen[0].replace("/users/{username}", "/people/{username}"));
      const moved = generate(join(fixture, "spec.json"), out, "--operations", join(dir, "ops.jsonl"));
      expect(moved.status).toBe(1);
      expect(moved.stderr).toContain(
        "users/get is GET /users/{username} in the document, not GET /people/{username} as");

      writeFileSync(join(dir, "ops.jsonl"), "users/get\n");
      const text = generate(join(fixture, "spec.json"), out, "--operations", join(dir, "ops.jsonl"));
      expect(text.status).toBe(1);
      expect(text.stderr).toContain("ops.jsonl line 1 is not JSON");

      writeFileSync(join(dir, "ops.jsonl"), `${chosen[0].replace("/users/{username}", "/people/{username}")}\n${chosen[0]}\n`);
      const twice = generate(join(fixture, "spec.json"), out, "--operations", join(dir, "ops.jsonl"));
      expect(twice.status).toBe(1);
      expect(twice.stderr).toContain("ops.jsonl line 2 lists users/get again");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a listed operation that a schema cannot hold", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      writeFileSync(join(dir, "ops.jsonl"), listing("issues/list", "issues/upload", "users/avatar"));
      const result = generate(join(fixture, "spec.json"), out, "--operations", join(dir, "ops.jsonl"));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "issues/upload, POST /repos/{owner}/{repo}/issues/{issue_number}/attachments cannot be in a schema: " +
        "its request body is not `application/json` (application/octet-stream). Take it out of");
      expect(result.stderr).toContain("users/avatar, GET /users/{username}/avatar cannot be in a schema");
      expect(result.stderr).not.toContain("issues/list");
      expect(readdirSync(dir)).toEqual(["ops.jsonl"]);
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
    const lines = listed.stdout.replace(/\n$/, "").split("\n").map(line => JSON.parse(line) as Record<string, string>);
    expect(lines.map(({ operationId, method, path, tag }) => [operationId, method, path, tag])).toEqual([
      ["issues/list", "GET", "/repos/{owner}/{repo}/issues", "issues"],
      ["issues/create", "POST", "/repos/{owner}/{repo}/issues", "issues"],
      ["issues/delete", "DELETE", "/repos/{owner}/{repo}/issues/{issue_number}", "issues"],
      ["issues/upload", "POST", "/repos/{owner}/{repo}/issues/{issue_number}/attachments", "issues"],
      ["users/get", "GET", "/users/{username}", "users"],
      ["users/avatar", "GET", "/users/{username}/avatar", "users"],
    ]);
    expect(lines.every(line => Object.keys(line).join() === "operationId,method,path,tag,summary")).toBe(true);

    const both = generate(join(fixture, "spec.json"), join(tmpdir(), "unused"), "--list");
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("usage:");
  });

  it("refuses a document of a version Forge does not read, before it lists an operation", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const file = join(dir, "swagger.json");
      const paths = { "/status": { get: { operationId: "status", responses: { 200: { description: "Up." } } } } };
      // A version with no patch is one Forge refuses too.
      for (const version of [{ swagger: "2.0" }, { openapi: "3.0" }]) {
        writeFileSync(file, JSON.stringify({ ...version, info: { title: "Old", version: "1" }, paths }));
        const listed = spawnSync(process.execPath, [bin, file, "--list"], { encoding: "utf8" });
        expect(listed.status).toBe(1);
        expect(listed.stdout).toBe("");
        expect(listed.stderr).toContain("is not OpenAPI 3.0, 3.1 or 3.2");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the scopes an operation declares in its comment, from security or a named extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      writeFileSync(join(dir, "patch.json"), JSON.stringify([
        { op: "add", path: "/paths/~1users~1{username}/get/security",
          value: [{ oauth: ["users:read", "users:admin"] }, { key: [] }, { other: ["profile"] }],
          reason: "Tests declared scopes." },
        { op: "add", path: "/paths/~1users~1{username}/get/x-scope", value: "users.read", reason: "Tests an extension." },
      ]));
      writeFileSync(join(dir, "ops.jsonl"), listing("users/get"));
      const args = ["--patch", join(dir, "patch.json"), "--operations", join(dir, "ops.jsonl")];
      expect(generate(join(fixture, "spec.json"), out, ...args).status).toBe(0);
      expect(readTree(out)["index.d.ts"])
        .toContain("     * Scopes the description declares: `users:read`, `users:admin` or `profile`\n");

      expect(generate(join(fixture, "spec.json"), out, ...args, "--scopes-extension", "x-scope").status).toBe(0);
      expect(readTree(out)["index.d.ts"]).toContain("     * Scopes the description declares: `users.read`\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a path item that is a $ref, and leaves out an operation the client cannot send", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const responses = { 204: { description: "Done." } };
      const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
      const strings = { type: "array", items: { type: "string" } };
      const body = (type: string, required: boolean) =>
        ({ required, content: { [type]: { schema: { type: "object", properties: { q: { type: "string" } } } } } });
      const spec = {
        openapi: "3.1.0",
        info: { title: "Things", version: "1" },
        paths: {
          "/status": { $ref: "#/components/pathItems/Status" },
          "/things": { get: { operationId: "things/find", requestBody: body("application/json", false), responses } },
          "/tenants": {
            get: { operationId: "tenants/list", parameters: [{ name: "tenant", in: "query", schema: {} }], responses },
          },
          "/things/search": { get: { operationId: "things/search", requestBody: body("application/json", true), responses } },
          "/things/owned": {
            get: {
              operationId: "things/owned", responses,
              parameters: [
                { name: "owner", in: "query", schema: { anyOf: [ref("Id"), ref("Handle")] } },
                { name: "name", in: "query", schema: ref("Name") },
                { name: "either", in: "query", schema: ref("Either") },
                { name: "layered", in: "query", schema: { anyOf: [ref("Either"), ref("Name")] } },
                { name: "tag", in: "query", schema: { anyOf: [{ type: "string" }, ref("Name"), strings] } },
                { name: "joined", in: "query", explode: false, schema: { anyOf: [{ type: "integer" }, strings] } },
              ],
            },
          },
          "/things/within": {
            get: { operationId: "things/within", parameters: [{ name: "group", in: "query", schema: ref("Group") }], responses },
          },
          "/things/around": {
            get: { operationId: "things/around", parameters: [{ name: "ring", in: "query", schema: ref("Ring") }], responses },
          },
          "/things/{id}": {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            patch: { operationId: "things/patch", requestBody: body("application/merge-patch+json", true), responses },
          },
        },
        components: {
          pathItems: { Status: { get: { operationId: "status/get", responses } } },
          schemas: {
            Id: { type: "string", format: "uuid" },
            Handle: { anyOf: [ref("Id"), { type: "integer" }] },
            Name: { type: ["string", "null"] },
            Either: { anyOf: [ref("Name"), { type: "integer" }] },
            Group: { anyOf: [ref("Group"), { type: "string" }] },
            Ring: ref("Loop"),
            Loop: ref("Ring"),
          },
        },
      };
      const file = join(dir, "spec.json");
      writeFileSync(file, JSON.stringify(spec));
      // A patch to the path item that is referenced reaches the path that references it, and an id
      // is listed as written, so that the line chooses it.
      writeFileSync(join(dir, "patch.json"), JSON.stringify([{
        op: "replace", path: "/components/pathItems/Status/get/operationId", value: "status  get",
        reason: "The test's own.",
      }]));
      const listed = spawnSync(process.execPath, [bin, file, "--list", "--patch", join(dir, "patch.json")], { encoding: "utf8" });
      expect(listed.stdout).toContain('{"operationId":"status  get","method":"GET","path":"/status"');

      const out = join(dir, "out");
      const result = generate(file, out);
      expect(result.status, result.stderr).toBe(0);
      const schema = readTree(out)["index.d.ts"];
      expect(schema).toContain('path: "/status";');
      // An optional body a GET cannot carry is not offered.
      expect(schema).toMatch(/path: "\/things";\n\s+response: undefined;/);
      expect(schema).toContain("GET /things/search (things/search): it requires a request body, which a GET cannot send.");
      // A value of no type has no query string form, and would fail the whole schema's type.
      expect(schema).toContain("GET /tenants (tenants/list): query parameter `tenant` is not a scalar or an array of scalars.");
      // A scalar reached twice, down two branches, is still one, and a referenced one that allows
      // null is sent as the rest of it, alone or among others, and once however many layers name
      // it. A model within itself is no scalar, whether in what it names or as another name for it.
      expect(schema).toMatch(
        /path: "\/things\/owned";\n\s+query: \{\n\s+owner\?: Id \| Handle;\n\s+name\?: string;\n\s+either\?: string \| number;\n\s+layered\?: string \| number;/);
      // One value or a list of them is either, each as it is sent.
      expect(schema).toMatch(/tag\?: string \| readonly string\[\];\n\s+joined\?: number \| string;/);
      for (const [path, name] of [["within", "group"], ["around", "ring"]]) {
        expect(schema).toContain(`GET /things/${path} (things/${path}): query parameter \`${name}\` is not a scalar or an array of scalars.`);
      }
      expect(schema).toContain("PATCH /things/{id} (things/patch): its request body is not `application/json` " +
        "(application/merge-patch+json).");

      writeFileSync(file, JSON.stringify({ ...spec, paths: { "/status": { $ref: "other.json#/Status" } } }));
      const elsewhere = generate(file, out);
      expect(elsewhere.status).toBe(1);
      expect(elsewhere.stderr).toContain('/status is a $ref to "other.json#/Status", which is not a path item of the document');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a YAML document as it reads the same one in JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const out = join(dir, "out");
      writeFileSync(join(dir, "spec.yaml"), stringify(JSON.parse(readFileSync(join(fixture, "spec.json"), "utf8"))));
      const result = generate(join(dir, "spec.yaml"), out, "--group-by", "tag");
      expect(result.status, result.stderr).toBe(0);
      expect(readTree(out)).toEqual(readTree(join(fixture, "expected")));

      writeFileSync(join(dir, "spec.yaml"), "paths: [unclosed");
      const neither = generate(join(dir, "spec.yaml"), out);
      expect(neither.status).toBe(1);
      expect(neither.stderr).toContain("spec.yaml is neither JSON nor YAML: ");
      expect(neither.stderr).not.toContain("    at ");

      // An alias is its anchor's object: the two paths are named apart, and the patch reaches only B.
      writeFileSync(join(dir, "spec.yaml"), [
        "openapi: 3.0.3",
        "info: { title: Things, version: '1' }",
        "paths:",
        "  /a: { get: &get { responses: { '200': { description: Found., content: { application/json: { schema: { $ref: '#/components/schemas/A' } } } } } } }",
        "  /b: { get: *get }",
        "  /c: { get: { responses: { '200': { description: Found., content: { application/json: { schema: { $ref: '#/components/schemas/B' } } } } } } }",
        "components:",
        "  schemas:",
        "    A: &thing { type: object, properties: { x: { type: string } } }",
        "    B: *thing",
      ].join("\n"));
      writeFileSync(join(dir, "patch.json"), JSON.stringify([
        { op: "replace", path: "/components/schemas/B/properties/x/type", value: "number", reason: "Only B's is a number." },
      ]));
      const aliased = generate(join(dir, "spec.yaml"), out, "--patch", join(dir, "patch.json"));
      expect(aliased.status, aliased.stderr).toBe(0);
      const schema = readTree(out)["index.d.ts"];
      expect(schema).toContain("export type A = {\n  x?: string;");
      expect(schema).toContain("export type B = {\n  x?: number;");
      expect(schema).toContain('path: "/b";');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves out an operation with a parameter Forge does not read, and generates the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const responses = { 204: { description: "Done." } };
      const filter = { name: "filter", in: "query", style: "deepObject", schema: { type: "object" } };
      const spec = {
        openapi: "3.1.0",
        info: { title: "Things", version: "1" },
        paths: {
          "/things": { get: { operationId: "things/list", parameters: [{ $ref: "#/components/parameters/Filter" }], responses } },
          "/things/{id}": {
            parameters: [{ name: "id", in: "path", required: true, style: "label", schema: { type: "string" } }],
            get: { operationId: "things/get", responses },
          },
          "/search": {
            get: {
              operationId: "search",
              parameters: [{ name: "q", in: "query", content: { "application/json": { schema: { type: "object" } } } }],
              responses,
            },
          },
          "/status": {
            get: { operationId: "status", parameters: [{ name: "tags", in: "query", style: "form", schema: { type: "string" } }], responses },
          },
        },
        components: { parameters: { Filter: filter } },
      };
      const file = join(dir, "spec.json");
      writeFileSync(file, JSON.stringify(spec));
      const out = join(dir, "out");
      const result = generate(file, out);
      expect(result.status, result.stderr).toBe(0);
      const schema = readTree(out)["index.d.ts"];
      expect(schema).toContain("GET /things (things/list): query parameter `filter` has style `deepObject`, which the client does not send.");
      expect(schema).toContain("GET /things/{id} (things/get): path parameter `id` has style `label`, which the client does not send.");
      expect(schema).toContain("GET /search (search): query parameter `q` is declared with `content`, which the client does not send.");
      expect(schema).toContain('path: "/status";');

      writeFileSync(join(dir, "ops.jsonl"), listing("things/list"));
      const listed = generate(file, out, "--operations", join(dir, "ops.jsonl"));
      expect(listed.status).toBe(1);
      expect(listed.stderr).toContain("things/list, GET /things cannot be in a schema: query parameter `filter` has style `deepObject`");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a schema that parses for shapes real descriptions have", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const json = (schema: object) => ({ content: { "application/json": { schema } } });
      const ok = (name: string) => ({ 200: { description: "Found.", ...json({ $ref: `#/components/schemas/${name}` }) } });
      const responses = { 204: { description: "Done." } };
      const spec = {
        openapi: "3.0.3",
        info: { title: "Things", version: "1" },
        paths: {
          "/grid": {
            put: {
              operationId: "grid/put",
              requestBody: json({ type: "object", properties: { rows: { type: "array", items: { type: "array", items: { type: "number" } } } } }),
              responses,
            },
          },
          "/kinds": {
            get: {
              operationId: "kinds/list",
              parameters: [{ name: "kind", in: "query", schema: { type: "array", items: { type: "string", nullable: true } } }],
              responses,
            },
          },
          "/blob": { post: { operationId: "blob/post", requestBody: { content: { "*/*": {} } }, responses } },
          "/a": { get: { operationId: "a/get", responses: ok("job-result") } },
          "/b": { get: { operationId: "b/get", responses: ok("job_result") } },
          "/tone": {
            get: {
              operationId: "tone/get",
              responses: { 200: { description: "Found.", ...json({ allOf: [
                { type: "string", enum: ["a", "b"] }, { type: "string", enum: ["b", "c"] },
              ] }) } },
            },
          },
          "/rows": {
            get: {
              operationId: "rows/list",
              responses: { 200: { description: "Found.", ...json({ type: "array", items: {
                type: "object", required: ["id"], properties: { id: { type: "integer" } }, additionalProperties: { type: "string" },
              } }) } },
            },
          },
        },
        components: {
          schemas: {
            "job-result": { type: "object", properties: { a: { type: "string" } } },
            job_result: { type: "object", properties: { b: { type: "number" } } },
          },
        },
      };
      const file = join(dir, "spec.json");
      writeFileSync(file, JSON.stringify(spec));
      const out = join(dir, "out");
      const result = generate(file, out);
      expect(result.status, result.stderr).toBe(0);
      const schema = readTree(out)["index.d.ts"];
      // `readonly` takes one array type.
      expect(schema).toContain("rows?: readonly (readonly number[])[];");
      // A query string has no null, and one in the type fails the whole schema's.
      expect(schema).toContain("kind?: readonly string[];");
      // The media type would otherwise end the comment it is named in.
      expect(schema).toContain("its request body is not `application/json` (*\\/*).");
      // Two models of one name are told apart.
      expect(schema).toContain("export type JobResult = {");
      expect(schema).toContain("export type JobResult2 = {");
      expect(schema).toMatch(/path: "\/b";\n\s+response: JobResult2;/);
      // `&` would otherwise take one value of each enum.
      expect(schema).toContain('response: ("a" | "b") & ("b" | "c");');
      // `[]` would otherwise take the index signature alone.
      expect(schema).toMatch(/response: \(\{\n\s+id: number;\n\s+\} & \{\n\s+\[key: string\]: string;\n\s+\}\)\[\];/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aliases an import whose name the group's file declares", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const json = (name: string) => ({ content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } } });
      const create = (tag: string, response: string) => ({
        tags: [tag], operationId: `${tag}/create`, requestBody: { required: true, ...json("UserInput") },
        responses: { 200: { description: "Made.", ...json(response) } },
      });
      // Both groups use `UserInput` and `UsersApi`, so the root declares them, and `users` imports
      // them beside its own `UserInput`, which is `User` as a request sends it, and its own schema.
      const spec = {
        openapi: "3.0.3",
        info: { title: "Users", version: "1" },
        paths: { "/users": { post: create("users", "User") }, "/admin/users": { post: create("admin", "UsersApi") },
          "/users/api": { get: { tags: ["users"], operationId: "users/api", responses: { 200: { description: "Found.", ...json("UsersApi") } } } } },
        components: {
          schemas: {
            User: { type: "object", properties: { id: { type: "string", readOnly: true }, name: { type: "string" } } },
            UserInput: { type: "object", properties: { name: { type: "string" } } },
            UsersApi: { type: "object", properties: { version: { type: "string" } } },
          },
        },
      };
      const file = join(dir, "spec.json");
      writeFileSync(file, JSON.stringify(spec));
      const out = join(dir, "out");
      const result = generate(file, out, "--group-by", "tag");
      expect(result.status, result.stderr).toBe(0);
      const users = readTree(out)["users.d.ts"];
      expect(users).toContain("export type UserInput = {");
      expect(users).toContain("export type UsersApi = {");
      expect(users).toContain("body: UserInput$;");
      expect(users).toContain("response: UsersApi$;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives a group's schema its name before a model, as an identifier", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const spec = {
        openapi: "3.0.3",
        info: { title: "Users", version: "1" },
        paths: {
          "/2fa": { get: { tags: ["2FA"], operationId: "2fa/get", responses: { 204: { description: "Done." } } } },
          "/users": { get: { tags: ["users"], operationId: "users/get", responses: { 200: { description: "Found.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/UsersApi" } } } } } } },
        },
        components: { schemas: { UsersApi: { type: "object", properties: { version: { type: "string" } } } } },
      };
      const file = join(dir, "spec.json");
      writeFileSync(file, JSON.stringify(spec));
      const out = join(dir, "out");
      const result = generate(file, out, "--group-by", "tag");
      expect(result.status, result.stderr).toBe(0);
      const tree = readTree(out);
      expect(tree["2Fa.d.ts"]).toContain("export type _2FaApi = {");
      expect(tree["users.d.ts"]).toContain("export type UsersApi = {\n  get: [");
      expect(tree["users.d.ts"]).toContain("export type UsersApi2 = {\n  version?: string;");
      expect(tree["users.d.ts"]).toContain("response: UsersApi2;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes over an operation marked x-forge-skip, as Forge does, unless a live alias names it or a patch clears the mark", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const operation = (operationId: string, extensions = {}) =>
        ({ operationId, "x-forge-skip": true, ...extensions, responses: { 204: { description: "Done." } } });
      const alias = (extensions = {}) =>
        ({ "x-forge-aliases": [{ "x-forge-group-name": "people", "x-forge-method-name": "rename", ...extensions }] });
      const spec = {
        openapi: "3.0.3",
        info: { title: "Users", version: "1" },
        paths: { "/users": {
          delete: operation("users/purge"), patch: operation("users/rename", alias()),
          put: operation("users/replace", alias({ "x-forge-skip": true })),
          // Not marked itself, but its aliases stand in for it, and the only one is.
          post: operation("users/invite", { "x-forge-skip": false, ...alias({ "x-forge-skip": true }) }),
        } },
      };
      const file = join(dir, "spec.json");
      writeFileSync(file, JSON.stringify(spec));
      const list = (...args: string[]) => spawnSync(process.execPath, [bin, file, "--list", ...args], { encoding: "utf8" }).stdout;
      expect(list()).toContain("users/rename");
      expect(list()).not.toContain("users/purge");
      expect(list()).not.toContain("users/replace");
      expect(list()).not.toContain("users/invite");
      const out = join(dir, "out");
      expect(generate(file, out).status).toBe(0);
      expect(readTree(out)["index.d.ts"]).toContain("patch: [");
      expect(readTree(out)["index.d.ts"]).not.toContain("delete: [");

      writeFileSync(join(dir, "operations.jsonl"), listing("users/purge"));
      const listed = generate(file, out, "--operations", join(dir, "operations.jsonl"));
      expect(listed.status).toBe(1);
      expect(listed.stderr).toContain("the document has no operation users/purge, or marks it x-forge-skip");

      writeFileSync(join(dir, "patch.json"), JSON.stringify([
        { op: "remove", path: "/paths/~1users/delete/x-forge-skip", reason: "The gatekeeper purges users." },
      ]));
      expect(list("--patch", join(dir, "patch.json"))).toContain("users/purge");
      expect(generate(file, out, "--patch", join(dir, "patch.json")).status).toBe(0);
      expect(readTree(out)["index.d.ts"]).toContain("delete: [");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses two groups that would be one file, and leaves the output as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-schema-"));
    try {
      const operation = (operationId: string, tags?: string[]) => ({ operationId, tags, responses: { 204: { description: "Done." } } });
      const spec = {
        openapi: "3.0.3",
        info: { title: "Users", version: "1" },
        paths: { "/plain": { get: operation("plain") }, "/tagged": { get: operation("tagged", ["Index"]) } },
      };
      const file = join(dir, "spec.json");
      writeFileSync(file, JSON.stringify(spec));
      const out = join(dir, "out");
      expect(generate(file, out).status).toBe(0);
      const before = readTree(out);
      const result = generate(file, out, "--group-by", "tag");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("two groups would both be index.d.ts");
      expect(readTree(out)).toEqual(before);
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

      // Nor a link, which the replacement would delete unread.
      rmSync(join(dir, "handwritten.ts"));
      symlinkSync(join(fixture, "spec.json"), join(dir, "linked.json"));
      const linked = generate(join(fixture, "spec.json"), dir, "--group-by", "tag");
      expect(linked.status).toBe(1);
      expect(linked.stderr).toContain("linked.json was not generated");
      expect(readdirSync(dir)).toContain("linked.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Compile-time checks of the generated schemas against the client; never called.
async function typeChecks(owner: string, repo: string) {
  const issues = createOpenAPIClient<IssuesApi>({ baseUrl: "https://api.example.com" });
  const users = createOpenAPIClient<UsersApi>({ baseUrl: "https://api.example.com" });

  const { data: list } = await issues.get("/repos/{owner}/{repo}/issues", {
    path: { owner, repo }, query: { state: "open", labels: ["bug"] },
  });
  const number: number | undefined = list[0].number;
  const login: string | undefined = list[0].user?.login;
  const created = await issues.post("/repos/{owner}/{repo}/issues", {
    path: { owner, repo }, headers: { "X-Request-Id": "1" }, body: { title: "Hi" },
  });
  const { data: deleted }: { data: undefined } = await issues.delete("/repos/{owner}/{repo}/issues/{issue_number}", {
    path: { owner, repo, issue_number: 1 },
  });
  const { data: user } = await users.get("/users/{username}", { path: { username: "octocat" } });
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
