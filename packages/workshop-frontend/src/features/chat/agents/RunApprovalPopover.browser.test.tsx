/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Toasty } from "@cloudflare/kumo";
import type { RpcStub } from "capnweb";
import type {
  ActionLogEntry, AiChatMetadata, FileAtCommit, Overseer, PushReview, TreeNode,
} from "@gadgets/workshop-shared/api";
import { AgentListRow } from "./AgentListRow";
import { deriveAgents } from "./agentList";
import "../../../styles.css";

/** The chat list at the width it opens with, which is the whole reason for the popover. */
const LIST_WIDTH = 268;

const NOW = new Date();
const RUN_TITLE = "INV-2291 · email ap@acme.com";

const run: AiChatMetadata = {
  id: 1, title: RUN_TITLE, spawnerName: "Invoice watcher", started: NOW, lastActive: NOW,
};

const BODY = [
  "Hi,",
  "",
  "Invoice INV-2291 (dated 4 Nov) lists VAT at 17.5%. Our agreed rate is 20%, so the total",
  "should be £14,208.00 rather than £13,854.00.",
].join("\n");

const request = {
  id: 10,
  resourceTitle: "Outbox",
  createdAt: NOW,
  state: "pending",
  type: "action",
  description: {
    title: "Send an email to ap@acme.com",
    description: "Asks Acme's accounts-payable team to correct the VAT line on INV-2291.",
    implementsRevert: false,
    autoApprovable: false,
    descriptionIsComplete: true,
    fields: [{kind: "text", label: "Body", value: BODY}],
  },
} as ActionLogEntry;

const HEAD = "c1".padEnd(40, "0");
const COMMIT_TEXT = `tree ${"d1".padEnd(40, "0")}\nauthor Ada <ada@example.com> 1700000000 +0000\n` +
  "committer Ada <ada@example.com> 1700000000 +0000\n\nAdd the notes\n";

/** A push, and what it sends: one root commit adding one text file. */
const push = {
  ...request,
  id: 12,
  resourceTitle: "acme/widgets",
  description: {
    title: "Push to acme/widgets",
    description: "Push commit c100000 to branch main",
    implementsRevert: false,
    autoApprovable: false,
    pushedCommits: [HEAD],
  },
} as ActionLogEntry;

const pushReview: PushReview = {
  entries: [
    {kind: "commit", oid: HEAD, parents: [], size: COMMIT_TEXT.length, text: COMMIT_TEXT},
    {
      kind: "path", commit: HEAD, path: "", entry: {kind: "dir", oid: "d1".padEnd(40, "0")},
      parents: [], sent: {kind: "dir", size: 37},
    },
    {
      kind: "path", commit: HEAD, path: "notes.txt", entry: {kind: "file", oid: "f1".padEnd(40, "0")},
      parents: [], sent: {kind: "text", size: 9},
    },
  ],
  objectCount: 3,
  stackedOn: [],
};

let host: HTMLDivElement | undefined, root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

async function renderList(
  onOpenRun: (chatId: number) => void = () => {},
  records: ActionLogEntry[] = [request],
  restricted = false,
) {
  const approveAction = vi.fn<(id: number, approval?: unknown) => Promise<void>>(async () => {});
  const overseer = {
    approveAction,
    getPushReview: async () => pushReview,
    readFilesAtCommit: async (_commitId: string, paths: string[]) =>
      paths.map((path): [string, FileAtCommit] => [path, {kind: "text", text: "one line\n"}]),
    listTree: async (): Promise<TreeNode[]> => [{name: "notes.txt", kind: "file"}],
  } as unknown as RpcStub<Overseer>;

  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  /** Render the list as the action log now stands, with `pending` awaiting the run. */
  const show = async (pending: ActionLogEntry[]) => {
    const pendingForRun = new Map(pending.length > 0 ? [[1, pending]] : []);
    const [agent] = deriveAgents([run], pendingForRun, NOW);
    await act(async () => {
      root!.render(
        <Toasty>
          <div className="bg-kumo-base p-3" style={{width: LIST_WIDTH}}>
            <AgentListRow
              agent={agent} now={NOW} expanded onToggle={() => {}} onOpenAgent={() => {}}
              workspaceId="workspace" overseer={overseer}
              pendingForRun={pendingForRun} restricted={restricted}
              selectedChatId={null} onOpenRun={onOpenRun} activityLineOf={() => undefined}
            />
          </div>
        </Toasty>,
      );
    });
  };
  await show(records);
  return {approveAction, show};
}

/** The run's Review button, the one control on its row that opens the approval. */
const reviewButton = () => page.getByRole("button", {name: `Review ${RUN_TITLE}`});

/** The open popup, once base-ui has placed it. */
const popup = () => vi.waitFor(() => {
  const found = document.querySelector<HTMLElement>(".themed-floating-shadow");
  if (!found) throw new Error("The approval popover did not open");
  return found;
});

