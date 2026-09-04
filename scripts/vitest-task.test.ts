import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import {
  TESTS_WITH_TIMEOUT_ENV,
  vitestTask,
  withTestTimeout,
} from "./vitest-task-vite-config.ts";

// Like its siblings, this suite runs from the repo root (`cwd: '..'` in `scripts/vite.config.ts`),
// so the configs and the watchdog are named from there.
const WITH_TIMEOUT = "scripts/with-timeout.ts";
const HAND_DECLARED_CONFIGS = [
  "packages/workshop-backend/vite.config.ts",
  "packages/integration-tests/vite.config.ts",
  "scripts/vite.config.ts",
];

const [DISABLE_VAR] = TESTS_WITH_TIMEOUT_ENV;

type Task = { command: string | string[]; cache?: boolean; env?: string[] };

/** Every task in a config whose command -- or any element of an array command -- is watchdogged. */
async function watchdoggedTasksIn(config: string): Promise<[string, Task][]> {
  const { default: loaded } = await import(`../${config}`) as
    { default: { run: { tasks: Record<string, Task> } } };
  return Object.entries(loaded.run.tasks).filter(([, task]) =>
    [task.command].flat().some(command => command.startsWith("gadgets-with-timeout")));
}

/** Runs the watchdog over a child that stays quiet for `sleepMs`, with `env` added to the child's. */
function runWatchdog(
  idle: number, max: number, sleepMs: number, env: Record<string, string>,
): Promise<{ code: number | null; elapsedMs: number }> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    // Not inherited: under `TESTS_WITH_TIMEOUT_DISABLE=1 vp run …` this suite itself runs disabled,
    // and the enabled case has to arm the watchdog regardless.
    const childEnv = { ...process.env, ...env };
    if (!(DISABLE_VAR in env)) delete childEnv[DISABLE_VAR];
    const child = spawn(
      process.execPath,
      [WITH_TIMEOUT, "--idle", String(idle), "--max", String(max), "--",
        "node", "-e", `setTimeout(() => {}, ${sleepMs})`],
      { stdio: "ignore", env: childEnv });
    child.on("close", code => resolve({ code, elapsedMs: Date.now() - startedAt }));
  });
}

describe("withTestTimeout", () => {
  it("wraps a bare command in the default thresholds", () => {
    assert.equal(
      withTestTimeout("vitest run"),
      "gadgets-with-timeout --idle 60 --max 600 -- vitest run");
  });

  it("lets the object form raise only the idle threshold", () => {
    assert.equal(
      withTestTimeout({ command: "vitest run", idleSeconds: 120 }),
      "gadgets-with-timeout --idle 120 --max 600 -- vitest run");
  });

  it("never lets a command override the wall-clock backstop", () => {
    // The type has no such field; this pins the runtime shape against a future one.
    const wrapped = withTestTimeout(
      { command: "vitest run", idleSeconds: 30, maxSeconds: 5 } as never);
    assert.match(wrapped, / --max 600 -- /);
  });
});

describe("the watchdog off switch", () => {
  it("is declared in env on every generated test task", () => {
    assert.ok(vitestTask("vitest run").env.includes(DISABLE_VAR));
  });

  it("reaches every hand-declared cached task that wraps the watchdog", async () => {
    let seen = 0;
    for (const config of HAND_DECLARED_CONFIGS) {
      for (const [name, task] of await watchdoggedTasksIn(config)) {
        seen++;
        assert.ok(
          task.cache === false || task.env?.includes(DISABLE_VAR),
          `${config} task "${name}" wraps gadgets-with-timeout but is cached without declaring ` +
            `${DISABLE_VAR} in env, so a cached run strips the switch.`);
      }
    }
    // A config that stopped exporting its tasks would otherwise pass vacuously.
    assert.ok(seen >= 3, `expected at least 3 watchdogged tasks across the configs, found ${seen}`);
  });

  // The two behavioural cases assert the presence or absence of a kill with a 5x margin, not a
  // timing window: a child that sleeps 1.5s under a 0.3s idle threshold is killed, and with the
  // switch set the same child runs to completion.
  it("kills a silent child when unset", async () => {
    const { code } = await runWatchdog(0.3, 0.6, 1500, {});
    assert.equal(code, 124);
  });

  it("lets the child run to completion when set", async () => {
    const { code, elapsedMs } = await runWatchdog(0.3, 0.6, 1500, { [DISABLE_VAR]: "1" });
    assert.equal(code, 0);
    assert.ok(elapsedMs >= 1400, `child finished after ${elapsedMs}ms, so it was cut short`);
  });
});
