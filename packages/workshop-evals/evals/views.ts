import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { embeddedViewHtml } from "@gadgets/workshop-shared/embedded-views";
import { parseGadgetUiBlocks } from "@gadgets/workshop-shared/gadget-ui-blocks";
import { asEvidence } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";
import type { RenderedView } from "../src/view-host.js";

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
 * This turn's views, oldest first: closed `<gadget-ui>` blocks and the views its `executeCode`
 * calls showed with `embedView`, as their frames run them. Also the start of each block it never
 * closed.
 */
function turnViews(verifier: EvalVerifier): { views: TurnView[]; open: string[] } {
  const views: TurnView[] = [];
  const open: string[] = [];
  for (const message of agentMessages(verifier.messages)) {
    for (const segment of parseGadgetUiBlocks(message.message)) {
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

/** Runs the turn's last view through `run`, if the turn has one. */
export async function checkLastView(
    verifier: EvalVerifier, run: (view: TurnView) => Promise<void>): Promise<void> {
  const view = turnViews(verifier).views.at(-1);
  if (view !== undefined) await run(view);
}

/** Runs `view`: `body`'s checks, then the checks every view must pass. The page closes when they finish. */
export async function checkView(
    verifier: EvalVerifier, view: TurnView,
    body: (rendered: RenderedView) => Promise<void> = async () => {}): Promise<void> {
  await using rendered = await verifier.openView(view.html);
  await body(rendered);
  await checkViewRules(verifier, view, rendered);
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
    verifier: EvalVerifier, view: TurnView, rendered: RenderedView): Promise<void> {
  await verifier.check("view-code-is-in-module-scripts", async () => {
    const classic = classicScripts(view.html);
    return { pass: classic.length === 0, evidence: asEvidence(classic) };
  });
  await verifier.check("view-uses-no-viewport-height", async () => {
    const found = await rendered.viewportHeights();
    return { pass: found.length === 0, evidence: asEvidence(found) };
  });
  await verifier.check("view-fits-a-phone", async () => {
    const overflow = await rendered.overflowAtPhoneWidth();
    return { pass: overflow <= 1, evidence: asEvidence({ pixelsTooWide: overflow }) };
  });
  await verifier.check("view-runs", async () => {
    const visible = await rendered.visible();
    return {
      pass: rendered.unsettled === undefined && rendered.errors.length === 0 && visible,
      evidence: asEvidence({ unsettled: rendered.unsettled ?? null, errors: rendered.errors, visible }),
    };
  });
  await verifier.check("view-uses-no-network", async () => ({
    pass: rendered.requests.length === 0,
    evidence: asEvidence(rendered.requests),
  }));
  await verifier.check("view-shows-data-as-text", async () => ({
    pass: rendered.markup.length === 0,
    evidence: asEvidence(rendered.markup),
  }));
}

/**
 * Whether `text` shows `amount`, written as 420, 420.00, $420 or 1,420.50, and not as part of a
 * longer number such as 4200 or 0.42.
 */
export function showsAmount(text: string, amount: number): boolean {
  const plain = text.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  return [...plain.matchAll(/(?<![\d.])\d+(?:\.\d+)?(?!\d)/g)]
    .some(match => Math.abs(Number(match[0]) - amount) < 0.005);
}

/** Whether `text` mentions `word`, ignoring case. */
export function mentions(text: unknown, word: string): boolean {
  return typeof text === "string" && text.toLowerCase().includes(word.toLowerCase());
}
