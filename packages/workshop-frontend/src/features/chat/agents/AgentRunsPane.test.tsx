// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ActionLogEntry, AiChatMetadata } from "@gadgets/workshop-shared/api";
import { entry, makeOverseer, makeTestRoot } from "../../../action-test-harness";
import { RESTRICTED_APPROVAL_COPY } from "../../../components/RestrictedApprovalNotice";
import { AgentRunsPane } from "./AgentRunsPane";
import { deriveAgents } from "./agentList";

vi.mock("@cloudflare/kumo", async importOriginal => ({
  ...await importOriginal<typeof import("@cloudflare/kumo")>(),
  useKumoToastManager: () => ({add: () => {}}),
}));

const testRoot = makeTestRoot();
afterEach(() => { testRoot.cleanup(); vi.restoreAllMocks(); });

const NOW = new Date("2026-11-12T17:00:00Z");

const run = (id: number, over: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id, title: `Run ${id}`, spawnerName: "Invoice watcher", started: NOW, lastActive: NOW, ...over,
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

async function renderPane(
  runs: AiChatMetadata[],
  pendingForRun: Map<number, ActionLogEntry[]>,
  restricted = false,
) {
  const server = makeOverseer();
  const approveAction = vi.fn<(id: number, approval?: unknown) => Promise<void>>(async () => {});
  Object.assign(server.overseer, {approveAction});
  const onOpenRun = vi.fn<(chatId: number) => void>();
  const [agent] = deriveAgents(runs, new Set(pendingForRun.keys()), NOW);

  await testRoot.render(
    <AgentRunsPane
      agent={agent} now={NOW} workspaceId="workspace" overseer={server.overseer}
      pendingForRun={pendingForRun}
      restricted={restricted} selectedChatId={null} onOpenRun={onOpenRun}
      activityLineOf={() => undefined}
    />,
  );
  return {approveAction, onOpenRun};
}

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(b => b.textContent?.trim() === label);

it("lifts a run's action approval to the top rather than hiding it in the run", async () => {
  await renderPane([run(1), run(2)], new Map([[2, [request(10)]]]));

  // The screen answers "what is waiting on me", so making someone open each run to find out
  // would waste the trip -- and an approver has to read the whole thing, not a summary of it.
  expect(document.body.textContent).toContain("Send an email to ap@acme.com");
  expect(document.body.textContent).toContain("Asks Acme to correct the VAT line.");
});

it("decides a request without sending anyone to the run", async () => {
  const {approveAction, onOpenRun} = await renderPane([run(1)], new Map([[1, [request(10)]]]));

  await act(async () => { button("Approve")!.click(); });

  expect(approveAction).toHaveBeenCalledWith(10, undefined);
  expect(onOpenRun).not.toHaveBeenCalled();
});

it("tells a restricted workspace's approver that the check is theirs", async () => {
  await renderPane([run(1)], new Map([[1, [request(10)]]]), true);

  // An approve surface like the chat card and the Activity pane, and the kernel checks nothing
  // about what this action carries out of a workspace that has read sensitive data.
  expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY);
});

it("keeps a day's worth of small runs visible in the cost", async () => {
  await renderPane(
    [run(1, {totalCost: 0.0007}), run(2, {totalCost: 0.0005})],
    new Map(),
  );

  // What a scheduled task costs in a day is a fraction of a cent, and the same runs read
  // "$0.0007" apiece in the chat list: rounding the total to "$0.00" here would say it was free.
  expect(document.body.textContent).toContain("$0.0012");
});
