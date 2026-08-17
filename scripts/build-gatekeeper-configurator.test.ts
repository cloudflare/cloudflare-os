import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import ts from "typescript6"; // JS compiler API (decodeMappings); see build-gatekeeper-configurator.ts

const execFileAsync = promisify(execFile);
const builder = resolve("scripts/build-gatekeeper-configurator.ts");
const configuratorSource =
  'import { h } from "@gadgets/configurator-ui";\n' +
  'export default { render() { throw new Error("mapped configurator failure"); return <div />; } };\n';
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
  await mkdir(join(directory, "node_modules", "capnweb", "dist"), { recursive: true });
  if (envFile) {
    await writeFile(join(directory, envFile), "VITE_FRONTEND_ERROR_REPORTING=true\n");
  }
  if (staleArtifacts) {
    await mkdir(join(directory, "src", "generated"), { recursive: true });
    await writeFile(join(directory, "src", "generated", "test-ui.js"), "stale");
    await writeFile(join(directory, "src", "generated", "test-ui.js.map"), "stale");
  }
  await writeFile(join(directory, "node_modules", "capnweb", "dist", "index.js"),
    "export class RpcTarget {}\nexport function newMessagePortRpcSession() {}\n");
  await writeFile(join(directory, "src", "configurator", "test-ui.tsx"), configuratorSource);
  await execFileAsync(process.execPath, [builder, directory, ...builderArgs]);
  return directory;
}

async function readRuntime(directory: string): Promise<string> {
  const html = await readFile(join(directory, "src", "generated", "test-ui.txt"), "utf8");
  const match = html.match(
    /<script type="module" src="data:text\/javascript;charset=utf-8,([^"]+)"/);
  assert.ok(match, "generated HTML should contain its runtime module");
  return decodeURIComponent(match[1]);
}

function readConfiguratorModule(runtime: string): string {
  const match = runtime.match(/new Function\(("(?:\\.|[^"\\])*")\)/);
  assert.ok(match, "generated runtime should embed the configurator module");
  return JSON.parse(match[1]);
}

/**
 * The named functions from the generated runtime, evaluated in isolation. Typed loosely on purpose:
 * these are read back out of build output, so their real signatures live in the builder.
 */
function readRuntimeFunctions(
  runtime: string,
  ...names: string[]
): Record<string, (...args: any[]) => any> {
  const constants = [...runtime.matchAll(/^const [A-Z_]+ = .*;$/gm)].map(match => match[0]);
  const definitions = names.map(name => {
    const match = runtime.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(match, `generated runtime should define ${name}`);
    return match[0];
  });
  // The generated runtime is trusted build output and production executes the same function.
  // oxlint-disable-next-line no-new-func
  return new Function(
    `${constants.join("\n")}\n${definitions.join("\n")}\nreturn { ${names.join(", ")} };`)();
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
  fixtureDir = await createFixture("configurator-reporting-", { envFile: ".env.production" });
  disabledFixtureDir = await createFixture("configurator-no-reporting-", { staleArtifacts: true });
  devModeFixtureDir = await createFixture("configurator-dev-mode-",
    { envFile: ".env.development", builderArgs: ["--dev"] });
  devEnvWithoutDevFlagFixtureDir = await createFixture("configurator-dev-env-oneshot-",
    { envFile: ".env.development", staleArtifacts: true });
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
  await rm(disabledFixtureDir, { recursive: true, force: true });
  await rm(devModeFixtureDir, { recursive: true, force: true });
  await rm(devEnvWithoutDevFlagFixtureDir, { recursive: true, force: true });
});

