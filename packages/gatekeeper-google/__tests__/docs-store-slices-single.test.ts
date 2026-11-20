// The store's differential under a run an element, in the wider run alone (the file registers
// its tests and skips them by default): every recorded step, a share of the pairs whose first
// request removes or adds a top-level element and of the seeded sequences, each batch through
// the store's slices from every stretch of its version's runs, held to the whole tab's outcome.
// The tests are `storeFromEveryStretch`'s.

import { RUNS_OF_THREE } from "./doc-store-scenarios";
import { storeFromEveryStretch } from "./docs-store-slice-shadow";

storeFromEveryStretch("under a run an element", { ...RUNS_OF_THREE, elements: 1 }, 4, true);
