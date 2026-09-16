import { expect, it } from "vitest";
import { renderTrajectories } from "./trajectory-markdown.js";

const SOURCE = Array.from({ length: 40 }, (_unused, line) =>
  `export const value${line} = "${"x".repeat(80)}";`).join("\n");

/** Lines that Markdown would treat as headings: outside any fence and starting with `## `. */
function headings(markdown: string): string[] {
  const found: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const marks = /^`{3,}/.exec(line)?.[0];
    if (marks !== undefined) {
      if (fence === undefined) fence = marks;
      else if (marks.length >= fence.length) fence = undefined;
    } else if (fence === undefined && line.startsWith("## ")) {
      found.push(line);
    }
  }
  return found;
}

function report(events: unknown[], checks: unknown[] = []): string {
  return JSON.stringify({ testResults: [{
    name: "/evals/project-doc.eval.ts",
    assertionResults: [{
      status: "failed",
      duration: 90_000,
      meta: { harness: { run: {
        session: {
          metadata: { taskId: "project-doc", taskVersion: "v", gitCommit: "a".repeat(40) },
          events,
        },
        usage: { model: "@cf/zai-org/glm-5.3-flash", metadata: { observedCumulativeChatCostUsd: 0.01 } },
        output: {
          metrics: { modelTurns: 1, toolCalls: 1, toolErrors: 0 },
          turns: [{ outcome: { status: "completed" }, checks }],
        },
        errors: [],
      } } },
    }],
  }] });
}

it("keeps every line under the reader's limit and every heading its own", () => {
  const markdown = renderTrajectories(report([
    { type: "message", role: "user", content: "Build it." },
    { type: "message", role: "assistant", content: "## Plan\n\nI will write the file." },
    { type: "tool_call", id: "call-1", name: "writeFile", arguments: {
      workpiece: "DOC", filename: "server.js", content: SOURCE,
    } },
    { type: "tool_result", toolCallId: "call-1", name: "writeFile", content: "ok" },
  ], [
    { id: "renders", pass: false, evidence: { got: "x".repeat(300) } },
  ]));

  expect(SOURCE.length).toBeGreaterThan(2000);
  expect(Math.max(...markdown.split("\n").map(line => line.length))).toBeLessThan(2000);
  expect(headings(markdown)).toEqual([
    "## project-doc · @cf/zai-org/glm-5.3-flash · trial 1 — failed (1.5 min)",
  ]);
  expect(markdown).toContain("- FAIL `renders`:");
  expect(markdown).toContain("→ `writeFile` `call-1`");
  expect(markdown).toContain(SOURCE);
});

it("chunks a physical line longer than the reader shows", () => {
  const minified = `const x=[${Array.from({ length: 800 }, (_unused, n) => n).join(",")}];`;
  expect(minified.length).toBeGreaterThan(2000);
  const markdown = renderTrajectories(report([
    { type: "tool_call", id: "call-1", name: "writeFile", arguments: { content: minified } },
  ]));
  const lines = markdown.split("\n");
  expect(Math.max(...lines.map(line => line.length))).toBeLessThan(2000);
  const start = lines.findIndex(line => line.startsWith("const x=["));
  const chunks = lines.slice(start, lines.indexOf("```", start));
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.map(line => line.replace(/ ⏎$/, "")).join("")).toBe(minified);
});

it("keeps a multi-line error message out of the document structure", () => {
  const markdown = renderTrajectories(report([
    { type: "tool_result", toolCallId: "call-1", name: "executeCode", error: {
      name: "Error", message: "## Not a heading\nline two",
    } },
  ]));
  expect(headings(markdown)).toHaveLength(1);
  expect(markdown).toContain("failed: \n```\n## Not a heading\nline two\n```");
});

it("closes a fence around content that contains fences", () => {
  const markdown = renderTrajectories(report([
    { type: "message", role: "assistant", content: "Use this:\n```js\nrun()\n```\nDone." },
  ]));
  expect(markdown).toContain("````\nUse this:\n```js\nrun()\n```\nDone.\n````");
});

it("keeps model-supplied identifiers out of the document structure", () => {
  const markdown = renderTrajectories(report([
    { type: "tool_call", id: "call`\n## injected", name: "write`File", arguments: {} },
    { type: "tool_result", toolCallId: "call`\n## injected", name: "write`File", content: "ok" },
  ]));
  expect(headings(markdown)).toHaveLength(1);
  expect(markdown).toContain("## injected");
});

it("shows a file that ran no trials beside the trials of the others", () => {
  const withEmptyFile = JSON.parse(report([{ type: "message", role: "user", content: "Build it." }]));
  withEmptyFile.testResults.push({
    name: "/evals/appointment-desk.eval.ts",
    message: "Cannot find module './verifier.js'",
    assertionResults: [],
  });
  const markdown = renderTrajectories(JSON.stringify(withEmptyFile));
  expect(headings(markdown)).toEqual([
    "## appointment-desk.eval.ts ran no trials",
    "## project-doc · @cf/zai-org/glm-5.3-flash · trial 1 — failed (1.5 min)",
  ]);
  expect(markdown).toContain("Cannot find module './verifier.js'");
});
