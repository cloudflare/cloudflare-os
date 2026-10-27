import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { afterAll, describe, it, vi } from "vitest";
import { EvalVerifier, type VerifierSession } from "../src/verifier.js";
import { closeViewBrowser } from "../src/view-host.js";
import {
  verifyBillSplitter, verifyChart, verifyPlanPicker,
} from "./chat-views.eval.js";

// The turns' verifiers, run on views written by hand: each must pass a view that does what the
// user asked and fail one that only looks as if it does.

vi.mock("../src/eval.js", () => ({ defineTaskEval: () => {} }));

afterAll(() => closeViewBrowser(), 60_000);

const USAGE = [
  ["Jan", 410], ["Feb", 380], ["Mar", 340], ["Apr", 300], ["May", 290], ["Jun", 360],
  ["Jul", 520], ["Aug", 610], ["Sep", 450], ["Oct", 330], ["Nov", 370], ["Dec", 430],
] as const;
const PLANS = [["Basic", 15], ["Everyday", 30], ["Streamer", 45], ["Family", 80]] as const;

const session: VerifierSession = {
  openGadget: async () => { throw new Error("openGadget is not used by these turns"); },
  connectionDrops: 0,
};

function answer(...views: string[]): AiChatMessage[] {
  return [{
    chatId: 1, sequence: 5, timestamp: new Date(), type: "message",
    author: { type: "agent", id: "agent", name: "agent" },
    message: ["Here it is.", ...views.map(view => `<inline-html>\n${view}\n</inline-html>`)].join("\n\n"),
  }];
}

/** The IDs of the checks `verify` fails on an answer made of `views`. */
async function failed(
    verify: (verifier: EvalVerifier) => Promise<void>, ...views: string[]): Promise<string[]> {
  const checks = await new EvalVerifier(session, [], answer(...views)).collect(verify);
  return checks.filter(check => !check.pass).map(check => check.id);
}

const svg = (body: string) => `<svg width="330" height="240" viewBox="0 0 330 240">${body}</svg>`;
const column = (index: number) => 20 + index * 25;

const barChart = (usage: readonly (readonly [string, number])[]) => svg(usage.map(([month, kwh], index) => `
  <rect x="${column(index)}" y="${200 - kwh / 4}" width="18" height="${kwh / 4}" fill="#f60" />
  <text x="${column(index) + 9}" y="${195 - kwh / 4}" font-size="8" text-anchor="middle">${kwh}</text>
  <text x="${column(index) + 9}" y="215" font-size="8" text-anchor="middle">${month}</text>`).join(""));
// Each month's use against the month after it.
const ROTATED = USAGE.map(([month], index) => [month, USAGE[(index + 1) % USAGE.length]?.[1] ?? 0] as const);

const UNLABELLED_BARS = svg(`
  <text x="0" y="200" font-size="8">0</text><text x="0" y="50" font-size="8">600</text>
  ${USAGE.map(([month, kwh], index) => `
  <rect x="${column(index)}" y="${200 - kwh / 4}" width="18" height="${kwh / 4}" fill="${kwh === 610 ? "#c00" : "#f60"}" />
  <text x="${column(index) + 9}" y="215" font-size="8" text-anchor="middle">${month}</text>`).join("")}`);

// The same bars, filled with a gradient.
const GRADIENT_BARS = UNLABELLED_BARS.replaceAll(/fill="#\w+"/g, 'fill="url(#p)"')
  .replace(/<svg[^>]*>/, tag => `${tag}<defs><linearGradient id="p"><stop offset="0" stop-color="#f60" />` +
    '<stop offset="1" stop-color="#c00" /></linearGradient></defs>');

const LINE_CHART = svg(`
  <polyline fill="none" stroke="#f60" points="${
    USAGE.map(([, kwh], index) => `${column(index) + 9},${200 - kwh / 4}`).join(" ")}" />
  ${USAGE.map(([month], index) =>
    `<text x="${column(index) + 9}" y="215" font-size="8" text-anchor="middle">${month}</text>`).join("")}`);

// The same line, drawn as one segment between each two months.
const SEGMENTS = svg(`${USAGE.slice(1).map(([, kwh], index) => `
  <line stroke="#f60" x1="${column(index) + 9}" y1="${200 - (USAGE[index]?.[1] ?? 0) / 4}" x2="${column(index + 1) + 9}" y2="${200 - kwh / 4}" />`).join("")}
  ${USAGE.map(([month], index) =>
    `<text x="${column(index) + 9}" y="215" font-size="8" text-anchor="middle">${month}</text>`).join("")}`);

