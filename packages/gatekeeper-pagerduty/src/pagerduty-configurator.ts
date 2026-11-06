// The PagerDuty resource configurator's capability: what the browser frame lists, finds and binds.
//
// One frame chooses among all five resource types, so it trades refs (`team:PABC123`) and
// `resourceUrlFor` writes the URL a ref binds, only for an object the connection can still open.
// Every agent-supplied ID is held to PagerDuty's ID grammar before it reaches a request path.
// Nothing here is an agent observation: these reads serve the owner's own picker.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { isCredentialsExpired, type CredentialSource } from "@gadgets/gatekeeper-kit/credentials";
import { MAX_LIMIT, PagerDutyApi, isDenial, type Page, type Query } from "./pagerduty-api";
import { RECONNECT_MESSAGE, accountSource, type Identity, type PublicGrant } from "./pagerduty-credentials";
import { webOrigin } from "./pagerduty-env";
import type { WireIncident, WireSchedule, WireService, WireTeam } from "./pagerduty-normalize";
import { INCIDENT_NUMBER, OBJECT_ID, parseResourceUrl, resourceUrl, sameTenant } from "./pagerduty-urls";
import type {
  PagerDutyBrowsePage, PagerDutyBrowseRequest, PagerDutyConfiguratorRpc, PagerDutyConfiguratorStatus,
  PagerDutyNode, PagerDutyNodeKind,
} from "./configurator/pagerduty-configurator-types";

/** Rows per picker page. */
const PAGE_SIZE = 25;
const MAX_QUERY_LENGTH = 200;
const MAX_CURSOR_LENGTH = 64;
const GONE = "What you chose no longer exists, or this connection can't open it. Choose again.";

type ObjectKind = Exclude<PagerDutyNodeKind, "account">;
type Ref = { kind: "account" } | { kind: ObjectKind; id: string };

/** Where each kind's lookup reads; PagerDuty wraps the object in a key named for its kind. */
const LOOKUPS: Record<ObjectKind, string> = {
  team: "/teams/", service: "/services/", incident: "/incidents/", schedule: "/schedules/",
};

const REF = /^(team|service|incident|schedule):([A-Z0-9]{1,64})$/;

/** The ref a frame handed back. */
function parseRef(ref: string): Ref {
  if (ref === "account") return { kind: "account" };
  const match = typeof ref === "string" ? REF.exec(ref) : null;
  if (!match) throw new Error("That can't be opened.");
  return { kind: match[1] as ObjectKind, id: match[2]! };
}

const OPEN_STATUSES = ["triggered", "acknowledged"];

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function teamNode(wire: WireTeam): PagerDutyNode {
  return { ref: `team:${wire.id}`, kind: "team", title: wire.name ?? wire.summary ?? wire.id, subtitle: wire.description || undefined };
}

function serviceNode(wire: WireService): PagerDutyNode {
  return {
    ref: `service:${wire.id}`, kind: "service", title: wire.name ?? wire.summary ?? wire.id,
    subtitle: wire.description || undefined, badge: wire.status && wire.status !== "active" ? wire.status : undefined,
  };
}

function scheduleNode(wire: WireSchedule): PagerDutyNode {
  return {
    ref: `schedule:${wire.id}`, kind: "schedule", title: wire.name ?? wire.summary ?? wire.id,
    subtitle: wire.description || wire.time_zone || undefined,
  };
}

function incidentNode(wire: WireIncident): PagerDutyNode {
  const service = wire.service.summary ?? wire.service.id;
  return {
    ref: `incident:${wire.id}`, kind: "incident", title: wire.title,
    subtitle: `#${wire.incident_number} · ${service}`, badge: wire.status, meta: shortDate(wire.created_at),
    path: [{ ref: `service:${wire.service.id}`, kind: "service", title: service }],
  };
}

/** One listing a page can draw on: rows from `offset`, at most `limit`. */
type Source = (api: PagerDutyApi, offset: number, limit: number) => Promise<Page<PagerDutyNode>>;

