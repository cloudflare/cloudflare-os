// Simulation: what the agent sees of a design or asset before Canva has made it. Each of the three
// actions returns the row it will produce, under a temporary id ("~1", "~2", ...) that reads accept
// until Canva assigns the real one, and listings merge the pending rows into Canva's pages.
//
// Nothing here writes. The rows are built from the action payload, which was rebuilt from known
// members at staging, and from the pinned identity, so they depend on nothing Canva has not said.

import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type { CanvaAction, CanvaActions, CanvaJobRecord } from "./canva-actions";
import type { StoredIdentity } from "./canva-credentials";
import type {
  CanvaDesign,
  CanvaDesignSort,
  CanvaFolderItem,
  CanvaFolderItemSort,
  CanvaImageAsset,
} from "./types";

/** The journal's pending entries, in submission order. */
export type Pending = readonly JournalEntry<CanvaAction>[];

/** Maps a temporary id to the id Canva assigned, or returns it unchanged while unassigned. */
export type Resolve = (id: string) => string;

/** Whether an id is one this gatekeeper allocated rather than one Canva issued. */
export const isProvisional = (id: string): boolean => id.startsWith("~");

/** The largest image a background removal produces, in pixels; larger sources are scaled down. */
const TRANSFORMED_MAX_PIXELS = 10_000_000;

/**
 * A pending design as reads show it until Canva makes it: the agent's title and type, the pinned
 * user as owner, and no URLs or thumbnail, since those exist only once the design does. A doc has
 * no pages in Canva's model; every other kind starts with one.
 */
