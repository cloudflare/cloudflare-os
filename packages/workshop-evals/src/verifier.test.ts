import type { WorkpieceSummary } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import { EvalVerifier, resolveGadget, type VerifierSession } from "./verifier.js";
import type { EvalCheck } from "./task.js";

const unusedSession: VerifierSession = {
  openGadget: async () => { throw new Error("openGadget is not used by this test"); },
};

function gadget(id: number, title: string): WorkpieceSummary {
  return { id, type: "gadget", title };
}

function collect(
    verify: (verifier: EvalVerifier) => Promise<void>,
    workpieces: readonly WorkpieceSummary[] = []): Promise<EvalCheck[]> {
  return new EvalVerifier(unusedSession, workpieces).collect(verify);
}

describe("resolveGadget", () => {
  it("resolves an exact title", () => {
    expect(resolveGadget([gadget(3, "Split"), gadget(4, "Shelf")], "Shelf")).toBe(4);
  });

  it("reports what was built when the title is missing", () => {
    expect(() => resolveGadget([gadget(3, "Splitter")], "Split"))
      .toThrow('found 0 among ["Splitter"]');
  });

  it("refuses an ambiguous title", () => {
    expect(() => resolveGadget([gadget(3, "Split"), gadget(4, "Split")], "Split"))
      .toThrow("found 2");
  });
});

describe("EvalVerifier", () => {
  it("records outcomes with and without evidence", async () => {
    expect(await collect(async verifier => {
      await verifier.check("bare", async () => ({ pass: true }));
      await verifier.check("detailed", async () => ({ pass: false, evidence: { seen: 2 } }));
    })).toEqual([
      { id: "bare", pass: true },
      { id: "detailed", pass: false, evidence: { seen: 2 } },
    ]);
  });

  it("records a failed check and continues", async () => {
    expect(await collect(async verifier => {
      await verifier.check("explodes", async () => { throw new Error("RPC refused"); });
      await verifier.check("still-runs", async () => ({ pass: true }));
    })).toEqual([
      { id: "explodes", pass: false, evidence: "Error: RPC refused" },
      { id: "still-runs", pass: true },
    ]);
  });

  it("keeps checks recorded before the verifier body fails", async () => {
    const checks = await collect(async verifier => {
      await verifier.check("recorded", async () => ({ pass: true }));
      throw new Error("resolveGadget failed outside a check");
    });
    expect(checks.at(0)).toEqual({ id: "recorded", pass: true });
    expect(checks.at(1)).toMatchObject({ id: "verifier.threw", pass: false });
  });

  it("keeps registration order when checks finish out of order", async () => {
    const gate = Promise.withResolvers<void>();
    const checks = await collect(async verifier => {
      const slow = verifier.check("slow", async () => {
        await gate.promise;
        return { pass: true };
      });
      const fast = verifier.check("fast", async () => ({ pass: true }));
      await fast;
      gate.resolve();
      await slow;
    });
    expect(checks.map(check => check.id)).toEqual(["slow", "fast"]);
  });

  it("settles a check the author did not await", async () => {
    expect(await collect(async verifier => {
      void verifier.check("forgotten", async () => ({ pass: true }));
    })).toEqual([{ id: "forgotten", pass: true }]);
  });

  it("exposes checks that are still pending", async () => {
    const gate = Promise.withResolvers<void>();
    const verifier = new EvalVerifier(unusedSession, []);
    const pending = verifier.check("pending", async () => {
      await gate.promise;
      return { pass: true };
    });
    expect(verifier.results()).toEqual([
      { id: "pending", pass: false, evidence: "check did not complete" },
    ]);
    gate.resolve();
    await pending;
  });

  it("records a duplicate check ID as a verifier failure", async () => {
    const checks = await collect(async verifier => {
      await verifier.check("same", async () => ({ pass: true }));
      await verifier.check("same", async () => ({ pass: true }));
    });
    expect(checks.at(0)).toEqual({ id: "same", pass: true });
    expect(checks.at(1)?.evidence).toContain("Duplicate eval check ID");
  });
});
