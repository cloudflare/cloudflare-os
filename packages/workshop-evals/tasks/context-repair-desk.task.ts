import type { RpcStub } from "capnweb";
import type { ContextApi } from "@gadgets/gatekeeper-context/context-types";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineEvalTask } from "../src/task.js";

const CONTEXT_GATEKEEPER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../gatekeeper-context",
);

const POLICY = `# Northstar Repair Operations

Use these rules for every repair intake.

## Service levels

- Aurora: target 240 minutes.
- Summit: target 720 minutes.
- Valley: target 2880 minutes.
- After-hours work adds 35 percent to the base price. Round to the nearest cent.

## Depot routing

Route by the first two characters of the serial number:

- AX: Reykjavik
- Q7: Osaka
- M3: Toronto

Reject an unknown service level or serial prefix rather than guessing.`;

interface RepairDeskApi {
  quote(input: { tier: string; baseCents: number; afterHours: boolean }): Promise<{
    ok: true;
    targetMinutes: number;
    totalCents: number;
  } | {
    ok: false;
    error: string;
  }>;
  route(input: { serial: string }): Promise<{
    ok: true;
    depot: string;
  } | {
    ok: false;
    error: string;
  }>;
}

/**
 * Tests the platform's ambient Context Library path with information absent from the prompt. The
 * setup provisions the real gatekeeper and writes a private operations document through its
 * management capability. The agent must discover and read that document, then turn its rules into a
 * working application. The checks observe only the resulting Gadget RPC.
 *
 * This starts as frontier until a repeated live baseline measures it.
 */
export default defineEvalTask({
  id: "context-repair-desk",
  title: "Repair desk from private context",
  expectation: "frontier",
  gatekeepers: [{ binding: "CONTEXT", dir: CONTEXT_GATEKEEPER_DIR }],
  prepare: async session => {
    await session.provisionAmbientAccount("context");
    const frame = await session.getGatekeeperApp("context");
    if (frame === null) throw new Error("Context Library management UI is unavailable");
    using context = frame.ui as RpcStub<ContextApi>;
    const collection = await context.createContextCollection(
      "Northstar Operations",
      "Current operating rules for the Northstar repair team.",
      "private",
    );
    await context.putContextDocument(collection.id, "repair-policy.md", {
      description: "Service levels, after-hours pricing, and depot routing.",
      body: POLICY,
      contentType: "text/markdown",
    });
  },
  turns: [{
    prompt: `Use the Context Library to find Northstar's current repair operations policy. Then build
a Gadget named exactly "Northstar Repair Desk" for repair intake. Do not ask me to paste the policy.

Give it a usable form and a stable server RPC with these plain-data methods so another system can
verify the result:

- quote({ tier, baseCents, afterHours }) -> either
  { ok: true, targetMinutes, totalCents } or { ok: false, error }
- route({ serial }) -> either { ok: true, depot } or { ok: false, error }

Treat tier names and serial prefixes case-insensitively. Reject invalid inputs instead of guessing.`,
    verify: async verifier => {
      await verifier.check("applies-private-service-levels-and-pricing", async () => {
        using api = await verifier.connect<RepairDeskApi>("Northstar Repair Desk");
        const aurora = await api.quote({ tier: "AURORA", baseCents: 10_000, afterHours: false });
        const summit = await api.quote({ tier: "summit", baseCents: 20_000, afterHours: true });
        const valley = await api.quote({ tier: "Valley", baseCents: 1_999, afterHours: false });
        return {
          pass: aurora.ok && aurora.targetMinutes === 240 && aurora.totalCents === 10_000 &&
            summit.ok && summit.targetMinutes === 720 && summit.totalCents === 27_000 &&
            valley.ok && valley.targetMinutes === 2880 && valley.totalCents === 1_999,
          evidence: { aurora, summit, valley },
        };
      });

      await verifier.check("routes-private-serial-prefixes", async () => {
        using api = await verifier.connect<RepairDeskApi>("Northstar Repair Desk");
        const ax = await api.route({ serial: "ax-1049" });
        const q7 = await api.route({ serial: "Q7Z88" });
        const m3 = await api.route({ serial: "m3/442" });
        return {
          pass: ax.ok && ax.depot === "Reykjavik" &&
            q7.ok && q7.depot === "Osaka" &&
            m3.ok && m3.depot === "Toronto",
          evidence: { ax, q7, m3 },
        };
      });

      await verifier.check("rejects-values-the-policy-does-not-define", async () => {
        using api = await verifier.connect<RepairDeskApi>("Northstar Repair Desk");
        const tier = await api.quote({ tier: "Express", baseCents: 5000, afterHours: false });
        const serial = await api.route({ serial: "ZZ-100" });
        return {
          pass: !tier.ok && typeof tier.error === "string" &&
            !serial.ok && typeof serial.error === "string",
          evidence: { tier, serial },
        };
      });
    },
  }],
});
