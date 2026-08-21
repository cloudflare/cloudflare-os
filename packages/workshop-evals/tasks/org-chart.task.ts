import { z } from "zod";
import { defineEvalTask } from "../src/task.js";

const ReportsSchema = z.object({
  direct: z.array(z.string()),
  total: z.number().int().nonnegative(),
}).strict();

interface OrgChartApi {
  load(input: { text: string }): Promise<{ ok: true; people: number } | { ok: false; error: string }>;
  reportsOf(input: { name: string }): Promise<z.infer<typeof ReportsSchema>>;
  roots(): Promise<string[]>;
}

const INDENTED = `Dana Whitfield
  Marcus Cole
    Priya Raman
    Tomas Eklund
  Ines Duarte
    Wei Zhang`;

const SENTENCES = `Marcus Cole reports to Dana Whitfield.
Priya Raman reports to Marcus Cole.
Tomas Eklund reports to Marcus Cole.
Ines Duarte reports to Dana Whitfield.
Wei Zhang reports to Ines Duarte.`;

const CSV = `name,manager
Dana Whitfield,
Marcus Cole,Dana Whitfield
Priya Raman,Marcus Cole
Tomas Eklund,Marcus Cole
Ines Duarte,Dana Whitfield
Wei Zhang,Ines Duarte`;

/**
 * Tolerant parsing of three shapes people actually paste, reduced to one hierarchy.
 * The same six-person org is expressed three ways, so every format must produce identical answers.
 */
export default defineEvalTask({
  id: "org-chart",
  title: "Org chart from pasted text",
  expectation: "required",
  turns: [{
    prompt: `Build a Gadget named exactly "Chart" that turns pasted team information into an org
chart. People paste wildly different things, so accept all of these and treat them as equivalent:
indented outlines, one "X reports to Y" sentence per line, and CSV with name and manager columns.
Draw the resulting hierarchy clearly.

It also needs a stable server RPC taking and returning plain data, so I can verify it:
- load({ text: string }) -> { ok: true, people: number } | { ok: false, error: string }, replacing
  any previously loaded chart
- roots() -> names with no manager
- reportsOf({ name: string }) -> { direct: string[], total: number } where direct is the immediate
  reports and total counts everyone underneath, however deep. An unknown name gives
  { direct: [], total: 0 }.`,
    verify: async verifier => {
      for (const [format, text] of Object.entries({ INDENTED, SENTENCES, CSV })) {
        await verifier.check(`parses-${format.toLowerCase()}`, async () => {
          using api = await verifier.connect<OrgChartApi>("Chart");
          const loaded = await api.load({ text });
          const roots = z.array(z.string()).parse(await api.roots());
          const dana = ReportsSchema.parse(await api.reportsOf({ name: "Dana Whitfield" }));
          const marcus = ReportsSchema.parse(await api.reportsOf({ name: "Marcus Cole" }));
          const wei = ReportsSchema.parse(await api.reportsOf({ name: "Wei Zhang" }));
          const missing = ReportsSchema.parse(await api.reportsOf({ name: "Nobody At All" }));
          return {
            pass: loaded.ok && loaded.people === 6 &&
              roots.length === 1 && roots.at(0) === "Dana Whitfield" &&
              dana.total === 5 && dana.direct.toSorted().join("|") === "Ines Duarte|Marcus Cole" &&
              marcus.total === 2 && wei.total === 0 &&
              missing.total === 0 && missing.direct.length === 0,
            evidence: { loaded, roots, dana, marcus, wei, missing },
          };
        });
      }
    },
  }],
});
