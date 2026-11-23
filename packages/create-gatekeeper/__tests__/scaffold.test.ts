import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTH_KINDS, namesFor, resolveBlocks, scaffold, stops, type OpenApiOptions } from "../src/scaffold.ts";

const pkg = join(import.meta.dirname, "..");
const repo = join(pkg, "..", "..");
const bin = join(pkg, "bin", "create-gatekeeper.ts");
/** The kit's schema generator, and the description its own tests generate from. */
const openapiSchemaBin = join(repo, "packages", "gatekeeper-kit", "bin", "openapi-schema.ts");
const spec = join(repo, "packages", "gatekeeper-kit", "__tests__", "fixtures", "openapi-schema", "spec.json");
/** A stand-in for what the generator writes. */
const GENERATED = { operations: '{"operationId":"users/get"}\n', schema: new Map([["index.d.ts", "export type Api = {};\n"]]) };

/** A tool's Node entry point. Its `.bin` shim is a `.cmd` file on Windows, which cannot be spawned. */
const tool = (name: string, entry: string) => join(pkg, "node_modules", name, entry);

function run(cwd: string, command: string, ...args: string[]) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

describe("namesFor", () => {
  it("derives every spelling of a provider's name", () => {
    expect(namesFor({ name: "pagerduty", display: "PagerDuty" }))
      .toEqual({ name: "pagerduty", pascal: "PagerDuty", constant: "PAGERDUTY", display: "PagerDuty" });
    expect(namesFor({ name: "homeassistant", display: "Home Assistant" }))
      .toEqual({ name: "homeassistant", pascal: "HomeAssistant", constant: "HOMEASSISTANT", display: "Home Assistant" });
    expect(namesFor({ name: "zoominfo" }).display).toBe("Zoominfo");
  });

  it.each(["observability", "types"])("refuses %j, a module every gatekeeper has", name => {
    expect(() => scaffold({ name, auth: "oauth" })).toThrow("is a module every gatekeeper has");
  });

  it("refuses a display name that names its types as the template names its own", () => {
    expect(() => namesFor({ name: "wire" })).toThrow("use another display name");
    expect(namesFor({ name: "wire", display: "Wire Transfer" }).pascal).toBe("WireTransfer");
  });

  it("links the types an agent is shown to the declarations", () => {
    expect(scaffold({ name: "acme", auth: "oauth" }).get("src/types.txt")).toEqual({ symlink: "types.d.ts" });
  });

  // The release folds a name to its install slug, so one that would change in the fold is refused.
  it.each(["", "Acme", "acme_co", "-acme", "home-assistant", "acme/co", "1password", "a".repeat(21)])("refuses the name %j", name => {
    expect(() => namesFor({ name })).toThrow("is not a gatekeeper name");
  });

  it.each(['A "B"', "A`B", "A${B}", "A\\B", "A\nB", "A*/B", "A]B", "A<B", "A'B", " A"])("refuses the display name %j", display => {
    expect(() => namesFor({ name: "acme", display })).toThrow("display name");
  });

  it("refuses a display name with no letters to name a class by", () => {
    expect(() => namesFor({ name: "acme", display: "123" })).toThrow("No class name");
  });
});

