// The contract between the Confluence configurator frame and `ConfluenceConfiguratorUI`. The frame is
// transpiled on its own and cannot import runtime code, so the shapes it trades are declared here.
// The frame never builds a resource URL: it trades refs, and the gatekeeper writes the URL a ref
// binds (`resourceUrlFor`), so the frame holds no copy of the URL grammar.

/** What a node is, which decides its icon and what choosing it binds. */
export type ConfluenceNodeKind =
  | "site" | "space" | "personalSpace" | "overview" | "page" | "liveDoc" | "blogpost"
  | "blogs" | "folder" | "whiteboard" | "database" | "embed";

/** A place above a node, as a breadcrumb shows it. */
export type ConfluenceCrumb = { ref: string; title: string; kind: ConfluenceNodeKind };

/** One row of the browser. */
export type ConfluenceNode = {
  /**
   * `site:<cloudId>`, `space:<cloudId>/<key>`, `page:<cloudId>/<id>` or `blogpost:<cloudId>/<id>`, or
   * a browse-only `blogs:<cloudId>/<key>`, `folder:`, `whiteboard:`, `database:` or `embed:<cloudId>/<id>`.
   * Only the kind before the colon means anything to the frame; the rest is the gatekeeper's.
   */
  ref: string;
  kind: ConfluenceNodeKind;
  title: string;
  /** A space's key, "Personal space", a post's date. */
  subtitle?: string;
  /** When it last changed, "Oct 12", shown at the row's end. */
  meta?: string;
  /** Whether it may hold children. A page whose children weren't counted says true, and its listing may come back empty. */
  expandable: boolean;
  selectable: boolean;
  unselectableReason?: string;
  /** Search results and located nodes: where it lives, below the site, outermost first. */
  path?: ConfluenceCrumb[];
};

/** A connected site. */
export type ConfluenceSite = { cloudId: string; name: string; host: string; ref: string };

/** What the connection allows, read once when the frame opens. */
export type ConfluenceConfiguratorStatus =
  | { state: "ready"; sites: ConfluenceSite[] }
  /** The connection lists no Confluence site: none was chosen when connecting, or access was removed. */
  | { state: "unavailable"; message: string };

/**
 * What the picker asks for: a node's children (`parent`), a search of a site (`query`), or one of a
 * site's tabs (`section`). Exactly one of the three is set.
 */
export type ConfluenceBrowseRequest = {
  /** A site's ref. Needed with `query` and `section`. */
  site?: string;
  parent?: string;
  query?: string;
  section?: "spaces" | "starred" | "recent";
  cursor?: string;
};

export type ConfluenceBrowsePage = {
  items: ConfluenceNode[];
  nextCursor?: string;
  /** Something the user should know about this listing, such as content it can't show. */
  notice?: string;
};

export type ConfluenceConfiguratorValues = {
  /** What is chosen, as a ref. */
  ref?: string | null;
  /** The chosen node's kind, which says whether the Workshop takes it. */
  kind?: ConfluenceNodeKind | null;
};

export interface ConfluenceConfiguratorRpc {
  getStatus(): Promise<ConfluenceConfiguratorStatus>;
  /** One page of rows. Rejections carry a message written for the user. */
  loadItems(request: ConfluenceBrowseRequest): Promise<ConfluenceBrowsePage>;
  /** The node a resource URL or pasted link names, with its path, or null when this connection can't open it. */
  locate(url: string): Promise<ConfluenceNode | null>;
  /** The resource URL a ref binds. */
  resourceUrlFor(ref: string): Promise<string>;
  /**
   * The icons of up to 100 spaces, by their refs, as `data:` image URLs. A space with no icon of its
   * own, or whose icon can't be read, is left out; the frame draws its initials. Asked for after a
   * listing shows, so rows never wait on icons.
   */
  spaceAvatars(refs: string[]): Promise<Record<string, string>>;
}