export function pendingCreatedDesign(payload: CanvaActions["createDesign"], me: StoredIdentity): CanvaDesign {
  const at = new Date(payload.submittedAt).toISOString();
  return {
    id: payload.ref,
    title: payload.title ?? null,
    owner: { userId: me.userId, teamId: me.teamId },
    thumbnail: null,
    editUrl: null,
    viewUrl: null,
    pageCount: payload.designType === "doc" ? null : 1,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * A design Canva is generating, or will generate once approved: Canva writes its title and
 * contents, so until the job finishes the row says only that the design is on its way.
 */
export function pendingGeneratedDesign(payload: CanvaActions["generateDesign"], me: StoredIdentity): CanvaDesign {
  const at = new Date(payload.submittedAt).toISOString();
  return {
    id: payload.ref,
    title: null,
    owner: { userId: me.userId, teamId: me.teamId },
    thumbnail: null,
    editUrl: null,
    viewUrl: null,
    pageCount: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** The source's dimensions scaled, if need be, to the cap Canva applies to a transformed image. */
export function transformedDimensions(
  source: { width: number; height: number } | null,
): { width: number; height: number } | null {
  if (source === null) return null;
  const pixels = source.width * source.height;
  if (pixels <= TRANSFORMED_MAX_PIXELS) return source;
  const scale = Math.sqrt(TRANSFORMED_MAX_PIXELS / pixels);
  return { width: Math.floor(source.width * scale), height: Math.floor(source.height * scale) };
}

/**
 * The asset a background removal produces, as reads show it until Canva has it: named as asked or
 * after its source, sized as the source within Canva's cap, and without a thumbnail, which only
 * the finished pixels can give.
 */
export function pendingTransformedAsset(payload: CanvaActions["removeBackground"], me: StoredIdentity): CanvaImageAsset {
  const at = new Date(payload.submittedAt).toISOString();
  return {
    id: payload.ref,
    name: payload.name ?? payload.sourceName,
    tags: [],
    owner: { userId: me.userId, teamId: me.teamId },
    dimensions: transformedDimensions(payload.sourceDimensions),
    thumbnail: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** The pending design or asset an action will make, if any. */
export function pendingRow(action: CanvaAction, me: StoredIdentity): CanvaFolderItem {
  switch (action.kind) {
    case "createDesign": return { type: "design", design: pendingCreatedDesign(action.payload, me) };
    case "generateDesign": return { type: "design", design: pendingGeneratedDesign(action.payload, me) };
    case "removeBackground": return { type: "image", image: pendingTransformedAsset(action.payload, me) };
  }
}

/** Where pending rows come from: actions awaiting a decision, and applied actions whose job still runs. */
export type Unmade = { pending: Pending; running: readonly CanvaJobRecord[] };

/** Every row Canva has not yet assigned an id, oldest first: awaiting approval first, then running. */
function unmadeRows(unmade: Unmade, me: StoredIdentity, resolve: Resolve): CanvaFolderItem[] {
  const rows = [
    ...unmade.pending.map(({ action }) => pendingRow(action, me)),
    ...unmade.running.flatMap(job => runningRow(job, me) ?? []),
  ];
  return rows.filter(row => isProvisional(resolve(folderItemId(row))));
}

/** The designs pending actions will make that Canva has not yet assigned an id, oldest first. */
export function pendingDesigns(unmade: Unmade, me: StoredIdentity, resolve: Resolve): CanvaDesign[] {
  return unmadeRows(unmade, me, resolve).flatMap(row => row.type === "design" ? [row.design] : []);
}

/** The assets pending removals will make that Canva has not yet assigned an id, oldest first. */
export function pendingAssets(unmade: Unmade, me: StoredIdentity, resolve: Resolve): CanvaImageAsset[] {
  return unmadeRows(unmade, me, resolve).flatMap(row => row.type === "image" ? [row.image] : []);
}

/**
 * The row an applied action's job will produce, while the job runs: the design Canva is
 * generating, or the asset it is transforming. A creation binds inside apply, so it has no such row.
 */
export function runningRow(job: CanvaJobRecord, me: StoredIdentity): CanvaFolderItem | undefined {
  if (job.kind === "createDesign" || job.status !== "in_progress") return undefined;
  const staged = { ref: job.ref, submittedAt: job.at };
  return job.kind === "generateDesign"
    ? { type: "design", design: pendingGeneratedDesign({ ...staged, brief: job.brief, designType: job.designType }, me) }
    : {
      type: "image",
      image: pendingTransformedAsset({
        ...staged, assetId: job.sourceAssetId, sourceName: job.sourceName, sourceDimensions: job.sourceDimensions,
        ...(job.name !== undefined ? { name: job.name } : {}),
      }, me),
    };
}

/** The pending action that will make `ref`, if it is still waiting. */
export function pendingActionFor(ref: string, pending: Pending): CanvaAction | undefined {
  return pending.find(({ action }) => action.payload.ref === ref)?.action;
}

// ---------------------------------------------------------------------------
// Sort orders, so a pending row merges where Canva would list it. A pending design shows no title
// until Canva has one; such a row sorts as an empty title, which is where Canva lists untitled
// designs too.

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Canva's design listing order for `sortBy`, or `undefined` for relevance, which has no order to copy. */
export function designOrder(sortBy: CanvaDesignSort): ((a: CanvaDesign, b: CanvaDesign) => number) | undefined {
  switch (sortBy) {
    case "relevance": return undefined;
    case "modified_descending": return (a, b) => byString(b.updatedAt, a.updatedAt);
    case "modified_ascending": return (a, b) => byString(a.updatedAt, b.updatedAt);
    case "title_descending": return (a, b) => byString(b.title ?? "", a.title ?? "");
    case "title_ascending": return (a, b) => byString(a.title ?? "", b.title ?? "");
  }
}

function key(item: CanvaFolderItem): { createdAt: string; updatedAt: string; title: string } {
  switch (item.type) {
    case "folder": return { ...item.folder, title: item.folder.name };
    case "design": return { ...item.design, title: item.design.title ?? "" };
    case "image": return { ...item.image, title: item.image.name };
  }
}

/** Canva's folder listing order for `sortBy`. */
export function folderItemOrder(sortBy: CanvaFolderItemSort): (a: CanvaFolderItem, b: CanvaFolderItem) => number {
  switch (sortBy) {
    case "created_ascending": return (a, b) => byString(key(a).createdAt, key(b).createdAt);
    case "created_descending": return (a, b) => byString(key(b).createdAt, key(a).createdAt);
    case "modified_ascending": return (a, b) => byString(key(a).updatedAt, key(b).updatedAt);
    case "modified_descending": return (a, b) => byString(key(b).updatedAt, key(a).updatedAt);
    case "title_ascending": return (a, b) => byString(key(a).title, key(b).title);
    case "title_descending": return (a, b) => byString(key(b).title, key(a).title);
  }
}

function folderItemId(item: CanvaFolderItem): string {
  switch (item.type) {
    case "folder": return item.folder.id;
    case "design": return item.design.id;
    case "image": return item.image.id;
  }
}

/** What a folder item *is*, for the cursor's duplicate check across its temporary and real ids. */
export function folderItemIdentity(item: CanvaFolderItem): string {
  return `${item.type}:${folderItemId(item)}`;
}
