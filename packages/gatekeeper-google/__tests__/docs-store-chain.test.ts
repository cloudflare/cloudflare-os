// A tab between two edits is serialized, stored, parsed and known to the model again: that passage
// through the Doc store changes no step of a chain of edits, on every recording of Google's
// answers.

import { describe, expect, it } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import { applyDocsRequests } from "../src/docs-model";
import { docTabToMarkdown } from "../src/markdown-converter";
import { fakeDocStore } from "./doc-store-fake";
import { readFixtures } from "./docs-live-fixtures";

type Step = { tab: GoogleDocsTab; fullReindexes: number } | { refusal: string };

/** `requests` applied to `tab`, with what the model recomputed, or the refusal's message. */
function stepOf(tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[]): Step {
  let cost = { fullReindexes: 0 };
  try {
    return { tab: applyDocsRequests(tab, requests, {}, cost), fullReindexes: cost.fullReindexes };
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : String(error) };
  }
}

describe.each(readFixtures())("the recording $name", fixture => {
  it("replays through the store as it does in memory", () => {
    let store = fakeDocStore();
    let passed = (tab: GoogleDocsTab) => store.tab(store.putTab("doc", tab, []));
    let inMemory = fixture.before;
    let stored = fixture.before;

    for (let [at, step] of fixture.steps.entries()) {
      let plain = stepOf(inMemory, step.requests);
      let through = stepOf(passed(stored), step.requests);

      if ("refusal" in plain || "refusal" in through) {
        expect(through, step.name).toEqual(plain);
        continue;
      }
      expect(through.tab, step.name).toEqual(plain.tab);
      expect(JSON.stringify(through.tab), step.name).toBe(JSON.stringify(plain.tab));
      expect(docTabToMarkdown(through.tab).markdown, step.name)
        .toBe(docTabToMarkdown(plain.tab).markdown);
      // A tab read back is known to the model again: the chain recomputes no more than in memory.
      if (at > 0) expect(through.fullReindexes, step.name).toBeLessThanOrEqual(plain.fullReindexes);
      inMemory = plain.tab;
      stored = through.tab;
    }
    // What the chain leaves is what the recording's last answer renders as.
    let last = fixture.steps.at(-1);
    if (last) expect(docTabToMarkdown(stored).markdown).toBe(docTabToMarkdown(last.after).markdown);
  });
});
