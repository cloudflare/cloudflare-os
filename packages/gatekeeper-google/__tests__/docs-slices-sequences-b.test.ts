// The seeded sequences the model is held to from the slices of their tabs: the odd sequences of
// seed 20261113, and in the wider run those of seed 20261114. `-a` runs the even ones.

import { sequencesFromEverySlice } from "./docs-slice-shadow";

sequencesFromEverySlice(20261113, false, 1, false);
sequencesFromEverySlice(20261114, true, 1, true);
