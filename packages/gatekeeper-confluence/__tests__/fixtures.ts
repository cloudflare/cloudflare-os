// A small Confluence site as the configurator RPC describes it, shaped like the test site the
// gatekeeper was built against: two team spaces, a personal space, a page tree and a blog.

import type {
  ConfluenceBrowsePage, ConfluenceBrowseRequest, ConfluenceConfiguratorStatus, ConfluenceNode,
} from "../src/configurator/confluence-configurator-types";

const CLOUD = "5c121664-a643-497d-99b3-25e02a81f02f";
export const SITE_REF = `site:${CLOUD}`;
export const READY: ConfluenceConfiguratorStatus = {
  state: "ready",
  sites: [{ cloudId: CLOUD, name: "Slew", host: "slew.atlassian.net", ref: SITE_REF }],
};

// A space icon as Confluence serves one: a small square image.
const avatar = (color: string, glyph: string) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="${color}"/><text x="24" y="32" font-family="sans-serif" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">${glyph}</text></svg>`)}`;

export const space = (key: string, title: string, extra: Partial<ConfluenceNode> = {}): ConfluenceNode => ({
  ref: `space:${CLOUD}/${key}`, kind: "space", title, subtitle: key, expandable: true, selectable: true, ...extra,
});
export const page = (id: string, title: string, extra: Partial<ConfluenceNode> = {}): ConfluenceNode => ({
  ref: `page:${CLOUD}/${id}`, kind: "page", title, expandable: false, selectable: true, ...extra,
});

export const MFS = space("MFS", "My first space");
export const TH = space("TH", "Team Handbook");
export const PERSONAL = space("~7120206f", "Phillip Jones", { kind: "personalSpace", subtitle: "Personal space" });

/** The team spaces' icons, as `spaceAvatars` answers them; the personal space has none. */
export const AVATARS: Record<string, string> = { [MFS.ref]: avatar("#1868DB", "M"), [TH.ref]: avatar("#5B7F24", "T") };
/** Answers `spaceAvatars` from {@link AVATARS}. */
export const spaceAvatars = (refs: string[]): Record<string, string> =>
  Object.fromEntries(refs.flatMap(ref => (ref in AVATARS ? [[ref, AVATARS[ref]!]] : [])));

export const SPACES: ConfluenceBrowsePage = { items: [MFS, TH, PERSONAL] };
export const RECENT: ConfluenceBrowsePage = {
  items: [
    page("491521", "Architecture", { meta: "Oct 24", expandable: true, path: [{ ref: MFS.ref, title: MFS.title, kind: "space" }, { ref: `page:${CLOUD}/458753`, title: "Engineering", kind: "page" }] }),
    page("589825", "Q4 planning", { kind: "liveDoc", meta: "Oct 23", path: [{ ref: MFS.ref, title: MFS.title, kind: "space" }] }),
    page("360470", "Shipping the new editor", { ref: `blogpost:${CLOUD}/360470`, kind: "blogpost", meta: "Oct 22", path: [{ ref: MFS.ref, title: MFS.title, kind: "space" }, { ref: `blogs:${CLOUD}/MFS`, title: "Blog", kind: "blogs" }] }),
  ],
};
export const STARRED: ConfluenceBrowsePage = { items: [MFS, RECENT.items[0]!] };
export const MFS_ROOT: ConfluenceBrowsePage = {
  items: [
    page("164185", "My first space", { kind: "overview", subtitle: "Space home" }),
    { ref: `blogs:${CLOUD}/MFS`, kind: "blogs", title: "Blog", expandable: true, selectable: false, unselectableReason: "Choose one post, or the whole space." },
    page("458753", "Engineering", { expandable: true, meta: "Oct 24" }),
    page("360450", "Onboarding", { expandable: true, meta: "Oct 20" }),
    page("589825", "Q4 planning", { kind: "liveDoc", meta: "Oct 23" }),
    { ref: `whiteboard:${CLOUD}/600001`, kind: "whiteboard", title: "Retro board", expandable: false, selectable: false, unselectableReason: "Can't be connected yet." },
    { ref: `database:${CLOUD}/600002`, kind: "database", title: "Launch tracker", expandable: false, selectable: false, unselectableReason: "Can't be connected yet." },
    { ref: `folder:${CLOUD}/600003`, kind: "folder", title: "Archive", expandable: true, selectable: false, unselectableReason: "A folder can't be connected on its own. Choose a page in it, or the whole space." },
  ],
};
export const ENGINEERING: ConfluenceBrowsePage = {
  items: [
    page("491521", "Architecture", { expandable: true, meta: "Oct 24" }),
    page("327884", "On-call runbook", { meta: "Oct 2" }),
    { ref: `embed:${CLOUD}/600004`, kind: "embed", title: "Status dashboard", expandable: false, selectable: false, unselectableReason: "Can't be connected yet." },
  ],
};
export const ARCHITECTURE: ConfluenceBrowsePage = {
  items: [page("524289", "Storage architecture", { meta: "Oct 21" }), page("327884", "Networking", { meta: "Oct 19" })],
};
export const BLOG: ConfluenceBrowsePage = {
  items: [
    page("360470", "Shipping the new editor", { ref: `blogpost:${CLOUD}/360470`, kind: "blogpost", subtitle: "Oct 22, 2026" }),
    page("524309", "Welcome to the team blog", { ref: `blogpost:${CLOUD}/524309`, kind: "blogpost", subtitle: "Oct 12, 2026" }),
  ],
};
export const SEARCH_ARCH: ConfluenceBrowsePage = {
  items: [
    page("491521", "Architecture", {
      meta: "Oct 24",
      path: [{ ref: MFS.ref, title: MFS.title, kind: "space" }, { ref: `page:${CLOUD}/458753`, title: "Engineering", kind: "page" }],
    }),
    page("524289", "Storage architecture", {
      meta: "Oct 21",
      path: [{ ref: MFS.ref, title: MFS.title, kind: "space" }, { ref: `page:${CLOUD}/458753`, title: "Engineering", kind: "page" }, { ref: `page:${CLOUD}/491521`, title: "Architecture", kind: "page" }],
    }),
  ],
};

/** Answers `loadItems` from the fixtures above. */
export function browse(request: ConfluenceBrowseRequest): ConfluenceBrowsePage {
  if (request.section === "spaces") return SPACES;
  if (request.section === "starred") return STARRED;
  if (request.section === "recent") return RECENT;
  if (request.query) return SEARCH_ARCH;
  switch (request.parent) {
    case MFS.ref: return MFS_ROOT;
    case `page:${CLOUD}/458753`: return ENGINEERING;
    case `page:${CLOUD}/491521`: return ARCHITECTURE;
    case `blogs:${CLOUD}/MFS`: return BLOG;
    default: return { items: [] };
  }
}
