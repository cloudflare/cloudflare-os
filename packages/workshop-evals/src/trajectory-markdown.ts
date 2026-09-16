// Render an eval report's trajectories as Markdown for a reviewer that reads files line by line
// (OpenCode truncates a line after 2,000 characters). Every multi-line string, which is where the
// agent's code lives, becomes a fenced block, so no line is longer than its longest source line.
import { basename } from "node:path";
import type { JsonValue } from "vitest-evals";
import { parseResults, trials, type Assertion, type TranscriptEvent } from "./results.ts";

/** The reader shows this much of a line; anything past it would be lost, so lines are chunked. */
const LINE_LIMIT = 1_900;

function chunked(text: string): string {
  return text.split("\n").map(line => {
    if (line.length <= LINE_LIMIT) return line;
    const pieces: string[] = [];
    for (let at = 0; at < line.length; at += LINE_LIMIT) {
      pieces.push(line.slice(at, at + LINE_LIMIT) + (at + LINE_LIMIT < line.length ? " ⏎" : ""));
    }
    return pieces.join("\n");
  }).join("\n");
}

function fence(text: string): string {
  // A fence longer than any run of backticks inside the text cannot be closed by the text.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}\n${chunked(text.replace(/\n$/, ""))}\n${marks}`;
}

/** Inline for short scalars, fenced for anything that would otherwise be one long line. */
function value(json: JsonValue | undefined): string {
  if (json === undefined) return "_none_";
  const text = typeof json === "string" ? json : JSON.stringify(json, null, 2) ?? "null";
  return text.includes("\n") || text.length > 120 || text.includes("`")
    ? `\n${fence(text)}`
    : `\`${text}\``;
}

function event(entry: TranscriptEvent): string {
  switch (entry.type) {
    case "message":
      // Fenced rather than inlined: an agent's Markdown would otherwise add its own headings to
      // this document's structure.
      return `**${entry.role}** ${value(entry.content)}`;
    case "tool_call": {
      const lines = [`→ ${value(entry.name)} ${value(entry.id)}`];
      for (const [key, argument] of Object.entries(entry.arguments ?? {})) {
        lines.push(`- ${key}: ${value(argument)}`);
      }
      return lines.join("\n");
    }
    case "tool_result":
      return entry.error !== undefined
        ? `← ${value(entry.name ?? "tool")} ${value(entry.toolCallId)} failed: ${value(entry.error.message)}`
        : `← ${value(entry.name ?? "tool")} ${value(entry.toolCallId)}: ${value(entry.content)}`;
  }
}

function trial(assertion: Assertion, index: number): string {
  const run = assertion.meta.harness.run;
  const { taskId } = run.session.metadata;
  const minutes = (assertion.duration / 60_000).toFixed(1);
  const cost = run.usage.metadata.observedCumulativeChatCostUsd;
  const lines = [
    `## ${taskId} · ${run.usage.model} · trial ${index} — ${assertion.status} (${minutes} min)`,
    "",
    `Model turns ${run.output.metrics.modelTurns} · tool calls ${run.output.metrics.toolCalls} · ` +
      `tool errors ${run.output.metrics.toolErrors}` +
      (cost === undefined ? "" : ` · cost $${cost.toFixed(4)}`),
  ];
  for (const [turn, { outcome, checks }] of run.output.turns.entries()) {
    lines.push("", `Turn ${turn + 1}: ${outcome.status}` +
      (outcome.message === undefined ? "" : ` — ${value(outcome.message)}`));
    for (const check of checks) {
      lines.push(`- ${check.pass ? "pass" : "FAIL"} \`${check.id}\`` +
        (check.pass || check.evidence === undefined ? "" : `: ${value(check.evidence)}`));
    }
  }
  if (run.errors.length > 0) {
    lines.push("", "Errors:");
    for (const error of run.errors) lines.push(`- ${error.name}: ${value(error.message)}`);
  }
  lines.push("", "### Transcript", "");
  lines.push(run.session.events.map(event).join("\n\n"));
  return lines.join("\n");
}

/** One Markdown document for a whole report: a section per trial, in report order. */
export function renderTrajectories(text: string): string {
  const files = parseResults("results", text);
  const sections: string[] = [];
  // A file that failed before its first trial is a missing cohort the reviewer must know about.
  for (const file of files) {
    if (file.assertionResults.length === 0) {
      sections.push(`## ${basename(file.name)} ran no trials\n\n${value(file.message ?? "no message")}`);
    }
  }
  const perCohort = new Map<string, number>();
  for (const assertion of trials(files)) {
    const run = assertion.meta.harness.run;
    const key = `${run.session.metadata.taskId}\0${run.usage.model}`;
    const index = (perCohort.get(key) ?? 0) + 1;
    perCohort.set(key, index);
    sections.push(trial(assertion, index));
  }
  return `# Eval trajectories\n\n${sections.join("\n\n---\n\n")}\n`;
}