const teams = (query: Query): Source => async (api, offset, limit) => {
  const page = await api.page<WireTeam>("/teams", "teams", query, offset, limit);
  return { ...page, items: page.items.map(teamNode) };
};
const services = (query: Query): Source => async (api, offset, limit) => {
  const page = await api.page<WireService>("/services", "services", { sort_by: "name", ...query }, offset, limit);
  return { ...page, items: page.items.map(serviceNode) };
};
const schedules = (query: Query): Source => async (api, offset, limit) => {
  const page = await api.page<WireSchedule>("/schedules", "schedules", query, offset, limit);
  return { ...page, items: page.items.map(scheduleNode) };
};
const incidents = (query: Query): Source => async (api, offset, limit) => {
  const page = await api.page<WireIncident>("/incidents", "incidents",
    { statuses: OPEN_STATUSES, sort_by: "created_at:desc", ...query }, offset, limit);
  return { ...page, items: page.items.map(incidentNode) };
};

/**
 * One page drawn from `sources` in turn: a cursor `<source>:<offset>` says where the last page
 * stopped, and the next source starts once one runs out.
 */
async function chain(api: PagerDutyApi, sources: readonly Source[], cursor: string | undefined): Promise<PagerDutyBrowsePage> {
  let [index, offset] = cursor === undefined ? [0, 0] : (cursor.split(":").map(Number) as [number, number]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset) || index < 0 || index >= sources.length || offset < 0) {
    throw new Error("That page has expired. Try again.");
  }
  const items: PagerDutyNode[] = [];
  while (index < sources.length && items.length < PAGE_SIZE) {
    const page = await sources[index]!(api, offset, Math.min(MAX_LIMIT, PAGE_SIZE - items.length));
    items.push(...page.items);
    offset += page.items.length;
    if (!page.more || page.items.length === 0) [index, offset] = [index + 1, 0];
  }
  return { items, ...(index < sources.length ? { nextCursor: `${index}:${offset}` } : {}) };
}

/** The PagerDuty configurator frame's capability. */
@validateRpc()
export class PagerDutyConfiguratorUI extends RpcTarget implements PagerDutyConfiguratorRpc {
  readonly #exports: Cloudflare.Exports;
  readonly #userObjectId: string;
  readonly #creds: CredentialSource<PublicGrant>;
  #identity?: Promise<Identity>;

  constructor(exports: Cloudflare.Exports, userObjectId: string) {
    super();
    this.#exports = exports;
    this.#userObjectId = userObjectId;
    this.#creds = accountSource(exports, userObjectId);
  }

