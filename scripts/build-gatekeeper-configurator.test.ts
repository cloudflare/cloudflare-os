import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { after, before, describe, it } from "node:test";
import ts from "typescript6"; // JS compiler API (decodeMappings); see configurator-ui/build/module.ts

// The builder's own concerns: which env it reads, what it writes beside the generated HTML for
// error reporting, and how that lines up with what the frame runs. The runtime it embeds, and the
// frame as a whole, are tested in `packages/configurator-ui`.

const execFileAsync = promisify(execFile);
const builder = resolve("scripts/build-gatekeeper-configurator.ts");
const configuratorSource =
  'import { h } from "@gadgets/configurator-ui";\n' +
  'export default { render() { throw new Error("mapped configurator failure"); return <div />; } };\n';
const REPORT_MESSAGE_TYPE = "gadgets.frontend-error.v1";
const reportingArtifacts = [
  "test-ui.js", "test-ui.js.map", "configurator-runtime.js", "configurator-runtime.js.map",
];

let fixtureDir: string;
let disabledFixtureDir: string;
let devModeFixtureDir: string;
let devEnvWithoutDevFlagFixtureDir: string;

// `envFile` is the `.env.*` file that enables reporting, so which one is written decides which build
// mode picks it up. `staleArtifacts` pre-seeds the outputs a reporting-disabled build must remove.
async function createFixture(prefix: string, { envFile, builderArgs = [], staleArtifacts = false }: {
  envFile?: string;
  builderArgs?: string[];
  staleArtifacts?: boolean;
} = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(directory, "src", "configurator"), { recursive: true });
  if (envFile) {
    await writeFile(join(directory, envFile), "VITE_FRONTEND_ERROR_REPORTING=true\n");
  }
  if (staleArtifacts) {
    await mkdir(join(directory, "src", "generated"), { recursive: true });
    for (const name of reportingArtifacts) {
      await writeFile(join(directory, "src", "generated", name), "stale");
    }
  }
  await writeFile(join(directory, "src", "configurator", "test-ui.tsx"), configuratorSource);
  await execFileAsync(process.execPath, [builder, directory, ...builderArgs]);
  return directory;
}

