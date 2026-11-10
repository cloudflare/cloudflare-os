import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const reviewMd = readFileSync(new URL("../../../REVIEW.md", import.meta.url), "utf8");
const skill = readFileSync(new URL("../../../.agents/skills/write-gatekeeper/SKILL.md", import.meta.url), "utf8");

/** The body of the section under `heading`, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) return "";
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return next === -1 ? rest : rest.slice(0, next);
}

// A skill edit is scored by AI, REVIEW.md only by a person. Rules that reviews enforce therefore live
// in REVIEW.md alone, so a scored skill edit cannot weaken what later reviews check.
describe("reviewer rules", () => {
  for (const [reviewHeading, skillHeading, anchor] of [
    ["### Reviewing a gatekeeper", "## Reviewing a gatekeeper", "reviewing-a-gatekeeper"],
    ["### Action kinds and auto-approval", "#### Action kinds and auto-approval", "action-kinds-and-auto-approval"],
  ]) {
    it(`keeps "${reviewHeading.replace(/^#+ /, "")}" in REVIEW.md, and the skill only links to it`, () => {
      const rules = section(reviewMd, reviewHeading).split("\n").filter(line => line.trim() !== "");
      assert.ok(rules.length > 5, `REVIEW.md has no "${reviewHeading}" section`);
      const skillSection = section(skill, skillHeading);
      assert.match(skillSection, new RegExp(`\\(\\.\\./\\.\\./\\.\\./REVIEW\\.md#${anchor}\\)`));
      assert.deepEqual(rules.filter(line => skill.includes(line)), []);
    });
  }

  it("routes runtime agent text to a person, and reviews skill edits like code", () => {
    const item = section(reviewMd, "## Needs a person").split("\n- ").find(entry => entry.includes("`types.d.ts`")) ?? "";
    assert.match(item, /^text that agents read at runtime/);
    assert.match(item.replaceAll(/\s+/g, " "), /`\.agents\/skills\/` is not in this item: review it like code/);
    assert.match(item.replaceAll(/\s+/g, " "), /only when it changes capability or approval behavior/);
  });
});
