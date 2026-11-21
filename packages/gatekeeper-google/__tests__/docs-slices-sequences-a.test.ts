// The seeded sequences the model is held to from the slices of their tabs: the even sequences of
// seed 20261113, and in the wider run those of seed 20261114. `-b` runs the odd ones.

import { sequencesFromEverySlice } from "./docs-slice-shadow";

sequencesFromEverySlice(20261113, false, 0, false);
sequencesFromEverySlice(20261114, true, 0, true);