/** The generated frame's inline scripts: the configurator module, then the runtime. */
async function readScripts(directory: string): Promise<{ module: string; runtime: string }> {
  const html = await readFile(join(directory, "src", "generated", "test-ui.txt"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.equal(scripts.length, 2, "generated HTML should inline the module and the runtime");
  return { module: scripts[0], runtime: scripts[1] };
}

async function assertNoReportingArtifacts(directory: string): Promise<void> {
  for (const name of reportingArtifacts) {
    await assert.rejects(access(join(directory, "src", "generated", name)), { code: "ENOENT" });
  }
}

/** The source map the builder writes beside each configurator artifact. */
interface RawSourceMap {
  /** The original file names the mappings index into. */
  sources: string[];
  /** The VLQ-encoded mappings. */
  mappings: string;
}

/**
 * One mapping as `ts.decodeMappings` yields it. The three source fields are present together or
 * not at all — a mapping with no source describes generated-only output — which is what the
 * predicate in {@link originalPositionFor} narrows on.
 */
interface DecodedMapping {
  generatedLine: number;
  generatedCharacter: number;
  sourceIndex?: number;
  sourceLine?: number;
  sourceCharacter?: number;
}

// `decodeMappings` is part of TypeScript's internal API, so it is absent from the public types.
const decodeMappings = (ts as unknown as {
  decodeMappings(mappings: string): Iterable<DecodedMapping>;
}).decodeMappings;

function originalPositionFor(sourceMap: RawSourceMap, line: number, column: number): {
  source: string;
  line: number;
  column: number;
} {
  const mapping = [...decodeMappings(sourceMap.mappings)]
    .findLast((candidate): candidate is Required<DecodedMapping> =>
      candidate.sourceIndex !== undefined &&
      candidate.generatedLine === line - 1 &&
      candidate.generatedCharacter <= column - 1);
  assert.ok(mapping, "reported position should have a source-map mapping");
  return {
    source: sourceMap.sources[mapping.sourceIndex],
    line: mapping.sourceLine + 1,
    column: mapping.sourceCharacter + 1,
  };
}

before(async () => {
  [fixtureDir, disabledFixtureDir, devModeFixtureDir, devEnvWithoutDevFlagFixtureDir] = await Promise.all([
    createFixture("configurator-reporting-", { envFile: ".env.production" }),
    createFixture("configurator-no-reporting-", { staleArtifacts: true }),
    createFixture("configurator-dev-mode-", { envFile: ".env.development", builderArgs: ["--dev"] }),
    createFixture("configurator-dev-env-oneshot-", { envFile: ".env.development", staleArtifacts: true }),
  ]);
});

after(async () => {
  for (const directory of [fixtureDir, disabledFixtureDir, devModeFixtureDir, devEnvWithoutDevFlagFixtureDir]) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("generated configurator error reporting", () => {
  it("maps executed configurator failures to the original TSX position", async () => {
    const { module } = await readScripts(fixtureDir);
    // Run as the frame runs it: a classic script defining the module, which the runtime then calls.
    const frameGlobal: Record<string, unknown> = { h: () => null };
    runInNewContext(module, frameGlobal);
    const define = frameGlobal.__gadgetsConfiguratorModule;
    assert.equal(typeof define, "function", "the module script should define the module");
    let stack: string | undefined;
    try {
      (define as () => { render(): unknown })().render();
    } catch (error) {
      stack = (error as Error).stack;
    }

    assert.ok(stack, "configurator fixture should throw");
    const frame = stack.match(/app:\/\/\/gatekeeper\/[^/]+\/configurator\/test-ui\.js:(\d+):(\d+)/);
    assert.ok(frame, "stack should contain the configurator virtual source URL");
    const sourceMap: RawSourceMap = JSON.parse(
      await readFile(join(fixtureDir, "src", "generated", "test-ui.js.map"), "utf8"));
    const originalPosition = originalPositionFor(sourceMap, Number(frame[1]), Number(frame[2]));
    const errorOffset = configuratorSource.indexOf("new Error");
    const sourceBeforeError = configuratorSource.slice(0, errorOffset);

    assert.deepEqual(originalPosition, {
      source: `app:///gatekeeper/${basename(fixtureDir)}/configurator/test-ui.tsx`,
      line: sourceBeforeError.split("\n").length,
      column: errorOffset - sourceBeforeError.lastIndexOf("\n"),
    });
  });

  it("emits upload artifacts identical to the scripts the frame runs", async () => {
    const { module, runtime } = await readScripts(fixtureDir);
    const generated = join(fixtureDir, "src", "generated");

    assert.equal(await readFile(join(generated, "test-ui.js"), "utf8"), `${module}\n`);
    assert.equal(await readFile(join(generated, "configurator-runtime.js"), "utf8"), `${runtime}\n`);
    assert.match(runtime, /\/\/# sourceMappingURL=app:\/\/\/gatekeeper\/[^/]+\/configurator\/configurator-runtime\.js\.map$/);
    assert.ok(runtime.includes(REPORT_MESSAGE_TYPE), "the runtime should report to the host");
  });

  it("builds reporting out and removes stale artifacts when reporting is disabled", async () => {
    const { module, runtime } = await readScripts(disabledFixtureDir);

    assert.ok(!runtime.includes(REPORT_MESSAGE_TYPE), "a disabled build should ship no reporting");
    assert.doesNotMatch(`${module}\n${runtime}`, /sourceMappingURL/);
    await assertNoReportingArtifacts(disabledFixtureDir);
  });

  // `--dev` is what the `pnpm dev-server` pre-flight passes so its one-shot build resolves the same
  // env mode the watchers do. If these two ever agreed, the pre-flight's output would differ from the
  // watcher's and Wrangler would restart every gatekeeper worker mid-startup.
  it("reads .env.development when built with --dev", async () => {
    const { runtime } = await readScripts(devModeFixtureDir);

    assert.ok(runtime.includes(REPORT_MESSAGE_TYPE));
    await access(join(devModeFixtureDir, "src", "generated", "test-ui.js"));
    await access(join(devModeFixtureDir, "src", "generated", "test-ui.js.map"));
  });

  it("ignores .env.development without --dev", async () => {
    const { runtime } = await readScripts(devEnvWithoutDevFlagFixtureDir);

    assert.ok(!runtime.includes(REPORT_MESSAGE_TYPE));
    await assertNoReportingArtifacts(devEnvWithoutDevFlagFixtureDir);
  });
});

// The builder reads its env through `loadEnv`, and the Vite+ task that runs it has to declare each
// variable by name: a cached `vp run` executes a task with undeclared vars stripped *and* absent
// from the fingerprint, so an undeclared read is silently `undefined` and a changed value silently
// replays. Nothing else catches that -- the build still succeeds, and the wrong value is baked into
// the generated HTML that ships in the Worker.
//
// Deliberately an exact match rather than a `VITE_*` wildcard on the task. The builder is not vite:
// it transpiles with `ts.transpileModule` and bundles its runtime with a fixed `define`, so no
// configurator or runtime source can read `import.meta.env` and the set of variables that can affect
// its output is closed -- exactly what this assertion pins. A wildcard would instead invalidate every
// configurator build whenever any unrelated `VITE_` var moves (measured on workshop-frontend, whose
// wildcard is right for the opposite reason: vite's `define` inlines any of them, so its set is open).
/**
 * `source` with comments removed, tracking string literals so that one cannot be mistaken for a
 * comment. A regex will not do here: the task below excludes `src/generated` with a glob whose
 * leading wildcards put a slash directly after a star, which
 * `replaceAll(/\/\*[\s\S]*?\*\//g, "")` reads as the start of a block comment and then runs to the
 * end of the next JSDoc -- taking the only `env` declaration in the file with it, so the assertion
 * below would compare the builder's reads against nothing at all and still pass.
 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const start = index++;
      while (index < source.length && source[index] !== char) {
        index += source[index] === "\\" ? 2 : 1;
      }
      out += source.slice(start, ++index);
    } else if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index++;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else {
      out += source[index++];
    }
  }
  return out;
}

/** The declaration of `task` in a Vite+ `tasks` map, from its `{` to the matching `}`. */
function taskDeclaration(configSource: string, task: string): string | null {
  const source = stripComments(configSource);
  const opening = source.match(new RegExp(String.raw`["']${task}["']\s*:\s*\{`));
  if (!opening || opening.index === undefined) return null;
  const start = opening.index + opening[0].length - 1;
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if ("{[(".includes(source[index])) depth++;
    else if ("}])".includes(source[index]) && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

describe("configurator builder env declarations", () => {
  it("declares every VITE_ variable the builder reads on the task that runs it", async () => {
    const configPath = "scripts/gatekeeper-configurator-vite-config.ts";
    const [builderSource, taskConfig] = await Promise.all([
      readFile(builder, "utf8"),
      readFile(resolve(configPath), "utf8"),
    ]);

    // Property accesses only (`loadEnv(...).VITE_X`, `process.env.VITE_X`), so a variable merely
    // named in a comment doesn't register as a read.
    const read = new Set(
      [...builderSource.matchAll(/\.(VITE_[A-Z0-9_]+)/g)].map(match => match[1]));
    assert.ok(read.size > 0, "expected the builder to read at least one VITE_ variable");

    // `build:configurator`'s own `env`, not the union of every task's. `env` is per-task: vp strips
    // whatever the *running* task does not declare, so a declaration on a sibling reaches the builder
    // no better than none at all -- and `build`, one entry below in the same map, runs `tsc` and reads
    // nothing. The union was meant to tolerate the read moving to another task, but it cannot tell
    // that from the declaration drifting away from the task that needs it, which is the actual failure
    // this pins. Which task runs the builder is asserted rather than assumed, so the two cannot
    // separate silently.
    const task = taskDeclaration(taskConfig, "build:configurator");
    assert.ok(task, `expected a \`build:configurator\` task in ${configPath}`);

    // The task reaches the builder by bin name, so the link runs through `scripts/package.json`'s
    // `bin` map rather than being visible in the command string. Resolve it rather than matching the
    // name literally: that way a bin renamed on one side but not the other fails here, and so does a
    // bin quietly re-pointed at a different script.
    const manifest = JSON.parse(await readFile(resolve("scripts/package.json"), "utf8")) as
      { bin: Record<string, string> };
    const builderBins = Object.entries(manifest.bin)
      .filter(([, target]) => resolve("scripts", target) === builder)
      .map(([name]) => name);
    assert.equal(
      builderBins.length, 1,
      `expected exactly one bin in scripts/package.json pointing at ${basename(builder)}, ` +
        `found ${builderBins.length}`);
    assert.ok(
      task.includes(builderBins[0]),
      `${configPath}'s \`build:configurator\` no longer runs ${basename(builder)} (via the ` +
        `\`${builderBins[0]}\` bin), so its \`env\` is not what reaches the builder. Point this ` +
        "assertion at the task that runs it.");

    const declared = new Set(
      [...(task.match(/env:\s*\[([^\]]*)\]/)?.[1] ?? "")
        .matchAll(/["'](VITE_[A-Z0-9_]+)["']/g)].map(match => match[1]));

    assert.deepEqual(
      [...read].toSorted(), [...declared].toSorted(),
      `every VITE_ variable the builder reads must be declared in \`env\` on \`build:configurator\` ` +
        `in ${configPath} (and vice versa -- a stale declaration only adds spurious cache misses)`);
  });
});

/**
 * The packages the builder runs for: any package with a `.tsx` under `src/configurator/`, the glob
 * `buildConfiguratorUIs()` itself reads. Derived rather than listed so a new gatekeeper is covered
 * the day it lands, which is the one most likely to be wired up wrong.
 */
async function configuratorPackages(): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir("packages", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sources =
      await readdir(join("packages", entry.name, "src", "configurator")).catch(() => []);
    if (sources.some(name => name.endsWith(".tsx"))) names.push(entry.name);
  }
  return names;
}

// The module specifier every configurator gatekeeper re-exports the shared tasks from. Shared by
// the routing guard and the SKELETON.md guard below so the docs cannot drift from the requirement.
const SHARED_CONFIGURATOR_SPECIFIER = "@gadgets/scripts/gatekeeper-configurator";

/**
 * The declaration above is worth nothing to a package that never reaches the task, and
 * `env-passthrough.test.ts` cannot see that: it discovers reads per directory, and these packages
 * contain none -- the read lives in the shared builder under `scripts/`.
 *
 * Without the task there is no `env`, so `pnpm build` (`vp run -r --cache build`) runs a plain
 * script in vp's clean environment and bakes the wrong flag in, exit 0. Verified on
 * `gatekeeper-slack`: a local `vp run -F <pkg> build` still looks right, which is the trap.
 */
describe("configurator task wiring", () => {
  it("builds Google's configurators before either supported test route", async () => {
    const manifest = JSON.parse(await readFile(
      "packages/gatekeeper-google/package.json", "utf8",
    ));
    assert.equal(
      manifest.scripts["test:run"],
      "vp run -F @gadgets/google-gatekeeper build:configurator && " +
        "vitest run && vitest run -c vitest.worker.config.ts && " +
        "vitest run -c vitest.docs-worker.config.ts",
    );

    const config = await readFile("packages/gatekeeper-google/vite.config.ts", "utf8");
    assert.match(
      config,
      /test:\s*\{\s*\.\.\.vitestTask\(\[[\s\S]*?\]\),\s*dependsOn:\s*\["build:configurator"\],?\s*\}/,
    );
  });

  it("routes every package the builder builds through the shared task", async () => {
    const names = await configuratorPackages();
    assert.ok(names.length > 0, "expected to find packages with configurator UI sources");

    for (const name of names) {
      const config =
        await readFile(join("packages", name, "vite.config.ts"), "utf8").catch(() => null);
      assert.ok(
        config?.includes(SHARED_CONFIGURATOR_SPECIFIER),
        `packages/${name} has configurator UI sources but no vite.config.ts re-exporting ` +
          `${SHARED_CONFIGURATOR_SPECIFIER}, so it declares no \`build:configurator\` task ` +
          "and `pnpm build` would strip VITE_FRONTEND_ERROR_REPORTING from the builder. Re-export " +
          "the shared config (or declare the task with its own `env` and widen this assertion).");
    }
  });

  // Nothing reads SKELETON.md but a human copying out of it, which is how the specifier there went
  // stale and stayed shippable: the pre-`@gadgets/scripts` relative path still resolves from a real
  // `packages/<name>/` directory, and the `gadgets-*` bins are on PATH via the workspace root, so a
  // generated gatekeeper would build -- on an undeclared dependency -- and then fail the routing
  // guard above. Pinning the copy-paste blocks to the same constant is what makes that impossible.
  it("hands out the shared task specifier the routing guard requires", async () => {
    const skeleton = await readFile(".agents/skills/write-gatekeeper/SKELETON.md", "utf8");

    assert.ok(
      skeleton.includes(SHARED_CONFIGURATOR_SPECIFIER),
      "SKELETON.md's vite.config.ts block must re-export " +
        `${SHARED_CONFIGURATOR_SPECIFIER}, the specifier the routing guard looks for.`);
    assert.doesNotMatch(
      skeleton, /\.\.\/\.\.\/scripts\/gatekeeper-configurator-vite-config/,
      "SKELETON.md still hands out the pre-@gadgets/scripts relative path to the shared config.");
    assert.match(
      skeleton, /"@gadgets\/scripts":\s*"workspace:\*"/,
      "SKELETON.md must show @gadgets/scripts in the new package's devDependencies: its bins are " +
        "on PATH from the workspace root, so leaving it undeclared works until it doesn't.");
  });

  // deploy-scripts.test.ts holds the two general deploy invariants. Both pass vacuously on a
  // `deploy` that never runs the codegen at all -- it contains no `vp run` to want `--no-cache`
  // and no builder filename to reject -- so the configurator-specific third one lives here.
  it("runs the codegen task from every configurator gatekeeper's deploy", async () => {
    for (const name of await configuratorPackages()) {
      const manifest = JSON.parse(await readFile(join("packages", name, "package.json"), "utf8"));
      const command = manifest.scripts?.deploy ?? "";
      assert.match(
        command, /vp run [^&]*build:configurator/,
        `packages/${name} deploys without running \`build:configurator\`: ` +
          `${command || "(no deploy script)"}\nwrangler bundles src/generated/ from disk, so a ` +
          "deploy that skips the codegen ships whatever the last build happened to leave there.");
    }
  });
});
