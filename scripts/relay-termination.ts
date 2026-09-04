// Termination relay for the thin wrappers that exist only to spawn one child (`vp/run.ts`,
// `run-local.ts`).
//
// Mirroring the child's exit is the easy half, and on its own it leaves a hole: a wrapper with no
// signal handlers takes Node's default disposition, so a SIGINT or SIGTERM sent *to the wrapper* --
// `kill`, a process manager, a CI job cancellation -- kills the wrapper outright and never reaches
// the child. Ctrl-C at a tty happens to work, because the tty delivers the signal to the whole
// foreground process group; nothing else does. What survives is the entire task graph below the
// child: for `vp run` that is the bin-entry wrappers, vitest pools and workerd fleets, and for
// `run-local` it is run-dev-server, wrangler and its workerd children. They keep the machine busy,
// hold ports, and can no longer be found from the wrapper's pid once it is gone.
//
// So the signal is forwarded to the child's whole process *tree* (`killProcessTree`'s reason for
// existing: signalling only the direct child leaves its descendants alive, and the tree has to be
// collected before anything is signalled or the reparented survivors become unreachable), the
// wrapper waits for that tree to be gone, and only then reproduces the termination on itself so the
// parent shell sees what it would have seen from the child directly.

import type { ChildProcess } from "node:child_process";
import { killProcessTreeEscalating } from "./kill-process-tree.ts";

/** Matches `FORCE_KILL_GRACE_MS` in run-dev-server.ts and build-release.ts. */
const DEFAULT_GRACE_MS = 10_000;

/**
 * Wires `child` up as this process's only child: forwards SIGINT/SIGTERM to its whole process tree,
 * waits for the tree to be gone, then exits the way the child did.
 *
 * The wrapper may therefore outlive `child` by up to `graceMs`, and that is part of its contract:
 * the escalation's grace belongs to the tree, not to the direct child, so a descendant still gets
 * its full cleanup window after the child itself has exited. A second signal collapses it.
 *
 * Deliberately adds no `error` listener, so a spawn that fails keeps Node's loud uncaught-error
 * behaviour instead of hanging on an `exit` event that will never arrive.
 */
export function relayTermination(child: ChildProcess, { graceMs = DEFAULT_GRACE_MS }: {
  graceMs?: number;
} = {}): void {
  const force = new AbortController();
  let escalation: Promise<void> | null = null;
  let forwarded: NodeJS.Signals | null = null;

  function onSignal(signal: NodeJS.Signals): void {
    // A second signal gives up the rest of the grace period and escalates now: a task that ignores
    // the interrupt must not make Ctrl-C feel like a hang (with-timeout.ts has the same rationale).
    if (escalation) {
      force.abort();
      return;
    }
    forwarded = signal;
    if (child.pid === undefined) return;
    // The signal the caller sent, not a SIGTERM of our own: in the Ctrl-C case the child already
    // received SIGINT via the process group, and a SIGTERM here would cut its handling short.
    escalation = killProcessTreeEscalating(
        child.pid, { initialSignal: signal, graceMs, forceSignal: force.signal });
  }

  // Kept by reference so they can be removed individually below -- `removeAllListeners` would take
  // out any handler the calling script installed for its own reasons.
  const handlers = (["SIGINT", "SIGTERM"] as const).map(signal => {
    const handler = () => onSignal(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  child.on("exit", (code, childSignal) => {
    void (async () => {
      if (escalation) {
        // Awaited, not aborted, and the two are separate decisions. Awaited because the child being
        // gone does not mean its descendants are, and that promise holds the only usable list of
        // their pids (kill-process-tree.ts documents that abandoning it mid-grace leaks them) --
        // this is what makes the wrapper outlive the tree it is responsible for.
        //
        // Not aborted because the grace is the contract: `graceMs` was sized to nest over
        // with-timeout.ts's own 5s shutdown attempt, and collapsing it here on the *direct child's*
        // exit would give a descendant with real cleanup to do only however long the child happened
        // to take to die. The escalation is bounded either way by its own deadline, so the wait is
        // at most `graceMs` and only when survivors are genuinely stubborn. `onSignal` above is the
        // one thing entitled to cut it short, on a real second signal.
        await escalation;
      }

      // The forwarded signal takes priority over the child's: the child may well have died from our
      // own escalation's SIGKILL, and reporting *that* to the shell in place of the SIGINT the user
      // sent would be wrong.
      const raised = forwarded ?? childSignal;
      if (!raised) process.exit(code ?? 0);

      // Removing the last listener for a signal restores Node's default disposition, so re-raising
      // terminates this process rather than re-entering the handler above.
      for (const [signal, handler] of handlers) process.off(signal, handler);
      process.kill(process.pid, raised);
    })();
  });
}
