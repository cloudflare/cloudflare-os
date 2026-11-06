// The contract between the PagerDuty configurator frame and `PagerDutyConfiguratorUI`. The frame is
// transpiled on its own and cannot import runtime code, so the shapes it trades are declared here.
// The frame never builds a resource URL: it trades refs, and the gatekeeper writes the URL a ref
// binds (`resourceUrlFor`), so the frame holds no copy of the URL grammar.

/** What a node is, which decides its icon and what choosing it binds. */
export type PagerDutyNodeKind = "account" | "team" | "service" | "incident" | "schedule";

/** A place above a node, as a breadcrumb shows it. */
export type PagerDutyCrumb = { ref: string; kind: PagerDutyNodeKind; title: string };

/** One row of the browser. */
export type PagerDutyNode = {
  /** `account`, or `<kind>:<id>`, e.g. `service:PABC123`. Only the kind means anything to the frame. */
  ref: string;
  kind: PagerDutyNodeKind;
  title: string;
  /** A team's or service's description, an incident's number and service. */
  subtitle?: string;
  /** An incident's status, a service's state. */
  badge?: string;
  /** When an incident was opened, "Oct 12". */
  meta?: string;
  /** Search results and located nodes: the service an incident is on. */
  path?: PagerDutyCrumb[];
};

/** What the connection allows, read once when the frame opens. */
export type PagerDutyConfiguratorStatus =
  | { state: "ready"; account: { ref: "account"; host: string } }
  | { state: "unavailable"; message: string };

/** One of the picker's tabs. */
export type PagerDutySection = "teams" | "services" | "schedules" | "incidents";

/**
 * What the picker asks for: a team's services and schedules or a service's open incidents
 * (`parent`), a search of the account (`query`), or one of its tabs (`section`). Exactly one of the
 * three is set.
 */
export type PagerDutyBrowseRequest = {
  parent?: string;
  query?: string;
  section?: PagerDutySection;
  cursor?: string;
};

export type PagerDutyBrowsePage = {
  items: PagerDutyNode[];
  nextCursor?: string;
  /** Something the user should know about this listing. */
  notice?: string;
};

export type PagerDutyConfiguratorValues = {
  /** What is chosen, as a ref. */
  ref?: string | null;
  /** The chosen node's kind, which says whether the Workshop takes it. */
  kind?: PagerDutyNodeKind | null;
};

export interface PagerDutyConfiguratorRpc {
  getStatus(): Promise<PagerDutyConfiguratorStatus>;
  /** One page of rows. Rejections carry a message written for the user. */
  loadItems(request: PagerDutyBrowseRequest): Promise<PagerDutyBrowsePage>;
  /** The node a resource URL, pasted link or ref names, or null when this connection can't open it. */
  locate(urlOrRef: string): Promise<PagerDutyNode | null>;
  /** The resource URL a ref binds. */
  resourceUrlFor(ref: string): Promise<string>;
}
