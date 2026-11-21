// The store's differential under the sizes a store cuts to: every recorded step, every pair whose
// first request removes or adds a top-level element and a share of the seeded sequences, each
// from every stretch of runs (`storeFromEveryStretch`).

import { RUN_SIZES } from "../src/docs-runs";
import { storeFromEveryStretch } from "./docs-store-slice-shadow";

storeFromEveryStretch("under the sizes a store cuts to", RUN_SIZES, 1);
