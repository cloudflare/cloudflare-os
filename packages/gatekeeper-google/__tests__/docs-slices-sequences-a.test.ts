// The seeded sequences the model is held to, from the slices of their tabs: the sequences of
// seed 20261113 whose number is even. Every sequence of both seeds is in
// exactly one of the four files of this name, which share one body.

import { sequencesFromEverySlice } from "./docs-slice-shadow";

// What the sequences of the seed reach when the property's own test draws them: a draw that
// moved fails here by name.
sequencesFromEverySlice(20261113, false, 0, {
  applied: 3096, refused: 622,
  renumbered: {
    deleteContentRange: 71, deleteTableRow: 48,
    deleteTableColumn: 43,
  },
  mergesThatMoved: 49, joinsAfterTouch: 92, coveredRefusals: 49, uncovered: 22,
  nestedGrowths: 44, bulletedCellEnds: 100, tablesAtCellEnds: 93,
}, false);