describe("generated configurator error reporting", () => {
  it("maps executed configurator failures to the original TSX position", async () => {
    const runtime = await readRuntime(fixtureDir);
    const moduleCode = readConfiguratorModule(runtime);
    let stack: string | undefined;
    try {
      // The generated source is trusted build output and production executes it the same way.
      // oxlint-disable-next-line no-new-func
      const configuratorModule = new Function(moduleCode)();
      configuratorModule.render();
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

  it("emits an upload artifact aligned with the executed virtual source", async () => {
    const runtime = await readRuntime(fixtureDir);
    const moduleCode = readConfiguratorModule(runtime);
    const artifact = await readFile(
      join(fixtureDir, "src", "generated", "test-ui.js"), "utf8");

    assert.equal(artifact, `\n\n${moduleCode}\n`);
  });

  it("uses the shared bounded exception serializer before posting", async () => {
    const runtime = await readRuntime(fixtureDir);
    const dataModules = [...runtime.matchAll(/base64,([A-Za-z0-9+/=]+)/g)]
      .map(match => Buffer.from(match[1], "base64").toString("utf8"));
    const serializerSource = dataModules.find(source => source.includes("serializeException"));
    assert.ok(serializerSource, "generated runtime should embed the shared serializer");

    const serializer = await import(
      `data:text/javascript;base64,${Buffer.from(serializerSource).toString("base64")}`);
    const error = new Error("m".repeat(2_000));
    error.name = "n".repeat(300);
    error.stack = "s".repeat(20_000);
    const exception = serializer.serializeException(error);

    assert.equal(exception.type.length, 256);
    assert.equal(exception.message.length, 1_024);
    assert.equal(exception.stack.length, 16_384);
    assert.equal(exception.truncated, true);
  });

  it("reports handled option-loading failures", async () => {
    const runtime = await readRuntime(fixtureDir);

    assert.match(runtime, /reportFrontendIssue\("configurator\.checkbox-list-load", error\)/);
    assert.match(runtime, /reportFrontendIssue\("configurator\.autocomplete-load", error\)/);
    assert.match(runtime, /reportFrontendIssue\("configurator\.initial-resource-load", error\)/);
    assert.match(runtime, /reportFrontendIssue\("configurator\.initial-values-load", error\)/);
  });

  it("disables reporting and removes source-map artifacts when reporting is disabled", async () => {
    const generatedDir = join(disabledFixtureDir, "src", "generated");
    const runtime = await readRuntime(disabledFixtureDir);

    assert.match(runtime, /const frontendReportingEnabled = false;/);
    assert.doesNotMatch(runtime, /sourceURL=.*serialize-exception/);
    await assert.rejects(access(join(generatedDir, "test-ui.js")), { code: "ENOENT" });
    await assert.rejects(access(join(generatedDir, "test-ui.js.map")), { code: "ENOENT" });
  });

  // `--dev` is what the `pnpm dev-server` pre-flight passes so its one-shot build resolves the same
  // env mode the watchers do. If these two ever agreed, the pre-flight's output would differ from the
  // watcher's and Wrangler would restart every gatekeeper worker mid-startup.
  it("reads .env.development when built with --dev", async () => {
    const runtime = await readRuntime(devModeFixtureDir);

    assert.match(runtime, /const frontendReportingEnabled = true;/);
    // The serializer's own sourceURL is inside its base64 data module, not the runtime text, so the
    // import is what is visible here.
    assert.match(runtime, /import \{ serializeException \} from "data:text\/javascript/);
    await access(join(devModeFixtureDir, "src", "generated", "test-ui.js"));
    await access(join(devModeFixtureDir, "src", "generated", "test-ui.js.map"));
  });

  it("ignores .env.development without --dev", async () => {
    const generatedDir = join(devEnvWithoutDevFlagFixtureDir, "src", "generated");
    const runtime = await readRuntime(devEnvWithoutDevFlagFixtureDir);

    assert.match(runtime, /const frontendReportingEnabled = false;/);
    assert.doesNotMatch(runtime, /sourceURL=.*serialize-exception/);
    await assert.rejects(access(join(generatedDir, "test-ui.js")), { code: "ENOENT" });
    await assert.rejects(access(join(generatedDir, "test-ui.js.map")), { code: "ENOENT" });
  });
});

describe("generated configurator option sanitizing", () => {
  it("truncates an overflowing suggestion list but refuses an overflowing grant list", async () => {
    const { sanitizeOptions } = readRuntimeFunctions(
      await readRuntime(fixtureDir), "optionText", "sanitizeOptions");
    const options = Array.from({ length: 201 }, (_, index) => ({
      value: `tool-${index}`,
      title: `Tool ${index}`,
    }));

    assert.equal(sanitizeOptions(options, "truncate").length, 200);
    assert.throws(() => sanitizeOptions(options, "refuse"), /at most 200 options/i);
  });

  it("keeps every option when the list is within the limit", async () => {
    const { sanitizeOptions } = readRuntimeFunctions(
      await readRuntime(fixtureDir), "optionText", "sanitizeOptions");
    const options = Array.from({ length: 200 }, (_, index) => ({
      value: `tool-${index}`,
      title: `Tool ${index}`,
    }));

    assert.equal(sanitizeOptions(options).length, options.length);
  });

  it("keeps stale selections visible so they can be cleared", async () => {
    const { withUnavailableOptions } = readRuntimeFunctions(
      await readRuntime(fixtureDir), "splitList", "withUnavailableOptions");
    assert.deepEqual(withUnavailableOptions(
      [{ value: "current", title: "Current" }], "current,removed"), [
      { value: "current", title: "Current" },
      { value: "removed", title: "removed (unavailable)" },
    ]);
  });

  it("presents every option as selected when requested", async () => {
    const { checkboxSelection } = readRuntimeFunctions(
      await readRuntime(fixtureDir), "splitList", "checkboxSelection");
    assert.deepEqual(
        [...checkboxSelection([{ value: "read" }, { value: "write" }], null, true)],
        ["read", "write"]);
  });

  it("only blocks failed checkbox lists that are enabled", async () => {
    const { hasBlockingCheckboxFailure } = readRuntimeFunctions(
      await readRuntime(fixtureDir), "hasBlockingCheckboxFailure");
    assert.equal(hasBlockingCheckboxFailure({ tools: { status: "failed", disabled: true } }), false);
    assert.equal(hasBlockingCheckboxFailure({ tools: { status: "failed", disabled: false } }), true);
  });

  it("prunes checkbox lists absent from the current render", async () => {
    const { pruneCheckboxEntries } = readRuntimeFunctions(
      await readRuntime(fixtureDir), "pruneCheckboxEntries");
    const entries = {
      "tools:old": { status: "failed", disabled: false },
      "tools:new": { status: "ready", disabled: false },
    };
    pruneCheckboxEntries(entries, new Set(["tools:new"]));
    assert.deepEqual(entries, { "tools:new": { status: "ready", disabled: false } });
  });
});

// The builder reads its env through `loadEnv`, and the Vite+ task that runs it has to declare each
// variable by name: a cached `vp run` executes a task with undeclared vars stripped *and* absent
// from the fingerprint, so an undeclared read is silently `undefined` and a changed value silently
// replays. Nothing else catches that -- the build still succeeds, and the wrong value is baked into
// the generated HTML that ships in the Worker.
//
// Deliberately an exact match rather than a `VITE_*` wildcard on the task. The builder is not vite:
// it transpiles with `ts.transpileModule` and has no `define` pass, so no configurator source can
// read `import.meta.env` and the set of variables that can affect its output is closed -- exactly
// what this assertion pins. A wildcard would instead invalidate all 13 configurator builds whenever
// any unrelated `VITE_` var moves (measured on workshop-frontend, whose wildcard is right for the
// opposite reason: vite's `define` inlines any of them, so its set is open).
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
    assert.ok(
      task.includes(basename(builder)),
      `${configPath}'s \`build:configurator\` no longer runs ${basename(builder)}, so its \`env\` ` +
        "is not what reaches the builder. Point this assertion at the task that runs it.");

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
  it("routes every package the builder builds through the shared task", async () => {
    const names = await configuratorPackages();
    assert.ok(names.length > 0, "expected to find packages with configurator UI sources");

    for (const name of names) {
      const config =
        await readFile(join("packages", name, "vite.config.ts"), "utf8").catch(() => null);
      assert.ok(
        config?.includes("gatekeeper-configurator-vite-config"),
        `packages/${name} has configurator UI sources but no vite.config.ts re-exporting ` +
          "gatekeeper-configurator-vite-config, so it declares no `build:configurator` task and " +
          "`pnpm build` would strip VITE_FRONTEND_ERROR_REPORTING from the builder. Re-export the " +
          "shared config (or declare the task with its own `env` and widen this assertion).");
    }
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
