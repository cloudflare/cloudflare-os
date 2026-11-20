// Fails a test that sent X a request the gatekeeper's route tree gives no name: such a request
// would be counted under its bare HTTP method. The fake fails the request itself, but as a failed
// transport, which a test that expects one would not notice.

import { afterEach, expect } from "vitest";
import { unnamedRequests } from "./fake-x";

afterEach(() => {
  expect(unnamedRequests.splice(0)).toEqual([]);
});
