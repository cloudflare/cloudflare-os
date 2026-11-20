// Fails a test that sent ZoomInfo a request the gatekeeper's route tree gives no name: such a
// request would be counted under its bare HTTP method.

import { afterEach, expect } from "vitest";
import { unnamedRequests } from "./fake-zoominfo";

afterEach(() => {
  expect(unnamedRequests.splice(0)).toEqual([]);
});