// The months down the side and a line across, further right for more use.
const ACROSS_LINE = `<svg width="330" height="330" viewBox="0 0 330 330">
  <polyline fill="none" stroke="#f60" points="${USAGE.map(([, kwh], index) => `${100 + kwh / 4},${25 + 25 * index}`).join(" ")}" />
  ${USAGE.map(([month], index) =>
    `<text x="10" y="${25 + 25 * index}" font-size="8" dominant-baseline="central">${month}</text>`).join("")}</svg>`;

const table = (usage: readonly (readonly [string, number])[]) => `<table><tr><th>Month</th><th>kWh</th></tr>${
  usage.map(([month, kwh]) => `<tr><td>${month}</td><td>${kwh}</td></tr>`).join("")}</table>`;
const TABLE = table(USAGE);

// The months across the top and the use under each, with nothing but the layout to pair them.
const ACROSS = `<div style="display:grid;grid-template-columns:repeat(12,1fr);font-size:10px">${
  USAGE.map(([month]) => `<b>${month}</b>`).join("")}${USAGE.map(([, kwh]) => `<span>${kwh}</span>`).join("")}</div>`;

// HTML bars, each holding its month's label under it, in a chart drawn on a card. `highlight`
// paints one month's bar differently and wraps every bar in a painted column of its own.
const domBars = (usage: readonly (readonly [string, number])[], highlight?: string) => `
  <div style="background:var(--color-kumo-elevated);border:1px solid var(--color-kumo-line);border-radius:8px;padding:8px 8px 24px">
    <div style="display:flex;align-items:flex-end;gap:6px;height:170px">${usage.map(([month, kwh]) => {
      const bar = `<div class="bar" style="position:relative;width:16px;height:${kwh / 4}px;background:${
        month === highlight ? "var(--color-kumo-danger)" : "var(--color-kumo-brand)"}"><span style="position:absolute;top:100%;left:0;font-size:10px">${month}</span></div>`;
      return highlight === undefined ? bar : `<div style="background:#f0f0ef;padding:2px;display:flex;align-items:flex-end;height:160px">${bar}</div>`;
    }).join("")}
    </div>
  </div>`;

const PICKER = `
  <div style="display:flex;flex-wrap:wrap;gap:8px">${PLANS.map(([name, price]) => `
    <div><strong>${name}</strong> <span>$${price}/mo</span> <button data-plan="${name}">Ask</button></div>`).join("")}
  </div>
  <script type="module">
    for (const button of document.querySelectorAll("button")) {
      button.addEventListener("click", () => agent.send("Tell me more about " + button.dataset.plan));
    }
  </script>`;

const splitter = (input: string, formula = "184.6 * 1.18 / Number(people.value)", listen = "input") => `
  <label>People ${input}</label>
  <p>Each pays <output id="each"></output></p>
  <script type="module">
    const people = document.getElementById("people");
    const show = () => { document.getElementById("each").textContent = "$" + (${formula}).toFixed(2); };
    people.addEventListener("${listen}", show);
    show();
  </script>`;

describe.concurrent("chat-views verifiers", { timeout: 120_000 }, () => {
  describe("the chart", () => {
    it("passes a chart that shows each month's use", async ({ expect }) => {
      expect(await failed(verifyChart, barChart(USAGE))).toEqual([]);
      expect(await failed(verifyChart, TABLE)).toEqual([]);
      expect(await failed(verifyChart, ACROSS)).toEqual([]);
    });

    it("passes a chart whose marks plot each month's use, unlabelled", async ({ expect }) => {
      expect(await failed(verifyChart, UNLABELLED_BARS)).toEqual([]);
      expect(await failed(verifyChart, LINE_CHART)).toEqual([]);
      expect(await failed(verifyChart, SEGMENTS)).toEqual([]);
      expect(await failed(verifyChart, SEGMENTS.replace('stroke="#f60"', 'stroke="#c00"'))).toEqual([]);
      expect(await failed(verifyChart, ACROSS_LINE)).toEqual([]);
    });

    it("passes a line, an area or bars painted by a style or a gradient", async ({ expect }) => {
      const painted = [
        `<style>polyline { stroke: currentColor }</style>${LINE_CHART.replace(' stroke="#f60"', "")}`,
        UNLABELLED_BARS.replaceAll(/fill="(#\w+)"/g, 'fill="none" stroke="$1"'),
        GRADIENT_BARS,
        LINE_CHART.replace(' fill="none" stroke="#f60"', ' fill="#f60"')
          .replace(/points="([^"]*)"/, (_, points: string) => `points="${points} ${column(11) + 9},200 ${column(0) + 9},200"`),
      ];
      expect(await Promise.all(painted.map(chart => failed(verifyChart, chart)))).toEqual(painted.map(() => []));
    });

    it("passes HTML bars that hold their labels, on a card or in painted columns", async ({ expect }) => {
      expect(await failed(verifyChart, domBars(USAGE))).toEqual([]);
      expect(await failed(verifyChart, domBars(USAGE, "Aug"))).toEqual([]);
    });

    it("fails month names without their use", async ({ expect }) => {
      expect(await failed(verifyChart, `<p>${USAGE.map(([month]) => month).join(" ")}</p>`))
        .toEqual(["shows-each-month-use"]);
    });

    it("fails values shown against the wrong months", async ({ expect }) => {
      expect(await failed(verifyChart, barChart(ROTATED))).toEqual(["shows-each-month-use"]);
      expect(await failed(verifyChart, domBars(ROTATED))).toEqual(["shows-each-month-use"]);
      expect(await failed(verifyChart, table(ROTATED))).toEqual(["shows-each-month-use"]);
    });

    it("fails month names beside a line or bars that paint nothing", async ({ expect }) => {
      const unpainted = [
        LINE_CHART.replace(' stroke="#f60"', ""),
        LINE_CHART.replace('stroke="#f60"', 'stroke="transparent"'),
        LINE_CHART.replace('stroke="#f60"', 'stroke="#f60" stroke-opacity="0"'),
        LINE_CHART.replace('stroke="#f60"', 'stroke="#f60" stroke-width="0"'),
        SEGMENTS.replaceAll('stroke="#f60"', 'fill="#f60"'),
        UNLABELLED_BARS.replaceAll(/fill="#\w+"/g, 'fill="none"'),
      ];
      expect(await Promise.all(unpainted.map(chart => failed(verifyChart, chart))))
        .toEqual(unpainted.map(() => ["shows-each-month-use"]));
    });

    it("fails a chart nobody can see", async ({ expect }) => {
      expect(await failed(verifyChart, `<style>body { display: none; }</style>${TABLE}`))
        .toEqual(expect.arrayContaining(["labels-every-month", "shows-each-month-use", "view-runs"]));
      expect(await failed(verifyChart, `<div style="opacity:0">${TABLE}</div>`))
        .toEqual(expect.arrayContaining(["labels-every-month", "shows-each-month-use", "view-runs"]));
    });
  });

  describe("the plan picker", () => {
    it("passes a picker whose choice asks about it", async ({ expect }) => {
      expect(await failed(verifyPlanPicker, PICKER)).toEqual([]);
    });

    it("passes a picker whose choice asks about it after a moment", async ({ expect }) => {
      expect(await failed(verifyPlanPicker, PICKER.replace(
          `() => agent.send("Tell me more about " + button.dataset.plan)`,
          `() => setTimeout(() => agent.send("Tell me more about " + button.dataset.plan), 300)`))).toEqual([]);
    });

    it("passes the plans compared in a line of text", async ({ expect }) => {
      const picker = (line: string) => `
        <p>${line}</p>
        <button>Ask about Streamer</button>
        <script type="module">
          document.querySelector("button").addEventListener("click", () => agent.send("Tell me about Streamer"));
        </script>`;
      expect(await failed(verifyPlanPicker, picker("Basic $15 · Everyday $30 · Streamer $45 · Family $80"))).toEqual([]);
      expect(await failed(verifyPlanPicker, picker("$15 Basic · $30 Everyday · $45 Streamer · $80 Family"))).toEqual([]);
      expect(await failed(verifyPlanPicker, picker("Basic $15 Everyday $30 Streamer $45 Family $80"))).toEqual([]);
    });

    it("fails prices shown against the wrong plans", async ({ expect }) => {
      expect(await failed(verifyPlanPicker, PICKER.replace("$15/mo", "$tmp/mo").replace("$80/mo", "$15/mo").replace("$tmp/mo", "$80/mo")))
        .toEqual(["compares-every-plan"]);
    });

    it("fails a message sent as the view loads, from a button that does nothing", async ({ expect }) => {
      expect(await failed(verifyPlanPicker, `
        <ul><li>Basic $15</li><li>Everyday $30</li><li>Family $80</li></ul>
        <button id="pick">Streamer $45</button>
        <script type="module">
          document.getElementById("pick").onclick = agent.send("Tell me more about Streamer");
        </script>`)).toEqual(["picking-a-plan-asks-about-it"]);
    });

    it("fails a choice the pointer cannot reach", async ({ expect }) => {
      expect(await failed(verifyPlanPicker, `
        <ul><li>Basic $15</li><li>Everyday $30</li><li>Family $80</li></ul>
        <button id="pick" style="pointer-events:none"><span>Streamer $45</span></button>
        <script type="module">
          document.getElementById("pick").addEventListener("click", () => agent.send("Tell me more about Streamer"));
        </script>`)).toEqual(["picking-a-plan-asks-about-it"]);
    });

    it("runs the view rules on every view of the answer", async ({ expect }) => {
      expect(await failed(verifyPlanPicker,
          `<p>Plans</p><script type="module">throw new Error("broken");</script>`, PICKER))
        .toEqual(["view-runs.view-1"]);
    });
  });

  describe("the bill splitter", () => {
    it("passes a splitter that splits again for five", async ({ expect }) => {
      expect(await failed(verifyBillSplitter,
          splitter(`<input id="people" type="number" min="1" value="4">`))).toEqual([]);
      expect(await failed(verifyBillSplitter,
          splitter(`<input id="people" type="number" min="1" value="4">`, undefined, "change"))).toEqual([]);
      expect(await failed(verifyBillSplitter,
          splitter(`<input id="people" type="range" min="1" max="10" value="4">`))).toEqual([]);
    });

    it("passes a splitter whose hint for one more person already shows the share for five", async ({ expect }) => {
      expect(await failed(verifyBillSplitter, `
        <input id="people" type="number" min="1" value="4">
        <p id="each"></p><p id="hint"></p>
        <script type="module">
          const people = document.getElementById("people");
          const share = count => "$" + (184.6 * 1.18 / count).toFixed(2);
          const show = () => {
            const count = Number(people.value);
            document.getElementById("each").textContent = "Each " + share(count);
            document.getElementById("hint").textContent = "With " + (count + 1) + " people: " + share(count + 1);
          };
          people.addEventListener("input", show);
          show();
        </script>`)).toEqual([]);
    });

    it("passes a splitter that shows each share in a read-only field", async ({ expect }) => {
      expect(await failed(verifyBillSplitter, `
        <label>People <input id="people" type="number" min="1" value="4"></label>
        <label>Each pays <input id="each" readonly></label>
        <script type="module">
          const people = document.getElementById("people");
          const show = () => {
            document.getElementById("each").value = "$" + (184.6 * 1.18 / Number(people.value)).toFixed(2);
          };
          people.addEventListener("input", show);
          show();
        </script>`)).toEqual([]);
    });

    it("fails a share in a field nobody can see", async ({ expect }) => {
      expect(await failed(verifyBillSplitter, `
        <label>People <input id="people" type="number" min="1" value="4"></label>
        <input id="each" readonly style="opacity:0">
        <script type="module">
          const people = document.getElementById("people");
          const show = () => {
            document.getElementById("each").value = "$" + (184.6 * 1.18 / Number(people.value)).toFixed(2);
          };
          people.addEventListener("input", show);
          show();
        </script>`)).toEqual(["shows-each-share", "splits-again-for-five"]);
    });

    it("passes a splitter that redraws its result", async ({ expect }) => {
      expect(await failed(verifyBillSplitter, `
        <input id="people" type="number" min="1" value="4">
        <div id="result"></div><p id="hint"></p>
        <script type="module">
          const people = document.getElementById("people");
          const share = count => "$" + (184.6 * 1.18 / count).toFixed(2);
          const show = () => {
            const count = Number(people.value);
            const label = document.createElement("b");
            label.textContent = "Each ";
            const amount = document.createElement("span");
            amount.textContent = share(count);
            document.getElementById("result").replaceChildren(label, amount);
            document.getElementById("hint").textContent = "With " + (count + 1) + " people: " + share(count + 1);
          };
          people.addEventListener("input", show);
          show();
        </script>`)).toEqual([]);
    });

    it("fails a party size the user cannot edit", async ({ expect }) => {
      expect(await failed(verifyBillSplitter,
          splitter(`<input id="people" type="number" value="4" readonly>`, undefined, "change")))
        .toEqual(["splits-again-for-five"]);
      expect(await failed(verifyBillSplitter, `
        <input type="number" value="4" style="opacity:0">
        ${splitter(`<input id="people" type="number" value="4" readonly>`, undefined, "change")}`))
        .toEqual(["splits-again-for-five"]);
    });

    it("fails a five-person share that was there before the edit", async ({ expect }) => {
      expect(await failed(verifyBillSplitter,
          `<p>Four people: $54.46. Five people: $43.57.</p><input type="number" value="4">`))
        .toEqual(["splits-again-for-five"]);
    });

    it("fails negative shares", async ({ expect }) => {
      expect(await failed(verifyBillSplitter, splitter(
          `<input id="people" type="number" value="4">`, "-184.6 * 1.18 / Number(people.value)")))
        .toEqual(["shows-each-share", "splits-again-for-five"]);
    });
  });
});
