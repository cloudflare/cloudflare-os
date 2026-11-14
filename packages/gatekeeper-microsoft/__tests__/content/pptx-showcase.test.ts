// Writes showcase decks for looking at in PowerPoint and Microsoft 365, when M365_SHOWCASE_OUT names a
// directory: `M365_SHOWCASE_OUT=/tmp/m365-out/powerpoint npx vitest run __tests__/content/pptx-showcase.test.ts`.
// M365_SHOWCASE_TEMPLATE may name a PowerPoint-made deck to use as a template and edit too.
// Every deck it writes must also pass the structural checks.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editPptx } from "../../src/content/pptx-edit";
import type { PptxImage } from "../../src/content/pptx-images";
import { markdownToPptx } from "../../src/content/pptx-write";
import { chartPng, photoPng } from "./pptx-test-images";
import { validatePptx } from "./pptx-validate";

const OUT = process.env.M365_SHOWCASE_OUT;
const TEMPLATE = process.env.M365_SHOWCASE_TEMPLATE;
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url).pathname));

const images = new Map<string, PptxImage>([
  ["Reports/q3-revenue.png", { bytes: chartPng(), mimeType: "image/png" }],
  ["Photos/new-office.png", { bytes: photoPng(), mimeType: "image/png" }],
]);

export const SHOWCASE_DECK = `# Northwind Platform Review
Q3 2026 · Engineering leadership offsite

# Where we are

Platform reliability is **ahead of plan** and costs are *down*. Two risks need decisions today.

- Availability at **99.982%**, above the 99.95% target
- Infra spend down 14% after the [storage migration](https://example.com/storage)
  - Cold tier now holds 61% of bytes
  - Egress renegotiated with two vendors
- Incident count flat; time to mitigate down 22%

> Notes: Open with the availability number, then hand to Priya for costs.

# Reliability

# Revenue is tracking the plan

- Q3 revenue **$14.2M**, 6% over plan
- Growth led by the enterprise tier
- Self-serve flat; pricing test starts in November

+++

![Revenue by quarter](Reports/q3-revenue.png)

# Build or buy the quota console

### Build
- Fits our approval model exactly
- Two engineers for one quarter
- We own the roadmap

+++

### Buy
- Live in three weeks
- $180k a year, rising with seats
- Approval flow needs a workaround

# Roadmap

1. Finish regional failover (October)
2. Ship the self-serve quota console
   1. Read-only view first
   2. Edits behind approval
3. Retire the legacy job runner ~~in Q4~~ by January

## Decisions needed

- [x] Approve failover budget
- [ ] Choose the quota console owner

# Quarterly numbers

| Metric | Q1 | Q2 | Q3 |
|:-------|---:|---:|---:|
| Availability | 99.95% | 99.97% | 99.98% |
| Infra spend | $4.1M | $3.8M | $3.5M |
| Incidents | 14 | 12 | 12 |
| Time to mitigate | 41 min | 36 min | 32 min |

Spend excludes one-off migration costs.

# The new deploy check

\`\`\`ts
export async function verifyDeploy(release: Release): Promise<Verdict> {
  const health = await probe(release.canary, { timeoutMs: 5_000 });
  if (health.errorRate > 0.01) return { ok: false, reason: "canary errors" };
  return { ok: true };
}
\`\`\`

The check runs on every canary before traffic shifts.

<!-- layout: Picture with Caption -->
# Our new Lisbon office

![The Lisbon office, from the river](Photos/new-office.png)

Opened in September with room for 120. The platform team moves in next month.

# What customers told us

> "The dashboard finally answers the question I actually have." — Operations lead, retail customer

> Notes: Read the quote aloud. Then mention we interviewed 18 customers.

# Q3 at a glance

![Revenue by quarter](Reports/q3-revenue.png)

---

Questions go to #platform-review, or email [the team](mailto:platform@example.com).

# Thank you
`;

describe.skipIf(!OUT)("showcase decks", () => {
  const write = async (name: string, bytes: Uint8Array) => {
    await validatePptx(bytes);
    mkdirSync(OUT!, { recursive: true });
    writeFileSync(join(OUT!, name), bytes);
  };

  it("writes the default-design deck", async () => {
    await write("showcase.pptx", await markdownToPptx(SHOWCASE_DECK, { images, author: "Avery Chen" }));
  });

  it("writes a deck on a PowerPoint-authored template", async () => {
    await write("template-python-pptx.pptx", await markdownToPptx(SHOWCASE_DECK, { images, template: fixture("python-pptx-template.potx") }));
    if (TEMPLATE && existsSync(TEMPLATE)) {
      await write("template-real.pptx", await markdownToPptx(SHOWCASE_DECK, { images, template: new Uint8Array(readFileSync(TEMPLATE)) }));
    }
  });

  it("writes an edited PowerPoint-authored deck", async () => {
    const { bytes, changes } = await editPptx(fixture("python-pptx-deck.pptx"), [
      { setText: { slide: 1, placeholder: "title", markdown: "Northwind Quarterly Review — FY26 Q3" } },
      { find: "Quarterly revenue grew 12%", replace: "Quarterly revenue grew 14%" },
      { setText: { slide: 2, placeholder: "body", markdown: "- Revenue grew **14%**\n- Churn fell in every region\n  - EMEA fell the most\n- Margin up 2 points" } },
      { duplicateSlide: 2 },
      { setText: { slide: 3, placeholder: "title", markdown: "Highlights (EMEA)" } },
      { moveSlide: 5, to: 2 },
      { setNotes: { slide: 1, markdown: "Welcome everyone; introduce the finance team." } },
      { addSlides: "# Revenue by quarter\n\n- Enterprise drove the growth\n\n+++\n\n![Revenue by quarter](Reports/q3-revenue.png)", after: 3 },
    ], { images });
    expect(changes.length).toBeGreaterThan(5);
    await write("edited-python-pptx.pptx", bytes);
    if (TEMPLATE && existsSync(TEMPLATE)) {
      const real = await editPptx(new Uint8Array(readFileSync(TEMPLATE)), [
        { duplicateSlide: 1 },
        { setText: { slide: 2, placeholder: "title", markdown: "A copy, retitled" } },
        { moveSlide: 2, to: 3 },
        { setNotes: { slide: 1, markdown: "Notes added by the editor." } },
        { addSlides: "# Added slide\n\n- On this deck's own layout\n- With its own fonts" },
      ], { images });
      await write("edited-real.pptx", real.bytes);
    }
  });
});
