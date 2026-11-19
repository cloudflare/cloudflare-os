import { expect, it } from "vitest";
import { definitions, policy } from "../src/acme-actions";

// What each action commits the gatekeeper to once it ships, for a reviewer to read in one place.
// Stored records resolve by name and a user's "always approve" rule is stored under the tag, so
// neither can change; a verdict that turns `true`, or a fence that turns `"none"`, lets more
// through. Regenerating with `vitest run -u` accepts any change: read the diff, and give a
// reason for each line of it.
it("matches the committed action table", async () => {
  const rows = Object.entries(definitions)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, definition]) => JSON.stringify({
      name,
      tag: definition.kind.tag,
      autoApprovable: definition.autoApprovable,
      delivery: definition.delivery,
      claimBeforeApply: definition.claimBeforeApply === true,
      fence: policy.fenceOverrides?.[name as keyof typeof definitions] ?? policy.fence,
    }));
  await expect(`[\n${rows.map(row => `  ${row}`).join(",\n")}\n]\n`).toMatchFileSnapshot("../action-table.json");
});
