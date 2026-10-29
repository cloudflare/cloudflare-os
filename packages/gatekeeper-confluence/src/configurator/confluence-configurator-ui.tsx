import {
  Button, Field, Fragment, h, HierarchyPicker, Notice, RadioCards, Section,
  type ConfiguratorUIHierarchyAncestor as Ancestor, type ConfiguratorUIHierarchyItem as Item,
  type ConfiguratorUIHierarchyPage as Page, type ConfiguratorUIHierarchyRequest as PickerRequest,
  type ConfiguratorUIHierarchyTab as Tab, type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type { RpcStub } from "capnweb";
import type {
  ConfluenceBrowseRequest as Request,
  ConfluenceConfiguratorRpc,
  ConfluenceConfiguratorStatus as Status,
  ConfluenceConfiguratorValues as Values,
  ConfluenceCrumb as Crumb,
  ConfluenceNode as Node,
  ConfluenceNodeKind as Kind,
  ConfluenceSite as Site,
} from "./confluence-configurator-types";

/** The gatekeeper as the frame holds it: a Cap'n Web stub, so one call's result can feed the next unawaited. */
type Rpc = RpcStub<ConfluenceConfiguratorRpc>;

// Must equal the urlPatterns of SITE_RESOURCE, SPACE_RESOURCE and PAGE_RESOURCE in confluence.ts;
// __tests__/configurator-patterns.test.ts keeps the copies in step.
const SITE_PATTERN = "https://*.atlassian.net/wiki";
const SPACE_PATTERN = "https://*.atlassian.net/wiki/spaces/:spaceKey";
const PAGE_PATTERN = "https://*.atlassian.net/wiki/spaces/:spaceKey/pages/:pageId/*?";

const FIELD_LABEL = "What to connect";
const SEARCH_PLACEHOLDER = "Search Confluence or paste a link";
const ROOT_SUBTITLE = "Every space, page and blog post you can open";

type Context = ConfiguratorUIRenderContext<Rpc, Values>;
type Connection = { state: "loading" } | { state: "failed"; message: string } | Status;

const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

// -- the connection -----------------------------------------------------------------------------

let connection: Connection = { state: "loading" };
let asked = false;
/**
 * A pre-filled resource URL the picker couldn't open, said in place of a choice: one this connection
 * can't open, or one whose lookup failed (`failed` says how), which can be tried again.
 */
let missing: { url: string; failed?: string } | null = null;
/** The site the picker shows, once the connection is known. */
let openSite: string | null = null;
// Re-renders with what has loaded. Every render installs its own, so a late reply reaches the
// current tree. It changes no values, so it never invalidates a resource URL being collected.
let rerender: () => void = () => {};

function loadStatus({ ui }: Context): void {
  if (asked) return;
  asked = true;
  ui.getStatus().then(status => {
    connection = status;
    rerender();
  }, error => {
    connection = { state: "failed", message: errorMessage(error, "Couldn't reach Confluence.") };
    rerender();
  });
}

// -- what a choice is ---------------------------------------------------------------------------

const PATTERN_OF: Partial<Record<Kind, string>> = {
  site: SITE_PATTERN, space: SPACE_PATTERN, personalSpace: SPACE_PATTERN,
  overview: PAGE_PATTERN, page: PAGE_PATTERN, liveDoc: PAGE_PATTERN, blogpost: PAGE_PATTERN,
};
const NOUN_OF_PATTERN: Record<string, string> = {
  [SITE_PATTERN]: "a whole site", [SPACE_PATTERN]: "a space", [PAGE_PATTERN]: "a page or blog post",
};

/** Whether the Workshop takes what `kind` binds. An older Workshop does not say, and takes any. */
function accepts(accepted: readonly string[] | undefined, kind: Kind): boolean {
  const pattern = PATTERN_OF[kind];
  return pattern !== undefined && (accepted === undefined || accepted.includes(pattern));
}

/** Why a node can't be chosen here, or undefined when it can. */
function refusal(accepted: readonly string[] | undefined, node: Pick<Node, "kind" | "selectable" | "unselectableReason">): string | undefined {
  if (!node.selectable) return node.unselectableReason ?? "This can't be connected.";
  if (accepts(accepted, node.kind)) return undefined;
  const nouns = (accepted ?? []).map(pattern => NOUN_OF_PATTERN[pattern]).filter(Boolean);
  return nouns.length > 0 ? `This connection needs ${nouns.join(" or ")}.` : "This can't be connected here.";
}

/** The second line of an open container's own row: what choosing it covers. */
const PLACE_COVERS: Partial<Record<Kind, string>> = {
  space: "Every page and blog post in it, including new ones",
  personalSpace: "Every page and blog post in it, including new ones",
  overview: "This page and the pages under it",
  page: "This page and the pages under it",
  liveDoc: "This page and the pages under it",
};

const siteRefOf = (ref: string) => `site:${ref.slice(ref.indexOf(":") + 1).split("/")[0]}`;

// -- icons --------------------------------------------------------------------------------------

// Atlassian's own 16px glyphs (@atlaskit/icon and @atlaskit/icon-lab, Apache-2.0): the ones
// Confluence draws for each kind of content, so every row reads as it does there.
const ATLASKIT = {
  page: ["M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2zm2-.5a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5zM12 6H4V4.5h8zm-2 3.5H4V8h6z"],
  liveDoc: ["M15 3.5H1V2h14zm-9 5H1V7h5zM6 14H1v-1.5h5zm2.72-6.78a.75.75 0 0 1 .79-.17l6 2.25a.75.75 0 0 1-.08 1.43l-2.56.64-.64 2.56a.75.75 0 0 1-1.43.08l-2.25-6a.75.75 0 0 1 .17-.79"],
  blog: ["M0 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4v-1.5A2.5 2.5 0 0 0 5.5 10V9H2a2 2 0 0 1-2-2zm5.5 3.5V4a.5.5 0 0 0-.5-.5H2a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5zM9 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4v-1.5a2.5 2.5 0 0 0 2.5-2.5V9H11a2 2 0 0 1-2-2zm5.5 3.5V4a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5z"],
  home: ["M6.646.727a2 2 0 0 1 2.708 0l5 4.6A2 2 0 0 1 15 6.799V13a2 2 0 0 1-2 2H9.75a.75.75 0 0 1-.75-.75V9.5H7v4.75a.75.75 0 0 1-.75.75H3a2 2 0 0 1-2-2V6.799a2 2 0 0 1 .646-1.472zM8.339 1.83a.5.5 0 0 0-.678 0l-5 4.6a.5.5 0 0 0-.161.368V13a.5.5 0 0 0 .5.5h2.5V8.75A.75.75 0 0 1 6.25 8h3.5a.75.75 0 0 1 .75.75v4.75H13a.5.5 0 0 0 .5-.5V6.799a.5.5 0 0 0-.162-.368z"],
  folder: ["M3 2.5a.5.5 0 0 0-.5.5v3h11V4.75a.5.5 0 0 0-.5-.5H7.69L5.94 2.5zm10.5 5h-11V13a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5zM1 3a2 2 0 0 1 2-2h3.56l1.75 1.75H13a2 2 0 0 1 2 2V13a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z"],
  whiteboard: ["M9.162 2.177c-.714.282-1.28.817-1.449 1.338l-1.426-.463C6.637 1.97 7.633 1.168 8.61.782c.943-.372 2.248-.49 3.09.375.346.356.536.777.548 1.236.011.437-.14.827-.323 1.144-.228.394-.557.761-.876 1.074 1.466-.136 2.717.239 3.421 1.134.827 1.05.644 2.464-.256 3.697l-1.212-.884c.66-.905.556-1.547.29-1.885-.305-.387-1.095-.757-2.524-.512-.521.09-.935.138-1.236.13a1.4 1.4 0 0 1-.537-.11.9.9 0 0 1-.345-.278.85.85 0 0 1-.164-.495 1.02 1.02 0 0 1 .197-.586c.077-.112.171-.215.256-.3.14-.143.323-.306.499-.464l.101-.09c.453-.407.87-.806 1.087-1.181.102-.178.124-.292.123-.354-.002-.04-.01-.113-.124-.23-.2-.204-.716-.321-1.464-.026M3.75 5.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5M0 7.75a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0m10.25.75a.75.75 0 0 1 .643.364l3 5A.75.75 0 0 1 13.25 15h-6a.75.75 0 0 1-.643-1.136l3-5a.75.75 0 0 1 .643-.364m-1.675 5h3.35l-1.675-2.792z"],
  database: ["M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2zm2-.5a.5.5 0 0 0-.5.5v3.5h11V3a.5.5 0 0 0-.5-.5zM13.5 8H8.75v2h4.75zm0 3.5H8.75v2H13a.5.5 0 0 0 .5-.5zm-6.25 2v-2H2.5V13a.5.5 0 0 0 .5.5zM2.5 10h4.75V8H2.5z"],
  embed: ["M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2zm2-.5a.5.5 0 0 0-.5.5v4h11V3a.5.5 0 0 0-.5-.5zm10.5 6h-11V13a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5zm-8-3H4V4h1.5zm6.5 0H7V4h5z"],
  personAvatar: ["M8 1.5a6.5 6.5 0 0 0-4.148 11.505A2.75 2.75 0 0 1 6.5 11h3c1.26 0 2.323.848 2.648 2.005A6.5 6.5 0 0 0 8 1.5m2.75 12.392v-.142c0-.69-.56-1.25-1.25-1.25h-3c-.69 0-1.25.56-1.25 1.25v.142l.06.027c.82.373 1.73.581 2.69.581s1.87-.208 2.69-.58q.03-.016.06-.028M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8-3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4m-3.5 2a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0"],
  clock: ["M14.5 8a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0M8.75 3.25v4.389l2.219 1.775-.938 1.172-2.5-2-.281-.226V3.25zM16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0"],
  star: ["M8 0a.75.75 0 0 1 .7.48l1.705 4.434 4.403.338a.75.75 0 0 1 .422 1.324l-3.38 2.818 1.25 4.662a.75.75 0 0 1-1.148.813L8 12.159l-3.95 2.71a.75.75 0 0 1-1.15-.813l1.251-4.662L.77 6.576a.75.75 0 0 1 .422-1.324l4.403-.338L7.3.48A.75.75 0 0 1 8 0m0 2.84L6.655 6.335l-3.506.27 2.7 2.25-.973 3.627L8 10.341l3.124 2.142-.973-3.627 2.7-2.25-3.506-.27z", "M6.655 6.336 8 2.84l1.345 3.497 3.506.27-2.7 2.25.973 3.627L8 10.341l-3.124 2.142.973-3.627-2.7-2.25z"],
  grid: ["M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2zm2-.5a.5.5 0 0 0-.5.5v4.25h4.75V2.5zm5.75 0v4.75h4.75V3a.5.5 0 0 0-.5-.5zm4.75 6.25H8.75v4.75H13a.5.5 0 0 0 .5-.5zM7.25 13.5V8.75H2.5V13a.5.5 0 0 0 .5.5z"],
};
type Glyph = keyof typeof ATLASKIT;

function glyph(name: Glyph) {
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    {ATLASKIT[name].map(d => <path d={d} fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" />)}
  </svg>;
}

/**
 * A glyph on its own tint, filling the tile the picker draws behind a node's icon: Confluence's own
 * colours for its content types, as its object icons draw them (pages blue, live docs magenta).
 */
const tinted = (name: Glyph, tint: string) => <span className={`cf-icon tint-${tint}`}>{glyph(name)}</span>;

const KIND_ICONS: Record<Exclude<Kind, "site" | "space" | "personalSpace">, unknown> = {
  overview: tinted("home", "blue"),
  page: tinted("page", "blue"),
  liveDoc: tinted("liveDoc", "pink"),
  blogpost: tinted("blog", "purple"),
  blogs: tinted("blog", "purple"),
  folder: tinted("folder", "neutral"),
  whiteboard: tinted("whiteboard", "teal"),
  database: tinted("database", "green"),
  embed: tinted("embed", "neutral"),
};

/**
 * Every icon a node or tab names. A space's entry, `avatar:<ref>`, starts as its initials (a personal
 * space's as a person) and becomes the space's own icon once `spaceAvatars` has it; the picker reads
 * the map on every render, so the next one draws it.
 */
const ICONS: Record<string, unknown> = {
  // The Confluence mark, as the Workshop draws the vendor (src/confluence-logo.svg).
  site: <svg viewBox="0 0 32 32" aria-hidden="true">
    <defs>
      <linearGradient id="cf-logo-a" x1="28.3" y1="24.7" x2="11.9" y2="15.2" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#0052CC" /><stop offset="0.92" stop-color="#2684FF" />
      </linearGradient>
      <linearGradient id="cf-logo-b" x1="3.7" y1="7.3" x2="20.1" y2="16.8" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#0052CC" /><stop offset="0.92" stop-color="#2684FF" />
      </linearGradient>
    </defs>
    <path fill="url(#cf-logo-a)" d="M5.7 22.6c-.3.5-.6 1-.9 1.5-.3.5-.1 1.1.4 1.4l5.7 3.5c.5.3 1.2.1 1.5-.4 0 0 .3-.5.6-1 2-3.4 4.1-3 7.8-1.2l5.7 2.7c.5.2 1.2 0 1.4-.6l2.7-6.2c.2-.5 0-1.2-.5-1.4-1.2-.6-3.6-1.7-5.7-2.7-7.7-3.7-14.3-3.5-18.2 2.9z" />
    <path fill="url(#cf-logo-b)" d="M26.3 9.4c.3-.5.6-1 .9-1.5.3-.5.1-1.1-.4-1.4L21.1 3c-.5-.3-1.2-.2-1.5.4 0 0-.3.5-.6 1-2 3.4-4.1 3-7.8 1.2L5.5 2.9c-.5-.2-1.2 0-1.4.6L1.4 9.7c-.2.5 0 1.2.5 1.4 1.2.6 3.6 1.7 5.7 2.7 7.7 3.7 14.3 3.4 18.2-2.9z" />
  </svg>,
  recent: glyph("clock"),
  starred: glyph("star"),
  spaces: glyph("grid"),
  ...KIND_ICONS,
};

// The tile behind a space with no icon of its own, picked by its key so it never changes.
const AVATAR_TINTS = ["blue", "teal", "green", "purple", "orange", "pink", "amber", "indigo"];

/** A space's tile of its initials, in a colour its ref always picks. */
function initials({ ref, title }: Pick<Node, "ref" | "title">) {
  const words = title.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word));
  const text = (words.length > 1 ? [...words[0]!][0]! + [...words[1]!][0]! : [...(words[0] ?? "?")].slice(0, 2).join("")).toUpperCase();
  let hash = 0;
  for (const char of ref) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return <span className={`cf-icon cf-initials tint-${AVATAR_TINTS[hash % AVATAR_TINTS.length]}`}>{text}</span>;
}

const isSpace = (kind: Kind) => kind === "space" || kind === "personalSpace";

/** The key into {@link ICONS} for `node`, adding a space's starting entry the first time it is seen. */
function iconOf(node: Pick<Node, "ref" | "kind" | "title">): string {
  if (!isSpace(node.kind)) return node.kind in ICONS ? node.kind : "page";
  const key = `avatar:${node.ref}`;
  ICONS[key] ??= node.kind === "space" ? initials(node) : tinted("personAvatar", "neutral");
  return key;
}

/** The most refs one `spaceAvatars` call may carry. */
const AVATAR_BATCH = 100;
const avatarsAsked = new Set<string>();

/** Asks for the icons of the spaces among `nodes` not asked for yet, and redraws when they arrive. */
function requestAvatars(ui: Rpc, nodes: Pick<Node, "ref" | "kind">[]): void {
  const refs = [...new Set(nodes.filter(node => isSpace(node.kind) && !avatarsAsked.has(node.ref)).map(node => node.ref))];
  for (let from = 0; from < refs.length; from += AVATAR_BATCH) {
    const batch = refs.slice(from, from + AVATAR_BATCH);
    for (const ref of batch) avatarsAsked.add(ref);
    ui.spaceAvatars(batch).then(found => {
      for (const [ref, src] of Object.entries(found)) {
        if (batch.includes(ref)) ICONS[`avatar:${ref}`] = <span className="cf-icon cf-avatar"><img src={src} alt="" /></span>;
      }
      if (Object.keys(found).length > 0) rerender();
    }, () => {
      // Initials stand in. A later listing asks again.
      for (const ref of batch) avatarsAsked.delete(ref);
    });
  }
}

// -- the picker's nodes -------------------------------------------------------------------------

const TABS: Tab[] = [
  { id: "recent", title: "Recent", icon: "recent" },
  { id: "starred", title: "Starred", icon: "starred" },
  { id: "spaces", title: "Spaces", icon: "spaces" },
];
const SECTIONS: Record<string, Request["section"]> = { recent: "recent", starred: "starred", spaces: "spaces" };
/** What an empty tab says, in place of the picker's "Nothing here." */
const EMPTY_TAB: Record<string, string> = {
  recent: "Pages and blog posts you view in Confluence show here.",
  starred: "Spaces, pages and blog posts you star in Confluence show here.",
};
/** Where every node lives: a search result or a looked-up node opens under it. */
const SPACES_TAB: Ancestor = { id: "spaces", title: "Spaces", selectable: false };

/**
 * Every node listed or looked up, by ref: what a choice's kind is, and where a node with a `path`
 * lives, so the picker can open at a choice without asking again.
 */
const nodes = new Map<string, Node>();

function remember(node: Node): void {
  // A breadcrumb's node says less than a listed one, so it never replaces it.
  for (const crumb of node.path ?? []) if (!nodes.has(crumb.ref)) nodes.set(crumb.ref, { ...crumb, expandable: true, selectable: PATTERN_OF[crumb.kind] !== undefined });
  const known = nodes.get(node.ref);
  nodes.set(node.ref, known?.path && !node.path ? { ...node, path: known.path } : node);
}

const choiceOf = (kind: Kind, title: string) => ({ title: `All of ${title}`, subtitle: PLACE_COVERS[kind] });

function toAncestor({ ref, title, kind }: Crumb, accepted: readonly string[] | undefined): Ancestor {
  const reason = refusal(accepted, {
    kind, selectable: PATTERN_OF[kind] !== undefined,
    unselectableReason: `You can't choose all of ${title}, but you can choose what's inside.`,
  });
  return { id: ref, title, icon: iconOf({ ref, kind, title }), selectable: reason === undefined, unselectableReason: reason, choice: choiceOf(kind, title) };
}

/** A node as the picker lists it. One listed away from where it lives (recent, starred) says where. */
function toItem(node: Node, accepted: readonly string[] | undefined, located = false): Item {
  remember(node);
  const reason = refusal(accepted, node);
  return {
    id: node.ref,
    title: node.title,
    kind: node.expandable ? "container" : "leaf",
    icon: iconOf(node),
    subtitle: located && node.path?.length ? node.path.map(crumb => crumb.title).join(" / ") : node.subtitle,
    meta: node.meta,
    selectable: reason === undefined,
    unselectableReason: reason,
    choice: node.expandable ? choiceOf(node.kind, node.title) : undefined,
    path: node.path && [SPACES_TAB, ...node.path.map(crumb => toAncestor(crumb, accepted))],
  };
}

async function loadPage({ ui, acceptedResourceUrlPatterns: accepted }: Context, site: string, { parentId, query, cursor }: PickerRequest): Promise<Page> {
  const section = query ? undefined : SECTIONS[parentId];
  // A search covers the whole site, whichever tab or container is open.
  const request: Request = query ? { site, query } : section ? { site, section } : { parent: parentId };
  if (cursor) request.cursor = cursor;
  const page = await ui.loadItems(request);
  // A link to this site names the card above the tabs, which the picker doesn't list again.
  if (query && page.items.some(node => node.ref === site)) {
    const reason = refusal(accepted, { kind: "site", selectable: true });
    return { items: [], nextCursor: null, notice: reason ?? "That link is to the whole site. Choose it above the tabs." };
  }
  requestAvatars(ui, page.items.flatMap(node => [node, ...node.path ?? []]));
  return {
    items: page.items.map(node => {
      const item = toItem(node, accepted, section === "recent" || section === "starred");
      // A pasted link may name another of the connection's sites. Opened here, it would list under
      // this site; chosen, the picker switches to that site and opens it there. One that can't be
      // chosen stays a place to open, the only way to what inside it can be.
      return query && item.selectable && siteRefOf(node.ref) !== site ? { ...item, kind: "leaf" as const, choice: undefined } : item;
    }),
    nextCursor: page.nextCursor ?? null,
    notice: page.notice ?? (page.items.length === 0 && !cursor && section ? EMPTY_TAB[section] : undefined),
  };
}

/** The node a value names, with where it lives, from what was listed or else from Confluence. */
async function loadNode({ ui, acceptedResourceUrlPatterns: accepted }: Context, ref: string): Promise<Item | null> {
  let node = nodes.get(ref);
  if (node?.path === undefined) node = (await ui.locate(ui.resourceUrlFor(ref))) ?? undefined;
  if (!node) return null;
  requestAvatars(ui, [node, ...node.path ?? []]);
  return toItem(node, accepted);
}

const valuesOf = (node: Pick<Node, "ref" | "kind">): Values => ({ ref: node.ref, kind: node.kind });
const NOTHING: Values = { ref: null, kind: null };

// -- rendering ----------------------------------------------------------------------------------

function picker(context: Context, sites: Site[]) {
  const { values, setValues, acceptedResourceUrlPatterns: accepted } = context;
  const site = sites.find(candidate => candidate.ref === openSite)
    ?? sites.find(candidate => values.ref && candidate.ref === siteRefOf(values.ref))
    ?? sites[0]!;
  openSite = site.ref;
  return <Fragment>
    {sites.length > 1 ? <Field label="Site">
      <RadioCards
        compact
        value={site.ref}
        options={sites.map(candidate => ({ value: candidate.ref, title: candidate.name, description: candidate.host }))}
        onChange={next => {
          if (next === site.ref) return;
          // The picker starts afresh on the other site, where the choice made here isn't.
          openSite = next;
          setValues(NOTHING);
        }}
      />
    </Field> : null}
    <Field label={FIELD_LABEL}>
      <HierarchyPicker
        name="ref"
        value={values.ref ?? null}
        root={{ id: site.ref, title: site.name, subtitle: ROOT_SUBTITLE, icon: "site", selectable: accepts(accepted, "site") }}
        tabs={TABS}
        icons={ICONS}
        searchPlaceholder={SEARCH_PLACEHOLDER}
        loadItems={request => loadPage(context, site.ref, request)}
        loadItem={ref => loadNode(context, ref)}
        onChange={next => {
          if (next === null) {
            setValues(NOTHING);
            return;
          }
          missing = null;
          // A pasted link may name another of the connection's sites, which the picker then shows.
          const nextSite = siteRefOf(next);
          if (nextSite !== site.ref && sites.some(candidate => candidate.ref === nextSite)) openSite = nextSite;
          const kind = next === site.ref ? "site" : nodes.get(next)?.kind;
          setValues({ ref: next, kind: kind ?? null });
        }}
      />
    </Field>
  </Fragment>;
}

/** The picker as it will be, waiting on the connection, so the form doesn't move once it is known. */
function placeholder({ acceptedResourceUrlPatterns: accepted }: Context) {
  return <Field label={FIELD_LABEL}>
    <HierarchyPicker
      name="ref"
      value={null}
      root={{ id: "loading", title: "Confluence", subtitle: ROOT_SUBTITLE, icon: "site", selectable: accepts(accepted, "site") }}
      tabs={TABS}
      icons={ICONS}
      searchPlaceholder={SEARCH_PLACEHOLDER}
      loadItems={() => new Promise(() => {})}
      onChange={() => {}}
      disabled
    />
  </Field>;
}

/** What became of a pre-filled resource URL the picker isn't showing as a choice. */
function prefillNotice({ ui, setValues }: Context, attempt: NonNullable<typeof missing>) {
  const { url, failed } = attempt;
  if (failed === undefined) {
    return <Notice>{`Couldn't find ${url} in a Confluence site this connection can open. Choose what to connect.`}</Notice>;
  }
  return <Fragment>
    <Notice tone="error">{`Couldn't look up ${url}. ${failed}`}</Notice>
    <div>
      <Button variant="secondary" onClick={() => {
        ui.locate(url).then(located => {
          // A choice made while the lookup ran (which cleared `missing`) stands; the late answer is dropped.
          if (missing !== attempt) return;
          if (located === null) {
            missing = { url };
            rerender();
            return;
          }
          missing = null;
          remember(located);
          // The picker opens on the site the lookup found it in.
          openSite = null;
          setValues(valuesOf(located));
        }, error => {
          if (missing !== attempt) return;
          missing = { url, failed: errorMessage(error, "Couldn't reach Confluence.") };
          rerender();
        });
      }}>Try again</Button>
    </div>
  </Fragment>;
}

function notices(context: Context) {
  if (connection.state !== "failed" && connection.state !== "unavailable") return null;
  return <Fragment>
    <Notice tone="error">{connection.message}</Notice>
    {connection.state === "failed" ? <div>
      <Button variant="secondary" onClick={() => {
        asked = false;
        connection = { state: "loading" };
        loadStatus(context);
        rerender();
      }}>Try again</Button>
    </div> : null}
  </Fragment>;
}

// Each kind's tint for the icon tiles, on the runtime's tokens, so they follow the host's light and
// dark themes as the other pickers' icons do.
const STYLE = `
.cf-icon {
  --cf-tint: var(--text-color-kumo-subtle);
  display: flex; width: 100%; height: 100%; align-items: center; justify-content: center;
  color: var(--cf-tint); background: color-mix(in oklab, var(--cf-tint) 11%, var(--color-kumo-base));
}
.cf-icon svg { width: 16px; height: 16px; }
.cf-icon.tint-neutral { background: var(--color-kumo-tint); }
.cf-icon.tint-blue { --cf-tint: oklch(54% 0.17 258); }
.cf-icon.tint-green { --cf-tint: oklch(53% 0.13 152); }
.cf-icon.tint-orange { --cf-tint: oklch(62% 0.17 48); }
.cf-icon.tint-purple { --cf-tint: oklch(53% 0.19 300); }
.cf-icon.tint-pink { --cf-tint: oklch(56% 0.19 350); }
.cf-icon.tint-amber { --cf-tint: oklch(62% 0.13 75); }
.cf-icon.tint-indigo { --cf-tint: oklch(52% 0.15 275); }
.cf-icon.tint-teal { --cf-tint: oklch(53% 0.09 195); }
@media (prefers-color-scheme: dark) {
  /* White initials keep the light theme's deeper tints behind them. */
  .cf-icon:not(.cf-initials).tint-blue { --cf-tint: oklch(74% 0.13 258); }
  .cf-icon:not(.cf-initials).tint-green { --cf-tint: oklch(74% 0.13 152); }
  .cf-icon:not(.cf-initials).tint-orange { --cf-tint: oklch(76% 0.14 55); }
  .cf-icon:not(.cf-initials).tint-purple { --cf-tint: oklch(74% 0.13 300); }
  .cf-icon:not(.cf-initials).tint-pink { --cf-tint: oklch(74% 0.14 350); }
  .cf-icon:not(.cf-initials).tint-amber { --cf-tint: oklch(80% 0.12 80); }
  .cf-icon:not(.cf-initials).tint-indigo { --cf-tint: oklch(74% 0.11 275); }
  .cf-icon:not(.cf-initials).tint-teal { --cf-tint: oklch(76% 0.09 195); }
}
/* A space's icon is a picture, framed like Confluence's rounded space avatars. */
.cf-avatar { background: var(--color-kumo-tint); }
.cf-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.cf-initials { color: #fff; background: var(--cf-tint); font-size: 10.5px; font-weight: 700; letter-spacing: .02em; }
`;

export default {
  initial: {},

  isReady({ values, acceptedResourceUrlPatterns }) {
    return typeof values.ref === "string" && values.kind != null && accepts(acceptedResourceUrlPatterns, values.kind)
      && connection.state === "ready";
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    let located: Node | null;
    try {
      located = await ui.locate(resourceUrl);
    } catch (error) {
      missing = { url: resourceUrl, failed: errorMessage(error, "Couldn't reach Confluence.") };
      return {};
    }
    if (located === null) {
      // Never a fallback to the whole site: that would bind everything with one click, in place of what was asked for.
      missing = { url: resourceUrl };
      return {};
    }
    remember(located);
    return valuesOf(located);
  },

  resourceUrl({ values, ui }) {
    if (!values.ref) throw new Error("Choose what to connect.");
    return ui.resourceUrlFor(values.ref);
  },

  render(context) {
    rerender = () => context.setValues({});
    loadStatus(context);
    if (connection.state === "unavailable" || connection.state === "failed") return <Section>{notices(context)}</Section>;
    return <Section>
      <style>{STYLE}</style>
      {missing !== null && !context.values.ref ? prefillNotice(context, missing) : null}
      {connection.state === "ready" ? picker(context, connection.sites) : placeholder(context)}
    </Section>;
  },
} satisfies ConfiguratorUISpec<Rpc, Values>;
