// Every test starts with the Cloud Connector budgets full. They're shared per console across the
// whole deployment, as they must be, so in one test file they'd otherwise carry what earlier tests
// spent -- and a 429's back-off -- into later ones.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach } from "vitest";
import { HOME } from "../fake-unifi.js";

const OFFICE_HOST = "AABBCCDDEEFF0000000006797F060000000006C719490000000062ABD4EB:1261206303";

beforeEach(async () => {
  for (const host of [HOME.hostId, OFFICE_HOST]) {
    const budget = env.UNIFI_CONSOLE_BUDGET.get(env.UNIFI_CONSOLE_BUDGET.idFromName(host));
    // Aborting drops its in-memory state; the next request starts a fresh instance.
    await runInDurableObject(budget, (_instance, state) => state.abort("reset between tests")).catch(() => undefined);
  }
});
