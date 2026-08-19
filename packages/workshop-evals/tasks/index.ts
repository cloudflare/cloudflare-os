import type { EvalExpectation, EvalTask } from "../src/task.js";
import appointmentDesk from "./appointment-desk.task.js";
import stockLedger from "./stock-ledger.task.js";

/**
 * Every authored task.
 *
 * Adding an eval is two steps: write `tasks/<id>.task.ts` exporting a `defineEvalTask(...)` default,
 * and list it here. `registry.test.ts` fails when a task file is missing from this list, so the two
 * cannot drift.
 */
export const evalTasks: readonly EvalTask[] = [appointmentDesk, stockLedger];

/** The tasks in one result set. */
export function tasksFor(expectation: EvalExpectation): EvalTask[] {
  return evalTasks.filter(task => task.expectation === expectation);
}
