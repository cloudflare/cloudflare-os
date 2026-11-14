import { DEFAULT_MODEL, evalModels } from "./config.js";

/**
 * Published baselines are measured on DEFAULT_MODEL. Say so once, up front, when the matrix
 * departs from it, so a local run on another model is not mistaken for a comparable one. Reading
 * the models also rejects an invalid WORKSHOP_EVAL_TASK_OVERRIDES before any file is collected.
 */
export default function setup(): void {
  const others = evalModels().filter(model => model !== DEFAULT_MODEL);
  if (others.length === 0) return;
  console.warn(
    `This run selects ${others.join(", ")}. Published baselines are measured on ` +
    `${DEFAULT_MODEL}, so results for these models are not comparable to them.`);
}
