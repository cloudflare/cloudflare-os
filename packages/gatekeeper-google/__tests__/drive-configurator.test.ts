// The Drive configurator in a stand-in for the sandbox runtime: what it shows when a location needs
// a grant the account lacks (shared drives), how it asks for the grant commenting needs, and what it
// asks Workshop for.

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DriveCommentAccess, DriveNodePage,
} from "../src/configurator/drive-configurator-types";
import { nodes, text, type Node } from "./configurator-tree";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({
    component, props: props ?? {}, children,
  }),
  Button: "Button",
  Field: "Field",
  Fragment: "Fragment",
  HierarchyPicker: "HierarchyPicker",
  Notice: "Notice",
  Section: "Section",
}));

const GRANT = "https://drive.google.com/drive/shared-drives";
const GRANT_NOTICE = { tone: undefined, text: expect.stringContaining('"View and download all your Drive files"') };
// Sent by the gatekeeper over RPC: the configurator holds no copy of it.
const COMMENTS_GRANT = "https://drive.google.com/drive/comments";

afterEach(() => {
  vi.useRealTimers();
});

const noticesIn = (tree: Node[]) => tree.filter(node => node.component === "Notice")
  .map(node => ({ tone: node.props.tone, text: text(node) }));

/** A fresh module, since it keeps the pending grants at module level, and its frame. */
async function open(commentAccess: DriveCommentAccess = { grant: COMMENTS_GRANT, held: false }) {
  vi.resetModules();
  const spec = (await import("../src/configurator/drive-configurator-ui")).default as unknown as {
    initial: Record<string, unknown>;
    isReady(context: unknown): boolean;
    resourceUrl(context: unknown): string;
    render(context: unknown): unknown;
  };
  let values = { ...spec.initial };
  const ui = {
    listDriveNodes: vi.fn(async (): Promise<DriveNodePage> => ({ nodes: [] })),
    getDriveNode: vi.fn(),
    getCommentAccess: vi.fn(async (): Promise<DriveCommentAccess> => commentAccess),
  };
  const ensureResources = vi.fn(async (_patterns: string[]) => false);
  const setValues = vi.fn((patch: Record<string, unknown>) => { values = { ...values, ...patch }; });
  /** The rendered tree, split into the Commenting section's nodes and everything else. */
  const render = () => {
    const all = nodes(spec.render({ values, setValues, clearFields: () => {}, ensureResources, ui }));
    const section = all.find(node => node.component === "Section" && node.props.title === "Commenting");
    const inSection = new Set(nodes(section));
    return { all, picker: all.filter(node => !inSection.has(node)), commenting: [...inSection] };
  };
  const find = (component: string) => render().picker.filter(node => node.component === component);
  const commentButton = () => render().commenting
    .find(node => node.component === "Button" && text(node) === "Allow commenting");
  return {
    spec, ui, ensureResources, setValues, render,
    list: (parentId: string, query = "") =>
      find("HierarchyPicker")[0].props.loadItems({ parentId, query, cursor: null }),
    load: (id: string) => find("HierarchyPicker")[0].props.loadItem(id),
    notices: () => noticesIn(render().picker),
    allow: () => find("Button").find(node => text(node) === "Allow access")?.props.onClick(),
    commentNotices: () => noticesIn(render().commenting),
    /** The section's plain text, which is no Notice and so is never announced. */
    commentText: () => render().commenting.filter(node => node.component === "p").map(text),
    /** The info Notice the runtime announces: the last one on screen, in document order. */
    announced: () => noticesIn(render().all).filter(notice => notice.tone !== "error").at(-1),
    commentButton,
    allowCommenting: () => commentButton()?.props.onClick(),
  };
}

it("asks for the grant a location names, then stops once a listing loads", async () => {
  const frame = await open();
  frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });

  // Expected, so said as an unavailable location rather than a failure the picker would report.
  await expect(frame.list("shared-drives")).resolves.toEqual(
    { items: [], unavailable: expect.stringContaining("Allow it below, then select Retry.") });
  expect(frame.notices()).toEqual([GRANT_NOTICE]);
  frame.allow();
  expect(frame.ensureResources).toHaveBeenCalledExactlyOnceWith([GRANT]);
  await vi.waitFor(() => expect(frame.notices()).toContainEqual(
    { tone: undefined, text: "Allow access in Google's window, then select Retry." }));

  await frame.list("shared-drives");
  expect(frame.notices()).toEqual([]);
});

