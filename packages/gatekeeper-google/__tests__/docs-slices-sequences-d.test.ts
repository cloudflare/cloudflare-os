// The seeded sequences the model is held to, from the slices of their tabs: the sequences of
// seed 20261114 whose number is odd, in the wider run of the tests. Every sequence of both seeds is in
// exactly one of the four files of this name, which share one body.

import { sequencesFromEverySlice } from "./docs-slice-shadow";

// What the sequences of the seed reach when the property's own test draws them: a draw that
// moved fails here by name.
sequencesFromEverySlice(20261114, true, 1, {
  applied: 3163, refused: 645,
  renumbered: {
    deleteContentRange: 84, deleteTableRow: 52,
    deleteTableColumn: 43,
  },
  mergesThatMoved: 48, joinsAfterTouch: 102, coveredRefusals: 47, uncovered: 24,
  nestedGrowths: 43, bulletedCellEnds: 102, tablesAtCellEnds: 100,
}, true);