describe("scaffold", () => {
  it("renames once, whatever the provider's own name contains", () => {
    const files = scaffold({ name: "acmecorp", display: "ACME Corp", auth: "oauth" });
    const main = files.get("src/acmecorp.ts");
    expect(main && "text" in main && main.text).toContain('displayName: "ACME Corp"');
    expect(main && "text" in main && main.text).toContain("export class ACMECorpVerifier");
  });

  it("lists the decisions the operator reviews first", () => {
    const ids = stops(scaffold({ name: "acme", auth: "api-key", hooks: "app" })).map(({ id }) => id);
    expect(ids.slice(0, 3)).toEqual(["session-api", "resources", "subresources"]);
  });

  // A page that sends no referrer posts its forms with `Origin: null`, which the submission's
  // cross-site check refuses: the form would never submit.
  it("serves the key form so that its submission names its origin", () => {
    const account = scaffold({ name: "acme", auth: "api-key" }).get("src/acme-account.ts");
    const text = account && "text" in account ? account.text : "";
    expect(text).toMatch(/return formPageResponse\(connectFormHtml\(/);
    expect(text).not.toMatch(/htmlResponse\(connectFormHtml\(/);
  });

  // A typo must not send the user back to the Workshop: a refused key gets the form again.
  it("shows the key form again for a key the provider refuses", () => {
    const account = scaffold({ name: "acme", auth: "api-key" }).get("src/acme-account.ts");
    const text = account && "text" in account ? account.text : "";
    // Checked before the provider is asked, and claimed only after it takes the key.
    const [check, ask, claim] = ["if (peekOAuth(kv, formNonce", "await fetchUser(key)", "claimOAuth<ConnectAttempt>(kv, formNonce"]
      .map(step => text.indexOf(step));
    expect(check).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(check);
    expect(claim).toBeGreaterThan(ask);
    expect(text).toContain('if ("retry" in result) return keyFormResponse(env, path[0], formNonce, result.retry);');
  });
});

describe("resolveBlocks", () => {
  const text = "a\n  // #if hooks\nb\n  // #else\nc\n  // #endif\nd";

  it("keeps a block's first half with the feature and its second without", () => {
    expect(resolveBlocks(text, new Set(["hooks"]))).toBe("a\nb\nd");
    expect(resolveBlocks(text, new Set())).toBe("a\nc\nd");
  });

  it.each(["// #if hooks\na", "a\n// #endif", "// #else", "// #if hooks\n// #if hooks\n// #endif", "// #if\n// #endif", "// #if hook\n// #endif"])(
    "refuses the malformed template %j", malformed => {
      expect(() => resolveBlocks(malformed, new Set())).toThrow();
    });
});

describe("scaffold with an OpenAPI description", () => {
  const text = (files: ReturnType<typeof scaffold>, path: string): string => {
    const file = files.get(path);
    return file && "text" in file ? file.text : "";
  };

  const document = '{"paths":{}}';
  const pinned = `--out src/openapi --sha256 ${createHash("sha256").update(document).digest("hex")} --operations openapi-operations.jsonl`;
  const script = (openapi: Partial<OpenApiOptions>) => {
    const files = scaffold({ name: "acme", auth: "api-key", openapi: { document, ...openapi } });
    return { files, script: JSON.parse(text(files, "package.json")).scripts["generate:openapi"] as string };
  };

  // A description can be megabytes: the hash is the record, and the script is given the file.
  it("pins the description by its hash and keeps no copy of it", () => {
    const { files, script: generate } = script({});
    expect(generate).toBe(`gatekeeper-openapi-schema ${pinned}`);
    expect(files.has("openapi.json")).toBe(false);
    expect(text(files, "README.md")).not.toContain("openapi.json");
  });

  it("generates from the description's URL where it has one", () => {
    const url = "https://raw.example.com/acme/api/3f2a/openapi.json?raw=1&v=2";
    expect(script({ url }).script).toBe(`gatekeeper-openapi-schema "${url}" ${pinned}`);
    // The last would put a password in a committed file.
    for (const refused of ["http://example.com/openapi.json", 'https://example.com/a"; rm -rf ~; "', "https://example.com/$(id)",
      "https://user:secret@example.com/openapi.json"]) {
      expect(() => script({ url: refused })).toThrow("must be an https one");
    }
  });

  it("keeps a copy of the description when asked, and generates from that", () => {
    const { files, script: generate } = script({ copy: true });
    expect(generate).toBe(`gatekeeper-openapi-schema openapi.json ${pinned}`);
    expect(text(files, "openapi.json")).toBe(document);
    expect(text(files, "README.md")).toContain("That is [`openapi.json`](openapi.json), the package's copy.");

    const yaml = scaffold({ name: "acme", auth: "api-key", openapi: { document: "paths: {}\n", copy: true } });
    expect(JSON.parse(text(yaml, "package.json")).scripts["generate:openapi"]).toMatch(/^gatekeeper-openapi-schema openapi\.yaml /);
    expect(text(yaml, "openapi.yaml")).toBe("paths: {}\n");
    expect(text(yaml, "README.md")).toContain("That is [`openapi.yaml`](openapi.yaml), the package's copy.");
  });

  // Each is refused before anything is fetched or written.
  it.each([
    [["--fetch"], "--fetch downloads the description from --openapi-url"],
    [["--fetch", "--openapi-url", "https://example.com/a.json", "--openapi", "a.json"], "in place of --openapi"],
    [["--fetch", "--openapi-url", "http://example.com/a.json"], "must be an https one"],
    [["--openapi-url", "https://example.com/a.json"], "--openapi-url needs --openapi, or --fetch"],
    [["--openapi", "a.json", "--openapi-url", "https://example.com/a.json", "--keep-description"], "leaves --openapi-url nothing to do"],
  ])("refuses %j", (args, said) => {
    const result = spawnSync(process.execPath, [bin, "acme", "--auth", "api-key", "--out", join(tmpdir(), "create-gatekeeper-refused"), ...args], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(said);
  });

  it("has an empty list until operations are chosen", () => {
    const files = scaffold({ name: "acme", auth: "api-key", openapi: { document } });
    expect(files.get("openapi-operations.jsonl")).toEqual({ text: "" });
    expect([...files.keys()].filter(path => path.startsWith("src/openapi/"))).toEqual([]);
    // Nothing is generated to import, so the client is the invented one.
    expect(text(files, "src/acme-api-schema.ts")).toContain('{ path: "/me"; response: WireUser }');
    expect(text(files, "src/acme-api-schema.ts")).not.toContain('from "./openapi"');
    expect(text(files, "README.md")).toContain("## The provider's API");
  });

  it("calls through the generated schema once operations are chosen", () => {
    const files = scaffold({ name: "acme", auth: "api-key", openapi: { document: "{}", generated: GENERATED } });
    expect(files.get("openapi-operations.jsonl")).toEqual({ text: GENERATED.operations });
    expect(files.get("src/openapi/index.d.ts")).toEqual({ text: "export type Api = {};\n" });
    expect(text(files, "src/acme-api-schema.ts")).toContain('import type { Api as Described } from "./openapi";');
    expect(text(files, "src/acme-api-schema.ts")).toContain("export type Api = Both<Described, Invented>;");
    // The scaffold's own calls are still invented, and still marked.
    expect(stops(files).map(({ id }) => id)).toContain("api");
  });

  it("refuses a kind of hooks it has no template for", () => {
    expect(() => scaffold({ name: "acme", auth: "oauth", hooks: "polling" as "app" })).toThrow('Unknown --hooks "polling": use app or subscription.');
  });

  it("refuses the name of the generated schema's directory", () => {
    expect(() => scaffold({ name: "openapi", auth: "api-key", openapi: { document: "{}" } })).toThrow("use another name");
  });

  it("leaves the generated schema out of what the package's test reads for invented values", () => {
    const stopsTest = (openapi: boolean) =>
      text(scaffold({ name: "acme", auth: "api-key", openapi: openapi ? { document: "{}" } : undefined }), "__tests__/scaffold-stops.test.ts");
    expect(stopsTest(true)).toContain('startsWith(join(src, "openapi"))');
    expect(stopsTest(false)).not.toContain("openapi");
  });

  it("writes nothing about a description when there is none", () => {
    const files = scaffold({ name: "acme", auth: "api-key" });
    expect([...files.keys()].filter(path => /openapi/.test(path))).toEqual([]);
    expect(text(files, "package.json")).not.toContain("generate:openapi");
    expect(text(files, "README.md")).not.toContain("openapi.json");
  });
});

// Each way to connect alone, each kind of hooks once, and a generated schema.
const VARIANTS = [
  ...AUTH_KINDS.map(auth => ({ auth, hooks: undefined, openapi: false })),
  { auth: "oauth" as const, hooks: "app" as const, openapi: false },
  { auth: "api-key" as const, hooks: "subscription" as const, openapi: false },
  { auth: "api-key" as const, hooks: undefined, openapi: true },
];

describe.each(VARIANTS)("scaffold with --auth $auth, hooks $hooks, openapi $openapi", ({ auth, hooks, openapi }) => {
  const files = scaffold({
    name: "homeassistant", display: "Home Assistant", auth, hooks,
    openapi: openapi ? { document: "{}", generated: GENERATED } : undefined,
  });

  it("renames the template's provider everywhere", () => {
    for (const [path, file] of files) {
      expect(`${path}\n${"text" in file ? file.text : file.symlink}`).not.toMatch(/acme|\/\/ #(if|else|endif)/i);
    }
    expect([...files.keys()]).toContain("src/homeassistant.ts");
  });

  it(hooks ? "writes the hooks module and its driver" : "writes nothing about hooks", () => {
    expect(files.has("src/homeassistant-hooks.ts")).toBe(hooks !== undefined);
    expect(files.has("src/homeassistant-hook-driver.ts")).toBe(hooks !== undefined);
    const text = [...files.values()].map(file => "text" in file ? file.text : "").join("\n");
    expect(/hook/i.test(text)).toBe(hooks !== undefined);
    // Only a gatekeeper that adds webhooks itself calls the provider to.
    expect(text.includes("/items/{id}/webhooks")).toBe(hooks === "subscription");
    expect(text.includes("WEBHOOK_SECRET")).toBe(hooks === "app");
    expect(text.includes("WEBHOOK_ORIGIN")).toBe(hooks === "subscription");
  });

  it("marks what is left to decide", () => {
    expect(stops(files).map(({ id }) => id)).toEqual(expect.arrayContaining(["session-api", "resources", "subresources", "actions"]));
  });

  // Runs wrangler and the compiler over a generated package, which takes some seconds. The package
  // is laid out beside symlinks to the packages it names by path, as it would be in `packages/`.
  it("generates a package that compiles", { timeout: 180_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "create-gatekeeper-"));
    try {
      const dir = join(root, "packages", "gatekeeper-homeassistant2");
      mkdirSync(join(root, "packages"));
      copyFileSync(join(repo, "tsconfig.json"), join(root, "tsconfig.json"));
      // Wrangler's build step runs `pnpm exec`, which first checks the package's dependencies
      // against a lockfile. This copy has none, and a pnpm that takes the failed check for an
      // error, as the one `vp run` provides does, builds nothing and leaves the types without
      // the Worker's exports.
      writeFileSync(join(root, "pnpm-workspace.yaml"), "verifyDepsBeforeRun: false\n");
      for (const name of ["configurator-ui", "gatekeeper-kit", "workshop-shared"]) {
        symlinkSync(join(repo, "packages", name), join(root, "packages", name));
      }
      run(repo, process.execPath, bin, "homeassistant", "--display", "Home Assistant", "--auth", auth, "--out", dir,
        ...(hooks ? ["--hooks", hooks] : []),
        ...(openapi ? ["--openapi", spec, "--operations", "users/get, issues/list"] : []));
      if (openapi) {
        const schema = join(dir, "src", "openapi", "index.d.ts");
        const generated = readFileSync(schema, "utf8");
        expect(generated).toContain('      path: "/users/{username}";');
        expect(generated).not.toContain("/attachments");
        expect(existsSync(join(dir, "openapi.json"))).toBe(false);
        // The package's own script generates the same schema again, given the description.
        const script = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> })
          .scripts["generate:openapi"].split(" ");
        expect(script[0]).toBe("gatekeeper-openapi-schema");
        run(dir, process.execPath, openapiSchemaBin, ...script.slice(1), spec);
        expect(readFileSync(schema, "utf8")).toBe(generated);
        // And refuses another document, which the hash tells apart.
        const other = join(root, "other.json");
        writeFileSync(other, `${readFileSync(spec, "utf8")}\n`);
        expect(() => run(dir, process.execPath, openapiSchemaBin, ...script.slice(1), other)).toThrow(/SHA-256/);
      }
      // This package depends on what a generated one does, so the generated one resolves from it.
      symlinkSync(join(pkg, "node_modules"), join(dir, "node_modules"));

      // As `pnpm types:generate` does: the Worker config from cloudflare.config.ts, then its types.
      writeFileSync(join(dir, "wrangler.jsonc"), run(dir, process.execPath, "--input-type=module", "-e",
        "const { renderWorkerConfig } = await import(process.argv[1]); process.stdout.write(await renderWorkerConfig(process.argv[2]));",
        // As a URL: `import()` takes a Windows path's drive letter for a scheme.
        pathToFileURL(join(repo, "scripts", "generate-worker-configs.ts")).href, dir));
      run(dir, process.execPath, tool("wrangler", "bin/wrangler.js"), "types", "worker-configuration.d.ts");
      const types = join(dir, "worker-configuration.d.ts");
      // And as its post-processing does: the main module where the sources are, and the `restore`
      // export wrangler's types lack, which the command lists a package with hooks to be given.
      const restore = "export const tracing: Tracing;\n";
      const generated = readFileSync(types, "utf8").replace("./.wrangler/validate/src/", "./src/");
      expect(generated).toContain(restore);
      writeFileSync(types, hooks ? generated.replace(restore, `${restore}    export const restore: symbol;\n`) : generated);

      run(dir, process.execPath, tool("typescript", "bin/tsc"), "-p", dir);
      // The configurator's copy of the link grammar agrees with the server's, as generated.
      run(dir, process.execPath, tool("vitest", "vitest.mjs"), "run", "__tests__/configurator-url.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("create-gatekeeper", () => {
  // `gatekeeper-mcp-portal` folds to this name's install slug.
  it("refuses a name whose install slug another gatekeeper has", () => {
    const result = spawnSync(process.execPath, [bin, "mcpportal", "--auth", "oauth"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/gatekeeper-mcp-portal already has the install slug "mcpportal"');
  });

  // Run from the temp directory, which is where an empty --out would otherwise write.
  it.each([[pkg, "already exists"], ["", "--out names no directory"]])("refuses to write to %j", (out, message) => {
    const result = spawnSync(process.execPath, [bin, "acme", "--auth", "oauth", "--out", out], { encoding: "utf8", cwd: tmpdir() });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("lists a description's operations when none is chosen, and generates no schema", () => {
    const root = mkdtempSync(join(tmpdir(), "create-gatekeeper-"));
    try {
      const dir = join(root, "gatekeeper-acme");
      const stdout = run(repo, process.execPath, bin, "acme", "--auth", "api-key", "--out", dir, "--openapi", spec);
      const listed = stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as { operationId: string });
      expect(listed.map(({ operationId }) => operationId)).toEqual(
        ["issues/list", "issues/create", "issues/delete", "issues/upload", "users/get", "users/avatar"]);
      expect(readFileSync(join(dir, "openapi-operations.jsonl"), "utf8")).toBe("");
      expect(existsSync(join(dir, "src", "openapi"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes a file of listed lines for --operations, and one that it refuses leaves nothing behind", () => {
    const root = mkdtempSync(join(tmpdir(), "create-gatekeeper-"));
    const [dir, other, lines, scratch] = ["gatekeeper-acme", "other", "lines.jsonl", "tmp"].map(name => join(root, name));
    // In a temp directory of its own: another scaffold's scratch is not this one's to count.
    const refused = () => spawnSync(process.execPath, [bin, "acme", "--auth", "api-key", "--out", other, "--openapi", spec, "--operations", lines],
      { encoding: "utf8", env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch } });
    try {
      writeFileSync(lines, '{"operationId":"users/get","method":"GET","path":"/users/{username}"}\n');
      run(repo, process.execPath, bin, "acme", "--auth", "api-key", "--out", dir, "--openapi", spec, "--operations", lines);
      expect(readFileSync(join(dir, "openapi-operations.jsonl"), "utf8")).toBe(readFileSync(lines, "utf8"));
      expect(readFileSync(join(dir, "src", "openapi", "index.d.ts"), "utf8")).toContain('path: "/users/{username}";');

      // A refusal ends the command, which must still clear what it generated into.
      mkdirSync(scratch);
      writeFileSync(lines, '{"operationId":"users/avatar"}\n');
      expect(refused().status).toBe(1);
      expect(readdirSync(scratch)).toEqual([]);

      // A file with no line in it, as a search of the listing that matched nothing leaves.
      writeFileSync(lines, "");
      expect(refused().stderr).toContain("--operations names no operation");
      expect(existsSync(other)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [["--operations", "users/get"], "--operations needs --openapi"],
    [["--openapi", spec, "--operations", "users/get,users/missing"], "The description has no operation users/missing"],
    [["--openapi", spec, "--operations", ","], "--operations names no operation"],
    // One the schema cannot hold: its reply is not JSON.
    [["--openapi", spec, "--operations", "users/avatar"], "its 200 response is not JSON (image/png). Take it out of --operations and write that call by hand"],
    [["--openapi", join(pkg, "missing.json")], "Could not read --openapi"],
  ])("writes nothing for %j", { timeout: 120_000 }, (args, message) => {
    const root = mkdtempSync(join(tmpdir(), "create-gatekeeper-"));
    try {
      const dir = join(root, "gatekeeper-acme");
      const result = spawnSync(process.execPath, [bin, "acme", "--auth", "api-key", "--out", dir, ...args], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints its usage when no way to connect is named", () => {
    const result = spawnSync(process.execPath, [bin, "acme"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--auth <oauth|api-key>");
  });
});
