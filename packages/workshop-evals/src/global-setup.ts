import { DEFAULT_MODEL, evalMatrix } from "./config.js";

/**
 * Published baselines are measured on DEFAULT_MODEL. Say so once, up front, when the matrix
 * departs from it, so a local run on another model is not mistaken for a comparable one.
 */
export default function setup(): void {
  const others = evalMatrix().models.filter(model => model !== DEFAULT_MODEL);
  if (others.length === 0) return;
  console.warn(
    `WORKSHOP_EVAL_MODELS selects ${others.join(", ")}. Published baselines are measured on ` +
    `${DEFAULT_MODEL}, so results for these models are not comparable to them.`);
}
