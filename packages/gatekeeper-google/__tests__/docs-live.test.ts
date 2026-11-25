// Holds the model of Google's `documents.batchUpdate` to the recordings of what Google Docs
// did with the batches the gatekeeper's builders sent: for every recorded step, the model
// applied to the document before it gives the document Google returned after it.

import { describe, expect, it } from "vitest";
import { applyDocsRequests, hasModelIndexes } from "../src/docs-model";
import { docTabToMarkdown } from "../src/markdown-converter";
import { MODELS } from "./doc-fixture";
import { comparable, prunedTab, readFixtures, rowsGoogleSizes } from "./docs-live-fixtures";
import { SCENARIOS } from "./docs-live-recorder";

const FIXTURES = readFixtures();

/** The recorder's scenarios that have no recording yet. */
const UNRECORDED = SCENARIOS.filter(scenario =>
  !FIXTURES.some(fixture => fixture.name === scenario.name));

describe("the recordings of Google Docs", () => {
  it("holds recordings", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  it("holds only recordings of the recorder's scenarios, with every step of each", () => {
    for (let fixture of FIXTURES) {
      let scenario = SCENARIOS.find(candidate => candidate.name === fixture.name);
      expect(scenario, `a scenario named ${fixture.name}`).toBeDefined();
      expect(fixture.steps.map(step => step.name), fixture.name)
        .toEqual(scenario?.steps.map(step => step.name));
    }
  });

  // A suite with no test fails, so the suite opens only while a scenario waits.
  if (UNRECORDED.length > 0) {
    describe("names every scenario still to be recorded", () => {
      for (let scenario of UNRECORDED) it.todo(scenario.name);
    });
  }
});

for (let fixture of FIXTURES) {
  describe(`the recording ${fixture.name}`, () => {
    let tabs = [fixture.before, ...fixture.steps.map(step => step.after)];

    for (let [index, step] of fixture.steps.entries()) {
      it(step.name, () => {
        let sized = rowsGoogleSizes(step.requests);
        for (let options of MODELS) {
          let applied = applyDocsRequests(tabs[index], step.requests, options);
          // The model renders exactly as Google's answer does.
          expect(docTabToMarkdown(applied).markdown, JSON.stringify(options))
            .toBe(docTabToMarkdown(step.after).markdown);
          // And it holds every index, the structure and every field it keeps as Google does.
          expect(comparable(prunedTab(applied), sized), JSON.stringify(options))
            .toEqual(comparable(step.after, sized));
        }
      });
    }

    it("holds tabs that are indexed as the model indexes them, and pruned", () => {
      for (let tab of tabs) {
        // Google leaves out the start index of the section break that opens a body, and the
        // recording keeps it left out.
        expect(tab.body.content[0]).not.toHaveProperty("startIndex");
        expect(hasModelIndexes(tab)).toBe(true);
        expect(prunedTab(tab)).toEqual(tab);
      }
    });
  });
}
