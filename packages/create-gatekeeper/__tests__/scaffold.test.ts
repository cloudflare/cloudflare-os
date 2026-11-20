import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTH_KINDS, namesFor, resolveBlocks, scaffold, stops } from "../src/scaffold.ts";

const pkg = join(import.meta.dirname, "..");
const repo = join(pkg, "..", "..");
const bin = join(pkg, "bin", "create-gatekeeper.ts");

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
    const ids = stops(scaffold({ name: "acme", auth: "api-key", hooks: true })).map(({ id }) => id);
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

const VARIANTS = AUTH_KINDS.flatMap(auth => [{ auth, hooks: false }, { auth, hooks: true }]);

describe.each(VARIANTS)("scaffold with --auth $auth, hooks $hooks", ({ auth, hooks }) => {
  const files = scaffold({ name: "homeassistant", display: "Home Assistant", auth, hooks });

  it("renames the template's provider everywhere", () => {
    for (const [path, file] of files) {
      expect(`${path}\n${"text" in file ? file.text : file.symlink}`).not.toMatch(/acme|\/\/ #(if|else|endif)/i);
    }
    expect([...files.keys()]).toContain("src/homeassistant.ts");
  });

  it(hooks ? "writes the hooks module" : "writes nothing about hooks", () => {
    expect(files.has("src/homeassistant-hooks.ts")).toBe(hooks);
    const text = [...files.values()].map(file => "text" in file ? file.text : "").join("\n");
    expect(/hook/i.test(text.replaceAll("webhook", ""))).toBe(hooks);
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
        ...(hooks ? ["--hooks"] : []));
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

  it("refuses to write over a directory", () => {
    const result = spawnSync(process.execPath, [bin, "acme", "--auth", "oauth", "--out", pkg], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
  });

  it("prints its usage when no way to connect is named", () => {
    const result = spawnSync(process.execPath, [bin, "acme"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--auth <oauth|api-key>");
  });
});
