import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import ts from "typescript6"; // JS compiler API (decodeMappings); see build-gatekeeper-configurator.mjs

const execFileAsync = promisify(execFile);
const builder = resolve("scripts/build-gatekeeper-configurator.mjs");
const configuratorSource =
  'import { h } from "@gadgets/configurator-ui";\n' +
  'export default { render() { throw new Error("mapped configurator failure"); return <div />; } };\n';
let fixtureDir;
let disabledFixtureDir;
let devModeFixtureDir;
let devEnvWithoutDevFlagFixtureDir;

// `envFile` is the `.env.*` file that enables reporting, so which one is written decides which build
// mode picks it up. `staleArtifacts` pre-seeds the outputs a reporting-disabled build must remove.
async function createFixture(prefix, { envFile, builderArgs = [], staleArtifacts = false } = {}) {
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

async function readRuntime(directory) {
  const html = await readFile(join(directory, "src", "generated", "test-ui.txt"), "utf8");
  const match = html.match(
    /<script type="module" src="data:text\/javascript;charset=utf-8,([^"]+)"/);
  assert.ok(match, "generated HTML should contain its runtime module");
  return decodeURIComponent(match[1]);
}

function readConfiguratorModule(runtime) {
  const match = runtime.match(/new Function\(("(?:\\.|[^"\\])*")\)/);
  assert.ok(match, "generated runtime should embed the configurator module");
  return JSON.parse(match[1]);
}

function readRuntimeFunctions(runtime, ...names) {
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

function originalPositionFor(sourceMap, line, column) {
  const mapping = [...ts.decodeMappings(sourceMap.mappings)]
    .findLast(candidate =>
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
    let stack;
    try {
      // The generated source is trusted build output and production executes it the same way.
      // oxlint-disable-next-line no-new-func
      const configuratorModule = new Function(moduleCode)();
      configuratorModule.render();
    } catch (error) {
      stack = error.stack;
    }

    assert.ok(stack, "configurator fixture should throw");
    const frame = stack.match(/app:\/\/\/gatekeeper\/[^/]+\/configurator\/test-ui\.js:(\d+):(\d+)/);
    assert.ok(frame, "stack should contain the configurator virtual source URL");
    const sourceMap = JSON.parse(
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
