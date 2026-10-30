import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { embeddedViewHtml } from "@gadgets/workshop-shared/embedded-views";
import { parseInlineHtmlBlocks } from "@gadgets/workshop-shared/inline-html-blocks";
import { asEvidence } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";
import type { RenderedView, SeriesMark } from "../src/view-host.js";

// Checks for the tasks that test how the agent answers: with a live view, a Gadget, or prose
// (agent.ts, "Workspaces" and "Live views"), and whether its views keep the rules there.

/**
 * A view the agent showed this turn: its HTML as its frame runs it, the sequence of the message it
 * is in, and whether `executeCode` showed it with `embedView` rather than the answer's text.
 */
export type TurnView = { sequence: number; html: string; fromCode: boolean };

function agentMessages(messages: readonly AiChatMessage[]) {
  return messages.flatMap(message =>
    message.type === "message" && message.author.type === "agent" ? [message] : []);
}

function turnToolCalls(messages: readonly AiChatMessage[]) {
  return agentMessages(messages).flatMap(message => message.toolCalls ?? []);
}

/**
 * This turn's views, oldest first: closed `<inline-html>` blocks and the views its `executeCode`
 * calls showed with `embedView`, as their frames run them. Also the start of each block it never
 * closed.
 */
function turnViews(verifier: EvalVerifier): { views: TurnView[]; open: string[] } {
  const views: TurnView[] = [];
  const open: string[] = [];
  for (const message of agentMessages(verifier.messages)) {
    for (const segment of parseInlineHtmlBlocks(message.message)) {
      if (segment.kind === "block") views.push({ sequence: message.sequence, html: segment.html, fromCode: false });
      else if (segment.kind === "open") open.push(segment.text.slice(0, 200));
    }
    for (const call of message.toolCalls ?? []) {
      if (call.toolName !== "executeCode") continue;
      for (const view of call.views ?? []) {
        views.push({ sequence: message.sequence, html: embeddedViewHtml(view), fromCode: true });
      }
    }
  }
  return { views, open };
}

function lastReply(verifier: EvalVerifier): string {
  return (verifier.replies.at(-1) ?? "").slice(0, 1_000);
}

/** The Gadgets this turn created, as createGadget took them. */
function createdGadgets(messages: readonly AiChatMessage[]) {
  return turnToolCalls(messages).flatMap(call =>
    call.toolName === "createGadget" && call.error === undefined ? [call.input] : []);
}

/** The turn answers with a view and closes every view it opens. Returns its last view. */
export async function checkAnswersWithView(verifier: EvalVerifier): Promise<TurnView | undefined> {
  const { views, open } = turnViews(verifier);
  await verifier.check("answers-with-a-view", async () => ({
    pass: views.length > 0 && open.length === 0,
    evidence: asEvidence({ views: views.length, open, reply: lastReply(verifier) }),
  }));
  return views.at(-1);
}

/** The turn answers in plain text: a reply, and no view. */
export async function checkAnswersInProse(verifier: EvalVerifier): Promise<void> {
  await verifier.check("answers-in-prose", async () => {
    const { views, open } = turnViews(verifier);
    return {
      pass: lastReply(verifier).trim() !== "" && views.length === 0 && open.length === 0,
      evidence: asEvidence({ views: views.length, open: open.length, reply: lastReply(verifier) }),
    };
  });
}

export async function checkMakesNoGadget(
    verifier: EvalVerifier, id = "makes-no-gadget"): Promise<void> {
  await verifier.check(id, async () => {
    const created = createdGadgets(verifier.messages);
    return { pass: created.length === 0, evidence: asEvidence(created) };
  });
}

