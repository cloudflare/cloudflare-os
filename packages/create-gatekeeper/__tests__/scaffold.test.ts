import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH_KINDS, namesFor, scaffold, stops } from "../src/scaffold.ts";

const pkg = join(import.meta.dirname, "..");
const repo = join(pkg, "..", "..");
const bin = join(pkg, "bin", "create-gatekeeper.ts");

function run(cwd: string, command: string, ...args: string[]) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

describe("namesFor", () => {
  it("derives every spelling of a provider's name", () => {
    expect(namesFor({ name: "pagerduty", display: "PagerDuty" }))
      .toEqual({ name: "pagerduty", pascal: "PagerDuty", constant: "PAGERDUTY", display: "PagerDuty" });
    expect(namesFor({ name: "home-assistant" }))
      .toEqual({ name: "home-assistant", pascal: "HomeAssistant", constant: "HOME_ASSISTANT", display: "Home Assistant" });
  });

  it.each(["", "Acme", "acme_co", "-acme", "acme--co", "acme/co", "1password"])("refuses the name %j", name => {
    expect(() => namesFor({ name })).toThrow("is not a gatekeeper name");
  });

  it.each(['A "B"', "A`B", "A${B}", "A\\B", "A\nB"])("refuses the display name %j", display => {
    expect(() => namesFor({ name: "acme", display })).toThrow("display name");
  });

  it("refuses a display name with no letters to name a class by", () => {
    expect(() => namesFor({ name: "acme", display: "123" })).toThrow("No class name");
  });
});

describe.each(AUTH_KINDS)("scaffold with --auth %s", auth => {
  const files = scaffold({ name: "home-assistant", display: "Home Assistant", auth });

  it("renames the template's provider everywhere", () => {
    for (const [path, file] of files) {
      expect(`${path}\n${"text" in file ? file.text : file.symlink}`).not.toMatch(/acme/i);
    }
    expect([...files.keys()]).toContain("src/home-assistant.ts");
  });

  it("marks what is left to decide", () => {
    expect(stops(files).map(({ id }) => id)).toEqual(expect.arrayContaining(["session-api", "resources", "subresources", "actions"]));
  });

  // Runs wrangler and the compiler over a generated package, which takes some seconds. The package
  // is laid out beside symlinks to the packages it names by path, as it would be in `packages/`.
  it("generates a package that compiles", { timeout: 180_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "create-gatekeeper-"));
    try {
      const dir = join(root, "packages", "gatekeeper-home-assistant");
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
      run(repo, process.execPath, bin, "home-assistant", "--display", "Home Assistant", "--auth", auth, "--out", dir);
      // This package depends on what a generated one does, so the generated one resolves from it.
      symlinkSync(join(pkg, "node_modules"), join(dir, "node_modules"));

      // As `pnpm types:generate` does: the Worker config from cloudflare.config.ts, then its types.
      writeFileSync(join(dir, "wrangler.jsonc"), run(dir, process.execPath, "--input-type=module", "-e",
        "const { renderWorkerConfig } = await import(process.argv[1]); process.stdout.write(await renderWorkerConfig(process.argv[2]));",
        join(repo, "scripts", "generate-worker-configs.ts"), dir));
      run(dir, join(pkg, "node_modules", ".bin", "wrangler"), "types", "worker-configuration.d.ts");
      const types = join(dir, "worker-configuration.d.ts");
      writeFileSync(types, readFileSync(types, "utf8").replace("./.wrangler/validate/src/", "./src/"));

      run(dir, join(pkg, "node_modules", ".bin", "tsc"), "-p", dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("create-gatekeeper", () => {
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
