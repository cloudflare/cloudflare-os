import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELAY = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "relay-termination.ts"));

// Fixture wrappers go under the OS temp directory, never in the workspace: this suite's `input` is
// workspace-wide (see `scripts/vite.config.ts`), so writing in here would be writing its own task
// input. Same discipline as `bin-entry.test.ts`.
const fixtureRoot = mkdtempSync(join(tmpdir(), "relay-termination-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

let caseCount = 0;

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitUntilGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

// A marker file is the only channel a fixture with `stdio: "ignore"` has back to this suite, so both
// the readiness handshake and the cleanup case below signal through one.
async function waitForFile(path: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

const IDLE = "setTimeout(() => {}, 60_000)";
// Whatever survives the forwarded signal is what the escalation exists for.
const IGNORES_SIGNALS =
    "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); " + IDLE;

// Counts the SIGINTs this process *acts on* and reports each one, so a test can tell how many
// distinct arrivals a descendant saw. Stays alive afterwards: what matters is the count, and dying
// on the first one would hide any second.
const COUNTS_SIGINTS =
    "let n = 0; process.on('SIGINT', () => process.stdout.write('sigint ' + ++n + '\\n')); " + IDLE;

/** How long the cleanup fixture below spends handling its SIGTERM. */
const CLEANUP_MS = 400;

// A descendant with real cleanup to do: it handles SIGTERM, spends `CLEANUP_MS` on it, and records
// that it got to the end by writing `markerFile`. Absent that marker, it was SIGKILLed part-way.
const cleansUpSlowly = (markerFile: string) =>
    "process.on('SIGTERM', () => setTimeout(() => { " +
    `require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, ''); process.exit(0); ` +
    `}, ${CLEANUP_MS})); ` + IDLE;

interface Wrapper {
  /** The process under test: it spawns `child`, which spawns `grandchild`, then relays. */
  wrapperPid: number;
  childPid: number;
  grandchildPid: number;
  /** The wrapper's own termination, as the OS reported it. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Everything the wrapper and child have written to stdout so far. */
  output: () => string;
  /** Resolves once `pattern` shows up in that output, or `false` if the stream ends first. */
  waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<boolean>;
  cleanUp: () => void;
}

/**
 * A `vp run`-shaped tree under `relayTermination`: the wrapper spawns a child, which spawns an idle
 * grandchild -- the descendant that a signal delivered only to the wrapper would orphan. Both pids
 * come back over the wrapper's stdout, since that is the only handle a caller has on them.
 *
 * `childBody` is a `node -e` body evaluated in the child; `grandchildBody` in the grandchild.
 *
 * `detached` makes the wrapper a process group leader, so `process.kill(-wrapperPid, ...)` reaches
 * the whole tree at once -- the only way to emulate what a tty does on Ctrl-C without one.
 */
async function spawnWrapper(
  { grandchildBody = IDLE, childBody = IDLE, graceMs, detached = false }: {
    grandchildBody?: string;
    childBody?: string;
    graceMs?: number;
    detached?: boolean;
  } = {},
): Promise<Wrapper> {
  const dir = join(fixtureRoot, `case-${++caseCount}`);
  mkdirSync(dir, { recursive: true });

  // Touched by the grandchild once its body has run, and waited on below before any case signals
  // anything. Its stdio is "ignore", so a file is the only channel it has -- and a group-delivered
  // signal is fast enough to beat `node -e` to installing its handlers, which made a grandchild
  // that is supposed to ignore signals die of the default disposition instead. That race decided
  // the outcome of the group-delivery cases, so readiness is a precondition, not a sleep.
  const readyFile = join(dir, "grandchild-ready");
  const grandchildProgram =
      `${grandchildBody};require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "")`;

  // The child prints its grandchild's pid; the wrapper forwards that line on and adds its own pid,
  // so one stdout stream carries all three.
  const child = join(dir, "child.mjs");
  writeFileSync(child, `
    import { spawn } from "node:child_process";
    const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}],
        { stdio: "ignore" });
    process.stdout.write("grandchild " + grandchild.pid + "\\n");
    ${childBody}
  `);

  const wrapper = join(dir, "wrapper.mjs");
  writeFileSync(wrapper, `
    import { spawn } from "node:child_process";
    import { relayTermination } from ${JSON.stringify(RELAY.href)};
    const child = spawn(process.execPath, [${JSON.stringify(child)}],
        { stdio: ["ignore", "inherit", "ignore"] });
    process.stdout.write("child " + child.pid + "\\n");
    relayTermination(child${graceMs === undefined ? "" : `, { graceMs: ${graceMs} }`});
  `);

  const proc = spawn(process.execPath, [wrapper], { stdio: ["ignore", "pipe", "inherit"], detached });
  const wrapperPid = proc.pid;
  assert.ok(wrapperPid, "the wrapper was not spawned");

  let childPid = 0;
  let grandchildPid = 0;
  // Unconditional, and by pid rather than through the wrapper: once the wrapper dies its
  // descendants reparent away from it, so a leak could not be found later. `node --test` stays
  // alive as long as any spawned process does.
  const cleanUp = () => {
    for (const pid of [wrapperPid, childPid, grandchildPid]) {
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  };

  // Attached before the pids are read, so an exit that races the handshake still settles it.
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });

  // Accumulated by a listener rather than consumed with `for await`, because the cases below read
  // this stream *after* the pid handshake -- an async iterator abandoned mid-stream would leave
  // whatever the child printed on being signalled unread.
  let text = "";
  let ended = false;
  proc.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  proc.stdout.on("close", () => { ended = true; });

  const output = () => text;
  const waitForOutput = async (pattern: RegExp, timeoutMs = 10_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(text)) {
      if (ended || Date.now() >= deadline) return pattern.test(text);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return true;
  };

  try {
    assert.ok(await waitForOutput(/^grandchild \d+$/m), "the wrapper never reported both pids");
    childPid = Number(/^child (\d+)$/m.exec(text)?.[1] ?? 0);
    grandchildPid = Number(/^grandchild (\d+)$/m.exec(text)?.[1] ?? 0);
    assert.ok(childPid && grandchildPid, "the wrapper never reported both pids");

    assert.ok(await waitForFile(readyFile), "the grandchild never finished starting up");
  } catch (error) {
    cleanUp();
    throw error;
  }
  return { wrapperPid, childPid, grandchildPid, exit, output, waitForOutput, cleanUp };
}

// Concurrent for the reason `kill-process-tree.test.ts` is: these cases spend their time waiting on
// signalled processes to go away, not doing work. Each addresses its own tree by pid.
describe("relayTermination", {
  concurrency: true,
  skip: process.platform === "win32" ? "the relay and these signal fixtures are POSIX-only" : false,
}, () => {
  // The bug this exists for: signalled at the wrapper alone -- `kill`, a process manager, a CI job
  // cancellation -- the old code died on the spot and left the whole tree below it running.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`forwards ${signal} to the whole tree and re-raises it`, async () => {
      const { wrapperPid, childPid, grandchildPid, exit, cleanUp } = await spawnWrapper();
      try {
        process.kill(wrapperPid, signal);
        assert.ok(await waitUntilGone(childPid), "the child outlived the forwarded signal");
        assert.ok(await waitUntilGone(grandchildPid), "the grandchild was orphaned");
        // The parent shell has to see the same termination it would have from the child itself.
        assert.deepEqual(await exit, { code: null, signal });
      } finally {
        cleanUp();
      }
    });
  }

  it("reaches a descendant that ignores the forwarded signal, via the escalation", async () => {
    const { wrapperPid, grandchildPid, exit, cleanUp } =
        await spawnWrapper({ grandchildBody: IGNORES_SIGNALS, graceMs: 250 });
    try {
      process.kill(wrapperPid, "SIGTERM");
      // The wrapper must outlive the tree it is responsible for: by the time it exits, the SIGKILL
      // the stubborn grandchild needed has been delivered. Asserted in this order because the
      // fixture idles for 60s -- awaiting the exit first would also be satisfied by that timer
      // simply running out, which is not the escalation doing its job.
      assert.ok(await waitUntilGone(grandchildPid), "the grandchild survived the escalation");
      assert.deepEqual(await exit, { code: null, signal: "SIGTERM" });
    } finally {
      cleanUp();
    }
  });

  // The grace belongs to the tree, not to the direct child. `childBody` stays at IDLE so the child
  // dies the instant the forwarded signal lands, which is the trigger the bug hung off: the relay
  // used to abort its own escalation from the child's `exit` handler, dropping straight to SIGKILL
  // and leaving this grandchild whatever the child's exit latency happened to be (~70ms observed) of
  // the 400ms it needs -- no matter what `graceMs` said. 3000ms here is well clear of the 400, so a
  // missing marker means the window was collapsed rather than merely tight.
  it("gives a descendant the full grace after the child has already exited", async () => {
    const cleaned = join(fixtureRoot, "grandchild-cleaned");
    const { wrapperPid, grandchildPid, exit, cleanUp } = await spawnWrapper(
        { grandchildBody: cleansUpSlowly(cleaned), graceMs: 3_000 });
    try {
      process.kill(wrapperPid, "SIGTERM");
      assert.ok(await waitUntilGone(grandchildPid), "the grandchild outlived the forwarded signal");
      // Read after the grandchild is gone, so it needs no wait of its own: the marker is written
      // before that process exits, and its absence therefore means a SIGKILL got there first.
      assert.ok(existsSync(cleaned), "the grandchild was SIGKILLed before it finished cleaning up");
      assert.deepEqual(await exit, { code: null, signal: "SIGTERM" });
    } finally {
      cleanUp();
    }
  });

  // Ctrl-C at a tty is delivered by the OS to every process in the foreground group, so the relay
  // is not the only deliverer -- `detached` plus a negative pid is that broadcast, minus the tty.
  // What the broadcast does not cover is a descendant that ignores it, which still has to be
  // reaped, and the wrapper still has to outlive the reaping.
  //
  // Both fixture processes hold on to model the real children: `vp run` and run-dev-server.ts each
  // handle the interrupt and shut down over some hundreds of ms. That is load-bearing rather than
  // incidental -- the relay reaches a grandchild only through `collectTree(child.pid)`, so a child
  // that dies the instant the broadcast lands reparents its descendants to init before the walk
  // runs, and no supervisor can find them afterwards (kill-process-tree.ts documents the same
  // ordering hazard). On the tty path such a descendant has had the signal delivered to it directly
  // anyway; the relay's job is the one that ignores it.
  it("still reaps a stubborn grandchild when the signal is group-delivered", async () => {
    const { wrapperPid, grandchildPid, exit, cleanUp } = await spawnWrapper(
        { childBody: IGNORES_SIGNALS, grandchildBody: IGNORES_SIGNALS, graceMs: 250,
          detached: true });
    try {
      process.kill(-wrapperPid, "SIGINT");
      // Reaping is asserted before the exit, and the order is what makes this a regression test
      // rather than a coincidence: these fixtures idle for 60s, so waiting on the wrapper first
      // would let a relay that never reaped anything still pass once the idle timers ran out.
      // It is also the real ordering -- the relay awaits its escalation before exiting.
      assert.ok(await waitUntilGone(grandchildPid), "the grandchild survived the group broadcast");
      assert.deepEqual(await exit, { code: null, signal: "SIGINT" });
    } finally {
      cleanUp();
    }
  });

  // Characterises the delivery this relay cannot avoid, and which run-dev-server.ts's shutdown is
  // written against: on the group-delivered path a descendant receives the *same* interrupt twice
  // -- once from the broadcast, once forwarded by the relay -- and nothing in the tree can tell the
  // repeat from a fresh Ctrl-C (POSIX exposes no `siginfo.si_code` to Node). A receiver must
  // therefore stay correct when its signal count overstates how many times the user acted; the
  // guarantees that matter are the deadline-based ones, never the count. If a future change makes
  // the relay skip forwarding, this is the test that says the assumption moved.
  it("delivers one group-broadcast interrupt to a descendant twice", async () => {
    const { wrapperPid, waitForOutput, output, cleanUp } = await spawnWrapper(
        { childBody: COUNTS_SIGINTS, graceMs: 5_000, detached: true });
    try {
      process.kill(-wrapperPid, "SIGINT");
      assert.ok(await waitForOutput(/^sigint 2$/m),
          `the child saw only one arrival, so the relay stopped forwarding: ${output()}`);
    } finally {
      cleanUp();
    }
  });

  it("forwards the child's own exit code when nothing signalled us", async () => {
    const { exit, cleanUp } = await spawnWrapper({ childBody: "process.exit(37)" });
    try {
      assert.deepEqual(await exit, { code: 37, signal: null });
    } finally {
      cleanUp();
    }
  });

  it("re-raises the signal that killed the child", async () => {
    const { childPid, exit, cleanUp } = await spawnWrapper();
    try {
      process.kill(childPid, "SIGTERM");
      assert.deepEqual(await exit, { code: null, signal: "SIGTERM" });
    } finally {
      cleanUp();
    }
  });
});
