import type { EvalExpectation, EvalTask } from "../src/task.js";
import appointmentDesk from "./appointment-desk.task.js";
import contextRepairDesk from "./context-repair-desk.task.js";
import expenseLedger from "./expense-ledger.task.js";
import orgChart from "./org-chart.task.js";
import pantryKitchen from "./pantry-kitchen.task.js";
import projectDoc from "./project-doc.task.js";
import spacedRepetition from "./spaced-repetition.task.js";
import stockLedger from "./stock-ledger.task.js";
import timeTracker from "./time-tracker.task.js";

/**
 * Every authored task.
 *
 * Adding an eval is two steps: write `tasks/<id>.task.ts` exporting a `defineEvalTask(...)` default,
 * and list it here. `registry.test.ts` fails when a task file is missing from this list, so the two
 * cannot drift.
 */
export const evalTasks: readonly EvalTask[] = [
  appointmentDesk,
  contextRepairDesk,
  expenseLedger,
  orgChart,
  pantryKitchen,
  projectDoc,
  spacedRepetition,
  stockLedger,
  timeTracker,
];

/** The tasks in one result set. */
export function tasksFor(expectation: EvalExpectation): EvalTask[] {
  return evalTasks.filter(task => task.expectation === expectation);
}
