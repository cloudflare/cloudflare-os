// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, AiChatHistoryPage, AiChatMetadata,
} from "@gadgets/workshop-shared/api";
import type { useUnreadState } from "./features/notifications/UnreadStateBridge";
import { entry, flushFrames, makeOverseer, makeTestRoot } from "./action-test-harness";
import { PENDING_ERROR_COPY } from "./Activity";
import ChatInterface from "./ChatInterface";

const mock = vi.hoisted(() => ({unread: null as ReturnType<typeof useUnreadState>}));
vi.mock("./features/notifications/UnreadStateBridge", async importOriginal => ({
  ...await importOriginal<typeof import("./features/notifications/UnreadStateBridge")>(),
  useUnreadState: () => mock.unread,
}));
vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({currentUser: null}),
  useOptionalAuthenticatedApi: () => null,
}));
vi.mock("@cloudflare/kumo", async importOriginal => ({
  ...await importOriginal<typeof import("@cloudflare/kumo")>(),
  useKumoToastManager: () => ({add: () => {}}),
}));

const testRoot = makeTestRoot();
afterEach(() => {
  testRoot.cleanup();
  mock.unread = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Two scrolling methods jsdom does not implement, which Kumo's tab strip and the chat view both
// call: without them the handler throws and the interaction under test never happens.
const stubbedScrolling = (["scrollIntoView", "scrollTo"] as const).map((name) => {
  const previous = Object.getOwnPropertyDescriptor(Element.prototype, name);
  Object.defineProperty(Element.prototype, name, {
    configurable: true,
    value: vi.fn<(options?: unknown) => void>(),
  });
  return {name, previous};
});
afterAll(() => {
  for (const {name, previous} of stubbedScrolling) {
    if (previous) Object.defineProperty(Element.prototype, name, previous);
    else Reflect.deleteProperty(Element.prototype, name);
  }
});

const MODEL = {name: "Model"} as AiChatAuthorInfo;

const chat = (over: Partial<AiChatMetadata> & {id: number}): AiChatMetadata => ({
  title: `Chat ${over.id}`,
  started: new Date(),
  lastActive: new Date(),
  ...over,
});

async function renderList(chats: AiChatMetadata[], extraOverseer: Record<string, unknown> = {}) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const server = makeOverseer();
  Object.assign(server.overseer, {
    listChats: async () => chats,
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: () => ({[Symbol.dispose]: () => {}}),
    getChatHistory: async () => ({messages: []}),
    ...extraOverseer,
  });
  const stub = server.overseer;
  let selected: number | null = null;
  const navigate = vi.fn<(chatId: number | null) => void>();
  const show = async () => {
    await testRoot.render(
      <ChatInterface workspaceId="workspace" overseer={stub}
        selectedChatId={selected} onNavigateToChat={navigate}
        pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
        onConsumeConsoleLogs={() => ""} onDiscardConsoleLogs={() => {}}
        onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />,
    );
  };
  /** Render with whichever chat the route has selected, as navigating to one would. */
  const route = async (selectedChatId: number | null) => {
    selected = selectedChatId;
    await show();
  };
  await show();
  return Object.assign(server, {navigate, route});
}

const text = () => document.body.textContent ?? "";
const button = (match: RegExp) =>
  [...document.body.querySelectorAll("button")].find(b => match.test(b.textContent ?? ""));
const openAgentsTab = async () => { await act(async () => button(/^Agents/)!.click()); };
const reviewButton = (title: string) =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="Review ${title}"]`);

const WORKSPACE = [
  chat({id: 1, title: "Build me a habit tracker"}),
  chat({id: 10, title: "Reply to Acme", spawnerName: "Email joker"}),
  chat({id: 11, title: "Triage weekend inbox", spawnerName: "Email joker"}),
  chat({id: 20, title: "Monday digest", spawnerName: "Weekly digest"}),
];

it("keeps runs out of the Chats tab", async () => {
  await renderList(WORKSPACE);

  expect(text()).toContain("Build me a habit tracker");
  // Every spawned chat lives behind the Agents tab instead of sharing the list.
  expect(text()).not.toContain("Reply to Acme");
  expect(text()).not.toContain("Monday digest");
});

it("lists one row per agent, not one per run", async () => {
  await renderList(WORKSPACE);
  await openAgentsTab();

  expect(text()).toContain("Email joker");
  expect(text()).toContain("Weekly digest");
  // Collapsed is the resting state: an agent stands in for its runs until it is opened.
  expect(text()).not.toContain("Reply to Acme");
  expect(text()).not.toContain("Monday digest");
});

it("shows an agent's recent runs when it is expanded, without leaving the list", async () => {
  await renderList(WORKSPACE);
  await openAgentsTab();
  await act(async () => button(/Email joker/)!.click());

  expect(text()).toContain("Reply to Acme");
  expect(text()).toContain("Triage weekend inbox");
  // Expanding one agent leaves the others alone.
  expect(text()).toContain("Weekly digest");
  expect(text()).not.toContain("Monday digest");
});

it("shows every run of an expanded agent, not a sample of them", async () => {
  const many = Array.from({length: 8}, (_, i) =>
    chat({id: 100 + i, title: `Invoice ${i}`, spawnerName: "Invoice watcher"}));
  await renderList([chat({id: 1, title: "Mine"}), ...many]);
  await openAgentsTab();
  await act(async () => { button(/Invoice watcher/)!.click(); });

  // Which of these did what, and when, is not a question a preview can answer.
  const shown = text();
  for (const invoice of many) expect(shown).toContain(invoice.title);
});

it("hands off to the agent's own screen from Open agent", async () => {
  const many = Array.from({length: 8}, (_, i) =>
    chat({id: 100 + i, title: `Invoice ${i}`, spawnerName: "Invoice watcher"}));
  await renderList([chat({id: 1, title: "Mine"}), ...many]);
  await openAgentsTab();
  await act(async () => { button(/Invoice watcher/)!.click(); });
  await act(async () => { button(/^Open agent/)!.click(); });

  // A screen of its own, naming whose runs these are.
  expect(document.querySelector("h2")?.textContent).toBe("Invoice watcher");
  expect(text()).toContain("Invoice 7");
});

it("badges the Agents tab only for agents that need the user", async () => {
  await renderList([
    chat({id: 1, title: "Mine"}),
    chat({id: 10, title: "Busy", spawnerName: "Email joker", activeAgent: MODEL}),
    chat({id: 20, title: "Done", spawnerName: "Inbox triage", proposedChangeWorkpieces: [7]}),
  ]);

  // A working agent is the normal case and must not badge; unreviewed work must.
  expect(button(/^Agents/)!.textContent).toContain("1");
  await openAgentsTab();
  const labels = [...document.body.querySelectorAll("[aria-label]")]
    .map(e => e.getAttribute("aria-label"));
  expect(labels).toContain("1 run with pending changes");
  expect(labels).toContain("1 running");
});

it("says so when no agent has ever run", async () => {
  await renderList([chat({id: 1, title: "Mine"})]);
  await openAgentsTab();

  expect(text()).toContain("No agents have run yet");
  expect(button(/^Agents/)!.textContent).not.toMatch(/\d/);
});

it("does not call it all clear when the request list failed to load", async () => {
  const server = await renderList(WORKSPACE);
  await server.resolveSubscription();
  await server.rejectPendingQuery(new Error("socket closed"));
  flushFrames();
  await act(async () => {});
  await openAgentsTab();

  // With no request list every run looks idle and the tab carries no badge, which reads as a
  // confident all-clear from the one surface whose job is to say an agent is stuck.
  expect(text()).toContain(PENDING_ERROR_COPY);
});

it("stands the agent's screen down when the route moves to a chat", async () => {
  // Selecting a chat mounts the transcript, which reads from the overseer on its own account.
  const server = await renderList(WORKSPACE, {
    getChatHistory: async () => ({messages: []}),
    viewChat: () => ({[Symbol.dispose]: () => {}}),
  });
  await openAgentsTab();
  await act(async () => { button(/Email joker/)!.click(); });
  await act(async () => { button(/^Open agent/)!.click(); });
  expect(document.querySelector("h2")?.textContent).toBe("Email joker");

  // A link, a notification or the Back button selects a chat while the pane is up. The URL
  // would otherwise say one thing and the screen show another.
  await server.route(1);

  expect(document.querySelector("h2")?.textContent).not.toBe("Email joker");
});

it("places each request on the run that made it, reading no transcript", async () => {
  const send = entry(10, {chatId: 11, resourceTitle: "Outbox"});
  // A hook's request, or gadget code's outside any chat, belongs to no run.
  const hooked = entry(11, {resourceTitle: "Calendar"});
  const getChatHistory = vi.fn<() => Promise<AiChatHistoryPage>>(async () => ({messages: []}));
  const server = await renderList(WORKSPACE, {getChatHistory});
  await server.resolveSubscription();
  await server.resolvePendingQuery({entries: [send, hooked]});
  flushFrames();
  await act(async () => {});

  expect(button(/^Agents/)!.textContent).toContain("1");
  await openAgentsTab();
  await act(async () => { button(/Email joker/)!.click(); });
  await act(async () => { button(/Weekly digest/)!.click(); });
  expect(reviewButton("Triage weekend inbox")).not.toBeNull();
  expect(reviewButton("Reply to Acme")).toBeNull();
  expect(reviewButton("Monday digest")).toBeNull();
  expect(getChatHistory).not.toHaveBeenCalled();
});

it("sends a run stopped on a connection or web fetch to the run, where its card is", async () => {
  const server = await renderList([
    ...WORKSPACE.filter(c => c.id !== 11),
    chat({id: 11, title: "Triage weekend inbox", spawnerName: "Email joker", awaitingDecision: true}),
  ]);
  await server.resolveSubscription();
  await server.resolvePendingQuery({entries: []});

  // Neither kind of request is in the action log, so there is no approval to answer in place.
  expect(button(/^Agents/)!.textContent).toContain("1");
  await openAgentsTab();
  await act(async () => { button(/Email joker/)!.click(); });
  await act(async () => { reviewButton("Triage weekend inbox")!.click(); });
  expect(server.navigate).toHaveBeenCalledWith(11);
});

it("marks a run that stops on a decision while the page is open", async () => {
  let live: {metadata: (meta: AiChatMetadata) => void} | undefined;
  const server = await renderList(WORKSPACE, {
    subscribeToChat: (subscriber: {metadata: (meta: AiChatMetadata) => void}) => {
      live = subscriber;
      return {[Symbol.dispose]: () => {}};
    },
  });
  await server.resolveSubscription();
  await server.resolvePendingQuery({entries: []});

  await act(async () => {
    live!.metadata({...WORKSPACE.find(c => c.id === 20)!, awaitingDecision: true});
  });

  expect(button(/^Agents/)!.textContent).toContain("1");
  await openAgentsTab();
  await act(async () => { button(/Weekly digest/)!.click(); });
  expect(reviewButton("Monday digest")).not.toBeNull();
});

it("keeps a run's thread read controls, which left the chat list with it", async () => {
  const markRead = vi.fn<NonNullable<ReturnType<typeof useUnreadState>>["markRead"]>()
    .mockResolvedValue(undefined);
  mock.unread = {
    chats: [{workspaceId: "workspace", chatId: 10, readThroughSequence: 0, unreadMessageCount: 3}],
    subscribeToUpdates: () => () => {},
    markRead,
    markUnread: async () => true,
    markAllRead: async () => {},
    markWorkspaceRead: async () => {},
  };
  const server = await renderList(WORKSPACE);

  // Moving runs out of Chats must not bury the only signal that an unattended run has output.
  expect(button(/^Agents/)!.textContent).toContain("1");
  await openAgentsTab();
  expect([...document.body.querySelectorAll("[aria-label]")].map(e => e.getAttribute("aria-label")))
    .toContain("3 unread messages");
  await act(async () => { button(/Email joker/)!.click(); });

  // A run is a thread you read, or mean to come back to, like any other. Moving runs out of the
  // chat list took away the row that said so and the control that set it.
  expect([...document.body.querySelectorAll("[aria-label]")].map(e => e.getAttribute("aria-label")))
    .toContain("3 unread messages");

  const trigger =
    document.querySelector<HTMLButtonElement>('[aria-label="Actions for Reply to Acme"]')!;
  await act(async () => trigger.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent === "Mark thread read")!;
  await act(async () => item.click());

  expect(markRead.mock.calls).toEqual([[server.overseer, 10]]);
});
