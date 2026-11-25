// The store's differential under a run an element, the harshest cut: every recorded step, a share
// of the pairs whose first request removes or adds a top-level element and of the seeded
// sequences, each from every stretch of runs (`storeFromEveryStretch`).

import { RUNS_OF_THREE } from "./doc-store-scenarios";
import { storeFromEveryStretch } from "./docs-store-slice-shadow";
import { WIDER } from "./wider-run";

// Which pairs of each tab and first request are run, A TABLE OF TWO WIDTHS: every fourth, every
// second in the wider run. The file of the store's own sizes runs every pair.
const PAIRS_SHARE = WIDER ? 2 : 4;

storeFromEveryStretch("under a run an element", { ...RUNS_OF_THREE, elements: 1 }, PAIRS_SHARE);
