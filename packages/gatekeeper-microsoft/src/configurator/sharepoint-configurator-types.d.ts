// The contract between the SharePoint configurator frame and `SharePointConfiguratorUI`. The frame is
// transpiled on its own and cannot import runtime code, so the shapes it trades are declared here.

/** The glyph a row is drawn with: a kind of place, or of file. */
export type SharePointBrowserIcon =
  | "drive" | "onedrive" | "site" | "library" | "list" | "pages" | "page"
  | "folder" | "shared-folder"
  | "document" | "spreadsheet" | "presentation" | "pdf" | "image" | "video" | "audio" | "archive"
  | "text" | "code" | "file";

/** A place above a row, as a breadcrumb shows it. */
export type SharePointBrowserCrumb = {
  value: string;
  title: string;
  icon?: SharePointBrowserIcon;
  selectable?: boolean;
  unselectableReason?: string;
};

/** One row of the picker. `value` is a ref, below. */
export type SharePointBrowserItem = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
  icon?: SharePointBrowserIcon;
  navigable?: boolean;
  selectable?: boolean;
  unselectableReason?: string;
  badge?: string;
  path?: SharePointBrowserCrumb[];
};

/** What the picker asks for: one place, optionally narrowed by a search or a pasted link. */
export type SharePointBrowserRequest = {
  tab: string;
  container?: string;
  query?: string;
  pageToken?: string;
};

export type SharePointBrowserPage = {
  items: SharePointBrowserItem[];
  nextPageToken?: string;
  notice?: string;
};

/** Where a known resource sits in the picker, for opening the picker at it. */
export type SharePointLocated = {
  ref: string;
  title: string;
  tab: string;
  path: SharePointBrowserCrumb[];
};

/** What the connection allows, read once when the frame opens. */
export type SharePointConfiguratorStatus =
  | {
    state: "ready";
    /** Whether agents can propose changes (`write`) or only read (`read`). */
    access: "read" | "write";
    /** The organization's SharePoint name, e.g. `contoso`. */
    tenant: string;
  }
  /** The connection's grant does not cover SharePoint; `ensureResources` asks for it. */
  | { state: "needsAccess" }
  /** The account has no SharePoint, such as one with no SharePoint license. */
  | { state: "unavailable"; message: string };

export type SharePointConfiguratorValues = {
  /**
   * What is chosen, as a ref: `all`, `site:<siteId>`, `drive:<driveId>`, `folder:<driveId>/<itemId>`,
   * `file:<driveId>/<itemId>`, `list:<siteId>/<listId>` or `page:<siteId>/<pageId>`. Only the kind
   * before the colon means anything to the frame; the rest is the gatekeeper's.
   */
  ref?: string | null;
  /** The chosen thing's name, for the summary. */
  title?: string | null;
  /** Where to open the picker, as JSON of `{ tab, path }`, when the choice came with the frame. */
  location?: string | null;
};

export interface SharePointConfiguratorRpc {
  getStatus(): Promise<SharePointConfiguratorStatus>;
  /** One page of the picker's rows. Rejections carry a message written for the user. */
  loadItems(request: SharePointBrowserRequest): Promise<SharePointBrowserPage>;
  /** The resource URL a ref binds. */
  resourceUrlFor(ref: string): Promise<string>;
  /** Where a resource URL sits in the picker, or null when it names nothing the user can open. */
  locate(resourceUrl: string): Promise<SharePointLocated | null>;
}
