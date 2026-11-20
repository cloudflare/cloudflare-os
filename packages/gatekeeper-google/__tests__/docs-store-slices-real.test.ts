// The store's differential under the sizes a store cuts to: every recorded step, the pairs
// whose first request removes or adds a top-level element and a share of the seeded sequences,
// each batch through the store's slices from every stretch of its version's runs, held to the
// whole tab's outcome. The tests are `storeFromEveryStretch`'s.

import { RUN_SIZES } from "../src/docs-runs";
import { storeFromEveryStretch } from "./docs-store-slice-shadow";

storeFromEveryStretch("under the sizes a store cuts to", RUN_SIZES, 1, false);
