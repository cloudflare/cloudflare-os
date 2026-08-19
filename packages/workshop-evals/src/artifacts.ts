import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalArtifact } from "./task.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where reports and per-run files are written.
 *
 * `.wrangler/` is already excluded from every Vite+ task input across the workspace, so eval output
 * cannot invalidate unrelated packages' build caches.
 */
export const EVAL_OUTPUT_DIR = resolve(PACKAGE_DIR, ".wrangler", "evals");

/** Reduces an arbitrary label to a path segment, preserving enough to stay readable. */
export function slug(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "unnamed" : safe.slice(0, 80);
}

/** Directory for one repetition, relative to {@link EVAL_OUTPUT_DIR}. Reruns overwrite it. */
export function runDirectory(taskId: string, model: string, trial: number): string {
  return `runs/${slug(taskId)}/${slug(model)}/trial-${trial}`;
}

/** Writes one file below {@link EVAL_OUTPUT_DIR} and describes it for the report. */
export async function writeArtifact(
    relativePath: string, contents: Uint8Array | string): Promise<EvalArtifact> {
  const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  const absolute = resolve(EVAL_OUTPUT_DIR, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  return {
    path: `.wrangler/evals/${relativePath}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}
