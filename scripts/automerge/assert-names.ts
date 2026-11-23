import assert from "node:assert/strict";

/**
 * Checks that `found` has one entry per subject, in order, each naming its subject: the package,
 * file, class, tag or key at fault. A test names those, never a reason's wording.
 */
export function assertNames(found: string[], subjects: string[], context?: string): void {
  assert.equal(found.length, subjects.length, context ?? found.join("\n"));
  subjects.forEach((subject, i) => assert.ok(found[i].includes(subject), context ?? found[i]));
}
