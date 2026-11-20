// The store's differential under runs forced to one to three elements: every recorded step,
// the pairs whose first request removes or adds a top-level element and a share of the seeded
// sequences, each batch through the store's slices from every stretch of its version's runs,
// held to the whole tab's outcome. The tests are `storeFromEveryStretch`'s.

import { RUNS_OF_THREE } from "./doc-store-scenarios";
import { storeFromEveryStretch } from "./docs-store-slice-shadow";
import { WIDER } from "./wider-run";

// Which of the pairs of each tab and first request are run, A TABLE OF TWO WIDTHS: every
// second by default (twenty of each, from every stretch), all of them in the wider run. The
// file of the store's own sizes runs every pair in both.
const PAIRS_SHARE = WIDER ? 1 : 2;

storeFromEveryStretch("under runs of one to three elements", RUNS_OF_THREE, PAIRS_SHARE, false);