// The picker drops a reply for a location it has left, but only once the module has seen it.
it.each([
  ["an earlier search's", "Q3", { nodes: [] }, { nodes: [], needsGrant: GRANT }, [GRANT_NOTICE]],
  ["Shared drives' earlier", "", { nodes: [], needsGrant: GRANT }, { nodes: [] }, []],
])("ignores %s reply that arrives after a newer listing's", async (_, query, older, newer, notices) => {
  const frame = await open();
  const reply = Promise.withResolvers<DriveNodePage>();
  frame.ui.listDriveNodes.mockReturnValueOnce(reply.promise).mockResolvedValueOnce(newer);

  const stale = frame.list("shared-drives", query);
  await frame.list("drive");
  reply.resolve(older);
  await stale;

  expect(frame.notices()).toEqual(notices);
});

it("says why the grant was not given", async () => {
  const frame = await open();
  frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });
  frame.ensureResources.mockRejectedValueOnce(new Error("The pop-up was closed."));

  await frame.list("shared-drives");
  frame.allow();

  await vi.waitFor(() => expect(frame.notices()).toContainEqual(
    { tone: "error", text: "The pop-up was closed." }));
});

it("offers only the folders on a pre-filled file's path that this account can list", async () => {
  const frame = await open();
  frame.ui.getDriveNode.mockResolvedValueOnce({
    id: "file:F9", title: "Q3.pdf", kind: "file",
    path: [
      { id: "folder:0AMyRoot", title: "My Drive", listable: true },
      { id: "folder:A", title: "Archive", listable: false },
    ],
  });

  const item = await frame.load("file:F9");

  expect(item.path.map(({ id, selectable }: { id: string; selectable: boolean }) => [id, selectable]))
    .toEqual([["folder:0AMyRoot", true], ["folder:A", false]]);
});

/** A frame whose load-time read has landed, so Allow commenting knows the grant. */
async function loaded(commentAccess?: DriveCommentAccess) {
  const frame = await open(commentAccess);
  frame.commentNotices();
  await vi.waitFor(() => expect(frame.commentButton()?.props.disabled ?? false).toBe(false));
  return frame;
}