  async getStatus(): Promise<PagerDutyConfiguratorStatus> {
    try {
      return { state: "ready", account: { ref: "account", host: new URL(webOrigin(await this.#me())).host } };
    } catch (error) {
      if (isCredentialsExpired(error)) return { state: "unavailable", message: RECONNECT_MESSAGE };
      throw error;
    }
  }

  async loadItems(request: PagerDutyBrowseRequest): Promise<PagerDutyBrowsePage> {
    const { parent, query, section, cursor } = request;
    if ([parent, query, section].filter(value => value !== undefined).length !== 1) {
      throw new Error("Ask for one listing at a time.");
    }
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH)) {
      throw new Error("That page has expired. Try again.");
    }
    if (query !== undefined) return await this.#search(query, cursor);
    if (parent !== undefined) {
      const ref = parseRef(parent);
      switch (ref.kind) {
        case "team": return await this.#chain([services({ team_ids: [ref.id] }), schedules({ team_ids: [ref.id] })], cursor);
        case "service": return await this.#chain([incidents({ service_ids: [ref.id] })], cursor);
        default: throw new Error("That can't be opened.");
      }
    }
    switch (section) {
      case "teams": return await this.#chain([teams({})], cursor);
      case "services": return await this.#chain([services({})], cursor);
      case "schedules": return await this.#chain([schedules({})], cursor);
      case "incidents": return await this.#chain([incidents({})], cursor);
      default: throw new Error("That can't be opened.");
    }
  }

  async locate(urlOrRef: string): Promise<PagerDutyNode | null> {
    if (typeof urlOrRef !== "string" || urlOrRef.length > 2048) return null;
    let ref: Ref;
    if (urlOrRef === "account" || REF.test(urlOrRef)) {
      ref = parseRef(urlOrRef);
    } else {
      const parsed = parseResourceUrl(urlOrRef);
      if (!parsed || !sameTenant(parsed, await this.#me())) return null;
      ref = parsed;
    }
    return await this.#node(ref);
  }

  async resourceUrlFor(ref: string): Promise<string> {
    const parsed = parseRef(ref);
    const me = await this.#me();
    if (parsed.kind === "account") return resourceUrl({ ...me, kind: "account" });
    const node = await this.#node(parsed);
    if (!node) throw new Error(GONE);
    // An incident looked up by number is bound by the ID PagerDuty gave it.
    return resourceUrl({ ...me, kind: parsed.kind, id: node.ref.slice(parsed.kind.length + 1) });
  }

  /** The connected user, read once per frame; a failure is forgotten so the next call asks again. */
  #me(): Promise<Identity> {
    const { UserAccount } = this.#exports;
    return this.#identity ??= UserAccount.get(UserAccount.idFromString(this.#userObjectId)).getIdentity()
      .catch(error => {
        this.#identity = undefined;
        throw error;
      });
  }

  async #read<T>(op: (api: PagerDutyApi) => Promise<T>): Promise<T> {
    const { region } = await this.#me();
    return await this.#creds.run(creds => op(new PagerDutyApi(creds.accessToken, region)), { replayable: true });
  }

  #chain(sources: readonly Source[], cursor: string | undefined): Promise<PagerDutyBrowsePage> {
    return this.#read(api => chain(api, sources, cursor));
  }

  /** The object a ref names, or null when this connection can't open it. */
  async #node(ref: Ref): Promise<PagerDutyNode | null> {
    if (ref.kind === "account") return { ref: "account", kind: "account", title: new URL(webOrigin(await this.#me())).host };
    try {
      const body = await this.#read(api => api.get<Record<string, unknown>>(`${LOOKUPS[ref.kind]}${ref.id}`));
      const wire = body[ref.kind];
      if (typeof wire !== "object" || wire === null) throw new Error(`PagerDuty's ${ref.kind} was malformed.`);
      switch (ref.kind) {
        case "team": return teamNode(wire as WireTeam);
        case "service": return serviceNode(wire as WireService);
        case "incident": return incidentNode(wire as WireIncident);
        case "schedule": return scheduleNode(wire as WireSchedule);
      }
    } catch (error) {
      if (isDenial(error)) return null;
      throw error;
    }
  }

  /**
   * Names across teams, services and schedules; a pasted link, or an ID or incident number, opens
   * what it names.
   */
  async #search(raw: string, cursor: string | undefined): Promise<PagerDutyBrowsePage> {
    const query = typeof raw === "string" ? raw.trim() : "";
    if (query.length === 0 || query.length > MAX_QUERY_LENGTH) throw new Error("Search for a name, or paste a PagerDuty link.");
    if (/^https?:\/\//i.test(query)) {
      const located = await this.locate(query);
      return located ? { items: [located] } : { items: [], notice: "This connection can't open that link." };
    }
    if (cursor === undefined && (OBJECT_ID.test(query) || INCIDENT_NUMBER.test(query))) {
      // An ID alone doesn't say what it names; a number is only ever an incident's.
      const kinds: ObjectKind[] = INCIDENT_NUMBER.test(query) ? ["incident"] : ["incident", "service", "team", "schedule"];
      const found = (await Promise.all(kinds.map(kind => this.#node({ kind, id: query })))).filter(node => node !== null);
      if (found.length > 0) return { items: found };
    }
    return await this.#chain([teams({ query }), services({ query }), schedules({ query })], cursor);
  }
}