it("opens the request beside the list, at a width it can be read at", async () => {
  await renderList();

  await userEvent.click(reviewButton());
  const panel = await popup();
  const box = panel.getBoundingClientRect();

  // The point of the popover: an email body rendered in a 268px column is ribbons.
  expect(box.width).toBeGreaterThan(LIST_WIDTH);
  expect(panel.querySelector("pre")!.getBoundingClientRect().width).toBeGreaterThan(LIST_WIDTH);
  // Beside the list, and still on screen.
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(window.innerWidth);
  expect(box.top).toBeGreaterThanOrEqual(0);
});

it("opens the run from anywhere on its row but Review", async () => {
  const opened: number[] = [];
  await renderList(chatId => opened.push(chatId));

  await userEvent.click(page.getByText(RUN_TITLE));

  expect(opened).toEqual([1]);
  expect(document.querySelector(".themed-floating-shadow")).toBeNull();
});

it("hands over to the run for whoever wants the whole thread", async () => {
  const opened: number[] = [];
  await renderList(chatId => opened.push(chatId));

  await userEvent.click(reviewButton());
  await popup();
  await userEvent.click(page.getByText("Open run"));

  expect(opened).toEqual([1]);
  await vi.waitFor(() => {
    expect(document.querySelector(".themed-floating-shadow")).toBeNull();
  });
});

it("scrolls multiple long requests without clipping their decision controls", async () => {
  const second = {
    ...request,
    id: 11,
    description: {
      ...request.description,
      title: "Send a follow-up email",
      fields: [{kind: "text", label: "Body", value: BODY.repeat(8)}],
    },
  } as ActionLogEntry;
  await renderList(() => {}, [request, second]);

  await userEvent.click(reviewButton());
  const panel = await popup();
  const requestList = [...panel.children].find(
    child => child instanceof HTMLElement && child.classList.contains("overflow-y-auto"),
  ) as HTMLElement;

  expect(requestList.scrollHeight).toBeGreaterThan(requestList.clientHeight);
  expect(panel.querySelectorAll("article")).toHaveLength(2);
  expect([...panel.querySelectorAll("button")]
    .filter(button => button.textContent?.trim() === "Approve")).toHaveLength(2);
});

it("gives the run back its focus once its last request is decided", async () => {
  const {approveAction, show} = await renderList();

  await userEvent.click(reviewButton());
  const panel = await popup();
  const approve = [...panel.querySelectorAll("button")]
    .find(button => button.textContent?.trim() === "Approve")!;
  await userEvent.click(approve);
  expect(approveAction.mock.calls.map(([id]) => id)).toEqual([10]);
  // The decided request leaves the action log, and the popover holding focus goes with it.
  await show([]);

  await vi.waitFor(() => {
    expect(document.activeElement).toBe(page.getByText(RUN_TITLE).element().closest("button"));
  });
});

it("leaves focus alone when a request it was not showing is decided elsewhere", async () => {
  const {show} = await renderList();

  await show([]);

  expect(document.activeElement).not.toBe(page.getByText(RUN_TITLE).element().closest("button"));
});

it("reviews a restricted push in a dialog that holds focus, and gives it back on Escape", async () => {
  await renderList(() => {}, [push], true);

  // The trigger says whether the popover is open the moment that changes; its panel stays in the
  // document for a transition longer. Held here because the open review hides it from roles.
  const trigger = reviewButton().element();
  const popoverOpen = () => trigger.getAttribute("aria-expanded") === "true";
  await userEvent.click(trigger);
  const panel = await popup();
  const inPanel = (label: string) => [...panel.querySelectorAll("button")]
    .find(button => button.textContent?.trim() === label);
  // Under the mark the review stands where Approve would.
  expect(inPanel("Approve")).toBeUndefined();
  await userEvent.click(inPanel("Review commits")!);

  const dialog = await vi.waitFor(() => {
    // The popover is a dialog too; the review is the one titled "Review commits".
    const found = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(candidate =>
      document.getElementById(candidate.getAttribute("aria-labelledby") ?? "")?.textContent === "Review commits");
    if (!found?.contains(document.activeElement)) throw new Error("The review did not take focus");
    return found;
  });
  // Tab stays within the review however far it goes.
  for (let press = 0; press < 12; press++) {
    await userEvent.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement)).toBe(true);
  }

  // A click in the review lands outside the popover, which stays open under it all the same.
  await userEvent.click(
    [...dialog.querySelectorAll("button")].find(row => row.textContent?.includes("Add the notes"))!);
  expect(dialog.isConnected).toBe(true);
  expect(popoverOpen()).toBe(true);

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
  // Back to the request, on the button that opened the review.
  expect(popoverOpen()).toBe(true);
  await vi.waitFor(() => expect(document.activeElement).toBe(inPanel("Review commits")));
});