describe("Commenting", () => {
  const EXPLAINED = expect.stringContaining('"See, edit, create, and delete all your Google Drive files"');
  const HELD = "Agents can comment on files through this connection.";
  const WAITING = { tone: undefined, text: "Waiting for permission in Google's window…" };
  const ALLOWED = { tone: undefined, text: "Commenting is allowed." };

  it("reads whether commenting is allowed once, on load, and offers the button only once it knows", async () => {
    const frame = await open();
    const read = Promise.withResolvers<DriveCommentAccess>();
    frame.ui.getCommentAccess.mockReturnValueOnce(read.promise);

    expect(frame.commentButton()?.props.disabled).toBe(true);
    // Disabled, a click asks for nothing: there is no grant to name yet.
    frame.allowCommenting();
    expect(frame.ensureResources).not.toHaveBeenCalled();

    read.resolve({ grant: COMMENTS_GRANT, held: false });
    await vi.waitFor(() => expect(frame.commentButton()?.props.disabled).toBe(false));
    expect(frame.commentText()).toEqual([EXPLAINED]);
    // A suggested edit is a comment, not a Docs suggestion the owner can accept.
    expect(frame.commentText()[0]).toContain("suggest edits as plain comments");
    expect(frame.commentNotices()).toEqual([]);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(1);
  });

  it("says commenting is allowed, with no button, when the account holds the grant", async () => {
    const frame = await open({ grant: COMMENTS_GRANT, held: true });
    frame.commentNotices();

    await vi.waitFor(() => expect(frame.commentText()).toEqual([HELD]));
    expect(frame.commentNotices()).toEqual([]);
    expect(frame.commentButton()).toBeUndefined();
  });

  it("asks for the grant the gatekeeper names from the click, then polls until it is held", async () => {
    const frame = await loaded({ grant: "https://example.test/from-rpc", held: false });
    vi.useFakeTimers();
    frame.ui.getCommentAccess
      .mockResolvedValueOnce({ grant: "https://example.test/from-rpc", held: false })
      .mockResolvedValueOnce({ grant: "https://example.test/from-rpc", held: true });

    frame.allowCommenting();
    // Before any await, or the browser would block Google's pop-up.
    expect(frame.ensureResources).toHaveBeenCalledExactlyOnceWith(["https://example.test/from-rpc"]);
    expect(frame.commentNotices()).toEqual([WAITING]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(2);
    expect(frame.commentNotices()).toEqual([WAITING]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.commentNotices()).toEqual([ALLOWED]);
    expect(frame.commentText()).toEqual([HELD]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(3);
  });

  it("reads at once, and only once, when Workshop already sees the grant", async () => {
    const frame = await loaded();
    vi.useFakeTimers();
    frame.ensureResources.mockResolvedValueOnce(true);
    frame.ui.getCommentAccess.mockResolvedValueOnce({ grant: COMMENTS_GRANT, held: true });

    frame.allowCommenting();
    await vi.advanceTimersByTimeAsync(0);

    expect(frame.commentNotices()).toEqual([ALLOWED]);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(2);
  });

  it("gives up after three minutes, and polls no more", async () => {
    const frame = await loaded();
    vi.useFakeTimers();

    frame.allowCommenting();
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(frame.commentNotices()).toEqual([{
      tone: "error",
      text: "Commenting wasn't allowed within 3 minutes. Select Allow commenting to try again.",
    }]);
    const reads = frame.ui.getCommentAccess.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(reads);
  });

  it("says why the grant was not given, without polling", async () => {
    const frame = await loaded();
    vi.useFakeTimers();
    frame.ensureResources.mockRejectedValueOnce(new Error("The pop-up was closed."));

    frame.allowCommenting();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(frame.commentNotices()).toEqual([{ tone: "error", text: "The pop-up was closed." }]);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(1);
  });

  it("takes no second click until Workshop has answered the first", async () => {
    const frame = await loaded();
    vi.useFakeTimers();
    const first = Promise.withResolvers<boolean>();
    frame.ensureResources.mockReturnValueOnce(first.promise);
    frame.ui.getCommentAccess.mockResolvedValueOnce({ grant: COMMENTS_GRANT, held: true });

    frame.allowCommenting();
    expect(frame.commentButton()?.props.disabled).toBe(true);
    // Workshop would refuse a second access request while it is opening the first's window.
    frame.allowCommenting();
    expect(frame.ensureResources).toHaveBeenCalledTimes(1);

    first.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(frame.commentButton()?.props.disabled).toBe(false);
    expect(frame.commentNotices()).toEqual([WAITING]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.commentNotices()).toEqual([ALLOWED]);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(2);
  });

  it("asks again on a click while waiting, as after a closed window, and polls only for it", async () => {
    const frame = await loaded();
    vi.useFakeTimers();
    frame.allowCommenting();
    await vi.advanceTimersByTimeAsync(1_000);
    frame.allowCommenting();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(frame.ensureResources).toHaveBeenCalledTimes(2);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["failure", (read: PromiseWithResolvers<DriveCommentAccess>) => read.reject(new Error("Connection lost."))],
    ["answer", (read: PromiseWithResolvers<DriveCommentAccess>) => read.resolve({ grant: COMMENTS_GRANT, held: true })],
  ])("shows no older click's in-flight %s over a newer click's wait", async (_, settle) => {
    const frame = await loaded();
    vi.useFakeTimers();
    const older = Promise.withResolvers<DriveCommentAccess>();
    frame.ui.getCommentAccess.mockReturnValueOnce(older.promise);
    frame.allowCommenting();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(2);

    frame.allowCommenting();
    await vi.advanceTimersByTimeAsync(0);
    settle(older);
    await vi.advanceTimersByTimeAsync(0);

    expect(frame.commentNotices()).toEqual([WAITING]);
    expect(frame.commentButton()?.props.disabled).toBe(false);
  });

  it("offers to check again when the load-time read fails", async () => {
    const frame = await open();
    frame.ui.getCommentAccess.mockRejectedValueOnce(new Error("Connection lost."));
    frame.commentNotices();
    await vi.waitFor(() => expect(frame.commentNotices()).toEqual([{ tone: "error", text: "Connection lost." }]));
    const checkAgain = () => frame.render().commenting
      .find(node => node.component === "Button" && text(node) === "Check again");
    expect(frame.commentButton()).toBeUndefined();

    checkAgain()?.props.onClick();

    await vi.waitFor(() => expect(frame.commentButton()?.props.disabled).toBe(false));
    expect(checkAgain()).toBeUndefined();
    expect(frame.commentNotices()).toEqual([]);
    expect(frame.ui.getCommentAccess).toHaveBeenCalledTimes(2);
  });

  // The runtime's one live region speaks only for the last info Notice, and this section renders
  // after the Shared drives block.
  it.each([false, true])("leaves the Shared drives notes the ones announced (held: %s)", async held => {
    const frame = await loaded({ grant: COMMENTS_GRANT, held });
    await vi.waitFor(() => expect(frame.commentText()).toEqual([held ? HELD : EXPLAINED]));
    expect(frame.announced()).toBeUndefined();
    frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });

    await frame.list("shared-drives");
    expect(frame.announced()).toEqual(GRANT_NOTICE);
    frame.allow();
    await vi.waitFor(() => expect(frame.announced()).toEqual(
      { tone: undefined, text: "Allow access in Google's window, then select Retry." }));
  });

  it("drops its success once the Shared drives block appears, so that block's notes are announced", async () => {
    const frame = await loaded();
    vi.useFakeTimers();
    frame.ensureResources.mockResolvedValueOnce(true);
    frame.ui.getCommentAccess.mockResolvedValueOnce({ grant: COMMENTS_GRANT, held: true });
    frame.allowCommenting();
    await vi.advanceTimersByTimeAsync(0);
    expect(frame.announced()).toEqual(ALLOWED);

    frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });
    await frame.list("shared-drives");
    expect(frame.announced()).toEqual(GRANT_NOTICE);
    expect(frame.commentNotices()).toEqual([]);
    expect(frame.commentText()).toEqual([HELD]);
    frame.allow();
    await vi.advanceTimersByTimeAsync(0);
    expect(frame.announced()).toEqual({ tone: undefined, text: "Allow access in Google's window, then select Retry." });

    // Leaving the block does not announce the earlier success again.
    await frame.list("shared-with-me");
    expect(frame.announced()).toBeUndefined();
  });

  it("waits in plain text while the Shared drives block is shown, and succeeds there unannounced", async () => {
    const frame = await loaded();
    vi.useFakeTimers();
    frame.ui.getCommentAccess.mockResolvedValueOnce({ grant: COMMENTS_GRANT, held: false });
    frame.allowCommenting();
    expect(frame.announced()).toEqual(WAITING);

    frame.ui.listDriveNodes.mockResolvedValueOnce({ nodes: [], needsGrant: GRANT });
    await frame.list("shared-drives");
    expect(frame.announced()).toEqual(GRANT_NOTICE);
    expect(frame.commentNotices()).toEqual([]);
    expect(frame.commentText()).toEqual([EXPLAINED, WAITING.text]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.announced()).toEqual(GRANT_NOTICE);
    frame.ui.getCommentAccess.mockResolvedValueOnce({ grant: COMMENTS_GRANT, held: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame.commentText()).toEqual([HELD]);
    expect(frame.announced()).toEqual(GRANT_NOTICE);

    await frame.list("shared-with-me");
    expect(frame.announced()).toBeUndefined();
  });

  it.each([false, true])("leaves what is connected, and whether it can be, to the picker (held: %s)", async held => {
    const { spec } = await loaded({ grant: COMMENTS_GRANT, held });
    const values = { target: "file:F1" };

    expect(spec.resourceUrl({ values })).toBe("https://drive.google.com/file/d/F1/view");
    expect(spec.isReady({ values })).toBe(true);
  });
});
