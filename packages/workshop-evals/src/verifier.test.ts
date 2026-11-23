import type { WorkpieceSummary } from "@gadgets/workshop-shared/api";
import { afterAll, describe, expect, it } from "vitest";
import { EvalVerifier, resolveGadget, type VerifierSession } from "./verifier.js";
import type { EvalCheck } from "./task.js";
import { closeViewBrowser, ViewHostError } from "./view-host.js";

afterAll(() => closeViewBrowser());

const unusedSession: VerifierSession = {
  openGadget: async () => { throw new Error("openGadget is not used by this test"); },
  readBlobText: async () => { throw new Error("readBlobText is not used by this test"); },
  connectionDrops: 0,
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

  it("fails verification when a check fails as the Workshop connection drops", async () => {
    const session = { ...unusedSession, connectionDrops: 0 };
    await expect(new EvalVerifier(session, []).collect(async verifier => {
      await verifier.check("reads", async () => {
        session.connectionDrops++;
        throw new Error("Network connection lost.");
      });
    })).rejects.toThrow("The Workshop connection dropped during verification");
  });

  it("keeps a verification whose checks passed while the connection dropped", async () => {
    const session = { ...unusedSession, connectionDrops: 0 };
    expect(await new EvalVerifier(session, []).collect(async verifier => {
      await verifier.check("reads", async () => {
        session.connectionDrops++;
        return { pass: true };
      });
    })).toEqual([{ id: "reads", pass: true }]);
  });

  it("fails verification when the browser running a view fails in a check", async () => {
    const failure = new ViewHostError("Chromium closed");
    await expect(collect(async verifier => {
      await verifier.check("renders", async () => { throw failure; });
      await verifier.check("still-runs", async () => ({ pass: true }));
    })).rejects.toBe(failure);
  });

  it("fails verification when the browser running a view fails outside a check", async () => {
    const failure = new ViewHostError("Chromium did not start");
    await expect(collect(async verifier => {
      await verifier.check("before", async () => ({ pass: true }));
      throw failure;
    })).rejects.toBe(failure);
  });

  it("records a view's own error as a failed check, not a failed verification", async () => {
    expect(await collect(async verifier => {
      await verifier.check("renders", async () => { throw new Error("The view never loaded"); });
    })).toEqual([{ id: "renders", pass: false, evidence: "Error: The view never loaded" }]);
  });
});

describe("EvalVerifier.openView", { timeout: 60_000 }, () => {
  it("gives the view its message's pinned files, read through the session", async () => {
    const read: string[] = [];
    const session: VerifierSession = { ...unusedSession, readBlobText: async oid => { read.push(oid); return '{"Food":420}'; } };
    const verifier = new EvalVerifier(session, []);
    await using view = await verifier.openView(`
      <p id="out"></p>
      <script type="module">
        document.getElementById("out").textContent = (await embeds.json("worktree://OUTPUTS/totals.json")).Food;
      </script>`, { "worktree://OUTPUTS/totals.json": "a".repeat(40) });
    expect((await view.text()).trim()).toBe("420");
    expect(read).toEqual(["a".repeat(40)]);
  });
});