/** The turn creates a Gadget and gives it code: a server.js and a client.js, or a blueprint's. */
export async function checkBuildsGadget(verifier: EvalVerifier): Promise<void> {
  await verifier.check("builds-a-gadget", async () => {
    const writes = turnToolCalls(verifier.messages).flatMap(call =>
      (call.toolName === "writeFile" || call.toolName === "editFile") && call.error === undefined
        ? [{ gadget: call.input.workpiece, file: call.input.filename.replace(/^\.?\//, "") }] : []);
    const wrote = (gadget: string, file: string) =>
      writes.some(write => write.gadget === gadget && write.file === file);
    const gadgets = createdGadgets(verifier.messages).map(gadget => ({
      ...gadget,
      server: wrote(gadget.bindingName, "server.js"),
      client: wrote(gadget.bindingName, "client.js"),
    }));
    return {
      pass: gadgets.some(gadget =>
        gadget.blueprintId !== undefined || (gadget.server && gadget.client)),
      evidence: asEvidence(gadgets),
    };
  });
}

/**
 * Runs `view`, one of this turn's views, through `body`'s checks, then runs the checks every view
 * must pass on each of the turn's views, since the Workshop shows them all. When the turn showed
 * more than one, those checks' IDs end in `.view-N`, N the view's place in the turn. Each page
 * closes when its checks finish.
 */
export async function checkView(
    verifier: EvalVerifier, view: TurnView,
    body: (rendered: RenderedView) => Promise<void> = async () => {}): Promise<void> {
  const found = turnViews(verifier).views;
  const views = found.some(other => same(other, view)) ? found : [view];
  let bodyRan = false;
  for (const [index, each] of views.entries()) {
    await using rendered = await verifier.openView(each.html);
    if (!bodyRan && same(each, view)) {
      bodyRan = true;
      await body(rendered);
    }
    await checkViewRules(verifier, each, rendered, views.length === 1 ? "" : `.view-${index + 1}`);
  }
}

function same(a: TurnView, b: TurnView): boolean {
  return a.sequence === b.sequence && a.html === b.html;
}

const JAVASCRIPT_TYPE = /^(?:(?:text|application)\/(?:x-)?(?:javascript|ecmascript))?$/i;

/** The script tags whose code runs as a classic script rather than a module. */
function classicScripts(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>/gi)].map(match => match[0]).filter(tag => {
    const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(tag)?.[1];
    return type === undefined || JAVASCRIPT_TYPE.test(type);
  });
}

// The rules a view must keep, from agent.ts. The check that narrows its frame goes first, so that
// "view-runs" also counts any error it causes.
async function checkViewRules(
    verifier: EvalVerifier, view: TurnView, rendered: RenderedView, suffix: string): Promise<void> {
  await verifier.check(`view-code-is-in-module-scripts${suffix}`, async () => {
    const classic = classicScripts(view.html);
    return { pass: classic.length === 0, evidence: asEvidence(classic) };
  });
  await verifier.check(`view-uses-no-viewport-height${suffix}`, async () => {
    const found = await rendered.viewportHeights();
    return { pass: found.length === 0, evidence: asEvidence(found) };
  });
  await verifier.check(`view-fits-a-phone${suffix}`, async () => {
    const overflow = await rendered.overflowAtPhoneWidth();
    return { pass: overflow <= 1, evidence: asEvidence({ pixelsTooWide: overflow }) };
  });
  await verifier.check(`view-runs${suffix}`, async () => {
    const visible = await rendered.visible();
    return {
      pass: rendered.unsettled === undefined && rendered.errors.length === 0 && visible,
      evidence: asEvidence({ unsettled: rendered.unsettled ?? null, errors: rendered.errors, visible }),
    };
  });
  await verifier.check(`view-uses-no-network${suffix}`, async () => ({
    pass: rendered.requests.length === 0,
    evidence: asEvidence(rendered.requests),
  }));
}

/**
 * Whether `text` shows `amount`, written as 420, 420.00, $420, 1,420.50 or, below zero, -$54.46
 * or $-54.46, and not as part of a longer number such as 4200 or 0.42.
 */
export function showsAmount(text: string, amount: number): boolean {
  return countAmount(text, amount) > 0;
}

/** How many times `text` shows `amount`, written as `showsAmount` reads it. */
export function countAmount(text: string, amount: number): number {
  return amounts(text).filter(shown => Math.abs(shown - amount) < 0.005).length;
}

// A minus sign right before an amount or its $, where it follows no letter or digit, since "Jan-410"
// and "5-10" join two things. Read together, an amount and a percentage after it, as in "$420.00"
// "60%", run to "$420.0060%": the first two decimals then end the amount.
const AMOUNT = /(?:(?<![\p{L}\p{N}])([-−])\$?|\$([-−]))?(?<![\d.])(\d+)(?:\.(\d+))?(?!\d)/gu;

function amounts(text: string): number[] {
  const plain = text.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  return [...plain.matchAll(AMOUNT)].map(match => {
    const [whole, before, after, units = "", decimals = ""] = match;
    const rest = plain.slice(match.index + whole.length);
    const cents = decimals.length > 2 && /^\d+(?:\.\d+)?%/.test(decimals.slice(2) + rest)
      ? decimals.slice(0, 2) : decimals;
    const value = Number(cents === "" ? units : `${units}.${cents}`);
    return before === undefined && after === undefined ? value : -value;
  });
}

/**
 * Whether one series of `marks` (see `Series`) plots `values`, one per label: each mark where a
 * straight scale would put its value, to within 2% of the values' range, higher for a higher
 * value, and the marks spread at least 10px.
 */
export function plotsValues(marks: readonly SeriesMark[], values: readonly number[]): boolean {
  const series = Map.groupBy(marks, mark => `${mark.axis} ${mark.key}`);
  return [...series.values()].some(group => {
    const points = values.flatMap((value, label) => {
      const at = group.find(mark => mark.label === label)?.at;
      return at === undefined ? [] : [{ value, at }];
    });
    if (points.length !== values.length || points.length < 2) return false;
    const mean = (of: (point: { value: number; at: number }) => number) =>
      points.reduce((sum, point) => sum + of(point), 0) / points.length;
    const meanValue = mean(point => point.value);
    const meanAt = mean(point => point.at);
    const slope = mean(point => (point.value - meanValue) * (point.at - meanAt)) /
      mean(point => (point.value - meanValue) ** 2);
    const range = Math.max(...values) - Math.min(...values);
    // Screen y grows downward, so a higher value sits higher in a column.
    const rising = group[0]?.axis === "y" ? -slope : slope;
    const tolerance = Math.max(1, Math.abs(slope) * range * 0.02);
    return rising * range >= 10 &&
      points.every(point => Math.abs(meanAt + slope * (point.value - meanValue) - point.at) <= tolerance);
  });
}

/** Whether `text` mentions `word`, ignoring case. */
export function mentions(text: unknown, word: string): boolean {
  return typeof text === "string" && text.toLowerCase().includes(word.toLowerCase());
}
