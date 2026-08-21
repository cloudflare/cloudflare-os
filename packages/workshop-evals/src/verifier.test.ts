import type { WorkpieceSummary } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import { EvalVerifier, resolveGadget, type VerifierSession } from "./verifier.js";
import type { EvalCheck } from "./task.js";

const unusedSession: VerifierSession = {
  connectToGadget: () => { throw new Error("connectToGadget is not used by this test"); },
  restartGadgets: () => { throw new Error("restartGadgets is not used by this test"); },
};

function gadget(id: number, title: string): WorkpieceSummary {
  return { id, type: "gadget", title };
}

function collect(
    verify: (verifier: EvalVerifier) => Promise<void>,
    workpieces: readonly WorkpieceSummary[] = []): Promise<EvalCheck[]> {
  return new EvalVerifier(unusedSession, 1, workpieces).collect(verify);
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
    expect(() => resolveGadget([gadget(3, "Split"), gadget(4, "Split")], "Split")).toThrow("found 2");
  });
});

describe("EvalVerifier", () => {
  it("records outcomes with and without evidence", async () => {
    expect(await collect(async verifier => {
      await verifier.check("bare", async () => true);
      await verifier.check("detailed", async () => ({ pass: false, evidence: { seen: 2 } }));
    })).toEqual([
      { id: "bare", pass: true },
      { id: "detailed", pass: false, evidence: { seen: 2 } },
    ]);
  });

  it("records a throw inside a check as a failure and keeps going", async () => {
    expect(await collect(async verifier => {
      await verifier.check("explodes", async () => { throw new Error("RPC refused"); });
      await verifier.check("still-runs", async () => true);
    })).toEqual([
      { id: "explodes", pass: false, evidence: "RPC refused" },
      { id: "still-runs", pass: true },
    ]);
  });

  it("keeps the observations made before the verifier body itself threw", async () => {
    const checks = await collect(async verifier => {
      await verifier.check("recorded", async () => true);
      throw new Error("resolveGadget failed outside a check");
    });
    expect(checks.at(0)).toEqual({ id: "recorded", pass: true });
    expect(checks.at(1)).toMatchObject({ id: "verifier.threw", pass: false });
  });

  it("keeps registration order when checks run concurrently", async () => {
    const checks = await collect(async verifier => {
      await Promise.all([
        verifier.check("slow", async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return true;
        }),
        verifier.check("fast", async () => true),
      ]);
    });
    expect(checks.map(check => check.id)).toEqual(["slow", "fast"]);
  });

  it("settles checks the author started without awaiting", async () => {
    expect(await collect(async verifier => {
      void verifier.check("forgotten", async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return true;
      });
    })).toEqual([{ id: "forgotten", pass: true }]);
  });

  it("marks evidence it could not represent instead of dropping it", async () => {
    const checks = await collect(async verifier => {
      await verifier.check("cyclic", async () => ({ pass: false, evidence: () => "not json" }));
    });
    expect(checks.at(0)?.evidence).toBe("<evidence was not JSON-serializable>");
  });

  it("records a duplicate check ID as a failure rather than losing the turn", async () => {
    const checks = await collect(async verifier => {
      await verifier.check("same", async () => true);
      await verifier.check("same", async () => true);
    });
    expect(checks.at(0)).toEqual({ id: "same", pass: true });
    expect(checks.at(1)?.evidence).toContain("Duplicate eval check ID");
  });
});
