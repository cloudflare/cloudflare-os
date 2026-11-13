// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ActionLogEntry, AiChatMetadata } from "@gadgets/workshop-shared/api";
import { entry, makeOverseer, makeTestRoot } from "../../../action-test-harness";
import { RESTRICTED_APPROVAL_COPY } from "../../../components/RestrictedApprovalNotice";
import { AgentListRow } from "./AgentListRow";
import { deriveAgents } from "./agentList";

vi.mock("@cloudflare/kumo", async importOriginal => {
  const actual = await importOriginal<typeof import("@cloudflare/kumo")>();
  // Render the popover inline, trigger and content alike, so the request a row holds can be
  // asserted on and answered without a real layout to anchor to.
  const Pass = ({children}: {children?: React.ReactNode}) => children ?? null;
  const Trigger = ({render}: {render?: React.ReactNode}) => render ?? null;
  const parts = new Proxy(Pass, {get: (_target, property) => property === "Trigger" ? Trigger : Pass});
  return {...actual, Popover: parts, useKumoToastManager: () => ({add: () => {}})};
});

const testRoot = makeTestRoot();
afterEach(() => { testRoot.cleanup(); vi.restoreAllMocks(); });

const NOW = new Date("2026-11-12T17:00:00Z");

const run = (id: number, over: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id,
  title: `Run ${id}`,
  spawnerName: "Invoice watcher",
  started: NOW,
  lastActive: NOW,
  ...over,
});

const request = (id: number) => entry(id, {
  resourceTitle: "Outbox",
  description: {
    title: "Send an email to ap@acme.com",
    description: "Asks Acme to correct the VAT line.",
    implementsRevert: false,
    autoApprovable: false,
    descriptionIsComplete: true,
  },
});

async function renderRow(
  chats: AiChatMetadata[],
  pendingForRun: Map<number, ActionLogEntry[]>,
  expanded = false,
  restricted = false,
) {
  const server = makeOverseer();
  const approveAction = vi.fn<(id: number, approval?: unknown) => Promise<void>>(async () => {});
  Object.assign(server.overseer, {approveAction});
  const onOpenRun = vi.fn<(chatId: number) => void>();
  const [agent] = deriveAgents(chats, new Set(pendingForRun.keys()), NOW);

  await testRoot.render(
    <AgentListRow
      agent={agent} now={NOW} expanded={expanded} onToggle={() => {}} onOpenAgent={() => {}}
      workspaceId="workspace" overseer={server.overseer}
      pendingForRun={pendingForRun} restricted={restricted}
      selectedChatId={null} onOpenRun={onOpenRun} activityLineOf={() => undefined}
    />,
  );
  return {approveAction, onOpenRun};
}

const labels = () => [...document.body.querySelectorAll("[aria-label]")]
  .map(element => element.getAttribute("aria-label"));
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
/** The whole text of the row a run occupies, cue included. */
const rowText = (title: string) => [...document.body.querySelectorAll("button")]
  .find(b => b.textContent?.startsWith(title))?.textContent;

it("names both kinds of attention when one count covers both", async () => {
  await renderRow(
    [run(1), run(2, {proposedChangeWorkpieces: [7]})],
    new Map([[1, [request(10)]]]),
  );

  // The badge is a bare "2", and only one of those runs is waiting on an approval: saying so of
  // both would send someone looking for a request that was never made.
  expect(labels()).toContain("1 run needing your review, 1 run with pending changes");
});

it("answers a run's action approval without leaving the list", async () => {
  const {approveAction, onOpenRun} = await renderRow([run(1)], new Map([[1, [request(10)]]]), true);

  expect(document.body.textContent).toContain("Send an email to ap@acme.com");
  await act(async () => { button("Approve")!.click(); });

  expect(approveAction).toHaveBeenCalledWith(10, undefined);
  // Decided in place: the list never sent anyone to the run to do it.
  expect(onOpenRun).not.toHaveBeenCalled();
});

it("tells the two errands apart on the runs themselves", async () => {
  await renderRow(
    [run(1), run(2, {proposedChangeWorkpieces: [7]})],
    new Map([[1, [request(10)]]]),
    true,
  );

  // A request is answerable here; unaccepted work is only answerable in the run itself.
  expect(rowText("Run 1")).toContain("Review");
  expect(rowText("Run 2")).toContain("Changes");
});

it("tells a restricted workspace's approver what they are answering for", async () => {
  await renderRow([run(1)], new Map([[1, [request(10)]]]), true, true);

  // Answering from the list is an approve surface like any other, and the kernel checks nothing
  // about what this action carries out of a workspace that has read sensitive data.
  expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY);
});

it("lists every run once expanded, however many there are", async () => {
  const many = Array.from({length: 12}, (_, i) => run(100 + i, {title: `Invoice ${i}`}));
  await renderRow(many, new Map(), true);

  const text = document.body.textContent ?? "";
  for (const chat of many) expect(text).toContain(chat.title);
  expect(text).not.toContain("Show all");
});
