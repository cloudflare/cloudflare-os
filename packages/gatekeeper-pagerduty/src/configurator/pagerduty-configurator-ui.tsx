import {
  Field, h, HierarchyPicker, Notice, Section,
  type ConfiguratorUIHierarchyAncestor as Ancestor, type ConfiguratorUIHierarchyItem as Item,
  type ConfiguratorUIHierarchyPage as Page, type ConfiguratorUIHierarchyRequest as PickerRequest,
  type ConfiguratorUIHierarchyTab as Tab, type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type { RpcStub } from "capnweb";
import type {
  PagerDutyBrowseRequest as Request,
  PagerDutyConfiguratorRpc,
  PagerDutyConfiguratorStatus as Status,
  PagerDutyConfiguratorValues as Values,
  PagerDutyNode as Node,
  PagerDutyNodeKind as Kind,
  PagerDutySection,
} from "./pagerduty-configurator-types";

/** The gatekeeper as the frame holds it: a Cap'n Web stub. */
type Rpc = RpcStub<PagerDutyConfiguratorRpc>;

const HOST = "https://:subdomain{.eu}?.pagerduty.com";
const object = (path: string, group: string) => `${HOST}/${path}/:${group}([A-Z0-9]+){/*}?`;

/**
 * What each kind binds and how a refusal names it. Each pattern must equal its kind's urlPattern in
 * RESOURCES (pagerduty-env.ts); __tests__/configurator.test.ts keeps the copies in step.
 */
const KINDS: Record<Kind, { pattern: string; noun: string }> = {
  account: { pattern: `${HOST}/`, noun: "the whole account" },
  team: { pattern: object("teams", "teamId"), noun: "a team" },
  service: { pattern: object("service-directory", "serviceId"), noun: "a service" },
  incident: { pattern: object("incidents", "incidentId"), noun: "an incident" },
  schedule: { pattern: object("schedules", "scheduleId"), noun: "a schedule" },
};

const FIELD_LABEL = "What to connect";
const SEARCH_PLACEHOLDER = "Search names, or paste a PagerDuty link or ID";
const ROOT_SUBTITLE = "Every team, service, schedule and incident you can see";

type Context = ConfiguratorUIRenderContext<Rpc, Values>;
type Connection = { state: "loading" } | { state: "failed"; message: string } | Status;
type ObjectKind = Exclude<Kind, "account">;

const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

// -- the connection -----------------------------------------------------------------------------

let connection: Connection = { state: "loading" };
let asked = false;
/** A pre-filled resource URL the picker couldn't open: one this connection can't, or whose lookup failed. */
let missing: { url: string; failed?: string } | null = null;
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
    connection = { state: "failed", message: errorMessage(error, "Couldn't reach PagerDuty.") };
    rerender();
  });
}

// -- what a choice is ---------------------------------------------------------------------------

/** Whether the Workshop takes what `kind` binds. An older Workshop does not say, and takes any. */
const accepts = (accepted: readonly string[] | undefined, kind: Kind) => accepted === undefined || accepted.includes(KINDS[kind].pattern);

/** Why a node of `kind` can't be chosen here, or undefined when it can. */
function refusal(accepted: readonly string[] | undefined, kind: Kind): string | undefined {
  if (accepts(accepted, kind)) return undefined;
  const nouns = (accepted ?? []).flatMap(pattern => Object.values(KINDS).find(kind => kind.pattern === pattern)?.noun ?? []);
  return nouns.length > 0 ? `This connection needs ${nouns.join(" or ")}.` : "This can't be connected here.";
}

/** The second line of an open container's own row: what choosing it covers. */
const COVERS: Partial<Record<Kind, string>> = {
  team: "Its services and their incidents, its schedules and members",
  service: "This service and its incidents, including new ones",
};

// -- icons --------------------------------------------------------------------------------------

const ICON_PATHS: Record<ObjectKind | "account", string> = {
  // The PagerDuty mark, as the Workshop draws the vendor (src/pagerduty-logo.svg).
  account: "M5 3h3.4C10.7 3 12 4.3 12 6.4S10.7 9.8 8.4 9.8H7V13H5zm2 1.8v3.2h1.3c1.1 0 1.7-.6 1.7-1.6S9.4 4.8 8.3 4.8z",
  team: "M5.5 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5m0 1.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2M11 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4m0 1.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1M1 13c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4v1H8.5v-1c0-1.3-1.3-2.5-3-2.5s-3 1.2-3 2.5v1H1zm10.5-3.9c2 .2 3.5 1.7 3.5 3.6V14h-1.5v-1.3c0-1-.8-1.9-2-2.1z",
  service: "M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zm1.5.5v2h9v-2zM2 10a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zm1.5.5v2h9v-2zM4.5 4h1v1h-1zm0 7h1v1h-1z",
  incident: "M8 1a.75.75 0 0 1 .66.4l6.5 12a.75.75 0 0 1-.66 1.1h-13a.75.75 0 0 1-.66-1.1l6.5-12A.75.75 0 0 1 8 1m0 2.3L2.76 13h10.48zM7.25 6h1.5v3.5h-1.5zm0 4.5h1.5V12h-1.5z",
  schedule: "M5 1h1.5v1.5h3V1H11v1.5h2a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h2zM3.5 6v7.5h9V6zM5 7.5h2V9.5H5zm4 0h2V9.5H9z",
};

const glyph = (kind: keyof typeof ICON_PATHS) => <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
  <path d={ICON_PATHS[kind]} fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" />
</svg>;

/** A glyph on its kind's tint, filling the tile the picker draws behind a node's icon. */
const tinted = (kind: keyof typeof ICON_PATHS) => <span className={`pd-icon pd-${kind}`}>{glyph(kind)}</span>;

const ICONS: Record<string, unknown> = {
  account: tinted("account"),
  team: tinted("team"),
  service: tinted("service"),
  incident: tinted("incident"),
  schedule: tinted("schedule"),
  teams: glyph("team"),
  services: glyph("service"),
  schedules: glyph("schedule"),
  incidents: glyph("incident"),
};

// -- the picker's nodes -------------------------------------------------------------------------

const TABS: Tab[] = [
  { id: "teams", title: "Teams", icon: "teams" },
  { id: "services", title: "Services", icon: "services" },
  { id: "schedules", title: "Schedules", icon: "schedules" },
  { id: "incidents", title: "Open incidents", icon: "incidents" },
];
const SECTIONS = new Set<string>(TABS.map(tab => tab.id));
/** What an empty tab says, in place of the picker's "Nothing here." */
const EMPTY_TAB: Partial<Record<PagerDutySection, string>> = { incidents: "No incident is open right now." };
/** The tab each kind of node lives in; an incident lives under its service. */
const HOME_TAB: Record<ObjectKind, Ancestor> = {
  team: { id: "teams", title: "Teams", selectable: false },
  service: { id: "services", title: "Services", selectable: false },
  incident: { id: "services", title: "Services", selectable: false },
  schedule: { id: "schedules", title: "Schedules", selectable: false },
};

/** What a ref chooses: `account`, or the kind before its `:`, so a breadcrumb's ref says it too. */
const valuesOf = (ref: string): Values => ({ ref, kind: ref === "account" ? "account" : ref.slice(0, ref.indexOf(":")) as Kind });

const isContainer = (kind: Kind) => kind === "team" || kind === "service";

function toAncestor({ ref, kind, title }: Pick<Node, "ref" | "kind" | "title">, accepted: readonly string[] | undefined): Ancestor {
  const reason = refusal(accepted, kind);
  return { id: ref, title, icon: kind, selectable: reason === undefined, unselectableReason: reason, choice: { title: `All of ${title}`, subtitle: COVERS[kind] } };
}

/** A node as the picker lists it; a located one (a search result, a pre-fill) says where it lives. */
function toItem(node: Node, accepted: readonly string[] | undefined, located = false): Item {
  const reason = refusal(accepted, node.kind);
  const container = isContainer(node.kind);
  return {
    id: node.ref,
    title: node.title,
    kind: container ? "container" : "leaf",
    icon: node.kind,
    subtitle: node.subtitle,
    badge: node.badge,
    meta: node.meta,
    selectable: reason === undefined,
    unselectableReason: reason,
    choice: container ? { title: `All of ${node.title}`, subtitle: COVERS[node.kind] } : undefined,
    path: located && node.kind !== "account"
      ? [HOME_TAB[node.kind], ...(node.path ?? []).map(crumb => toAncestor(crumb, accepted))]
      : undefined,
  };
}

async function loadPage({ ui, acceptedResourceUrlPatterns: accepted }: Context, { parentId, query, cursor }: PickerRequest): Promise<Page> {
  const request: Request = query ? { query } : SECTIONS.has(parentId) ? { section: parentId as PagerDutySection } : { parent: parentId };
  if (cursor) request.cursor = cursor;
  const page = await ui.loadItems(request);
  // A link to the account names the choice above the tabs, which the picker doesn't list again.
  if (query && page.items.some(node => node.kind === "account")) {
    return { items: [], nextCursor: null, notice: refusal(accepted, "account") ?? "That link is to the whole account. Choose it above the tabs." };
  }
  return {
    items: page.items.map(node => toItem(node, accepted, Boolean(query))),
    nextCursor: page.nextCursor ?? null,
    notice: page.notice ?? (page.items.length === 0 && !cursor && request.section ? EMPTY_TAB[request.section] : undefined),
  };
}

/** The node a value names, with where it lives, from what was searched for or else from PagerDuty. */
async function loadNode({ ui, acceptedResourceUrlPatterns: accepted }: Context, ref: string): Promise<Item | null> {
  const node = await ui.locate(ref);
  return node && toItem(node, accepted, true);
}

const NOTHING: Values = { ref: null, kind: null };

// -- rendering ----------------------------------------------------------------------------------

function picker(context: Context, host: string) {
  const { values, setValues, acceptedResourceUrlPatterns: accepted } = context;
  return <Field label={FIELD_LABEL}>
    <HierarchyPicker
      name="ref"
      value={values.ref ?? null}
      root={{ id: "account", title: host, subtitle: ROOT_SUBTITLE, icon: "account", selectable: accepts(accepted, "account") }}
      tabs={TABS}
      icons={ICONS}
      searchPlaceholder={SEARCH_PLACEHOLDER}
      loadItems={request => loadPage(context, request)}
      loadItem={ref => loadNode(context, ref)}
      onChange={next => {
        if (next === null) {
          setValues(NOTHING);
          return;
        }
        missing = null;
        setValues(valuesOf(next));
      }}
    />
  </Field>;
}

/** The picker as it will be, waiting on the connection, so the form doesn't move once it is known. */
function placeholder({ acceptedResourceUrlPatterns: accepted }: Context) {
  return <Field label={FIELD_LABEL}>
    <HierarchyPicker
      name="ref"
      value={null}
      root={{ id: "loading", title: "PagerDuty", subtitle: ROOT_SUBTITLE, icon: "account", selectable: accepts(accepted, "account") }}
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
    return <Notice>{`Couldn't find ${url} in the PagerDuty account this connection can open. Choose what to connect.`}</Notice>;
  }
  return <Notice tone="error" action={{
    label: "Try again",
    onClick: () => {
      ui.locate(url).then(located => {
        // A choice made while the lookup ran (which cleared `missing`) stands; the late answer is dropped.
        if (missing !== attempt) return;
        if (located === null) {
          missing = { url };
          rerender();
          return;
        }
        missing = null;
        setValues(valuesOf(located.ref));
      }, error => {
        if (missing !== attempt) return;
        missing = { url, failed: errorMessage(error, "Couldn't reach PagerDuty.") };
        rerender();
      });
    },
  }}>{`Couldn't look up ${url}. ${failed}`}</Notice>;
}

function notices(context: Context) {
  if (connection.state !== "failed" && connection.state !== "unavailable") return null;
  return <Notice tone="error" action={connection.state === "failed" ? {
    label: "Try again",
    onClick: () => {
      asked = false;
      connection = { state: "loading" };
      loadStatus(context);
      rerender();
    },
  } : undefined}>{connection.message}</Notice>;
}

// Each kind's tint for the icon tiles, on the runtime's tokens, so they follow the host's light and
// dark themes as the other pickers' icons do.
const STYLE = `
.pd-icon {
  --pd-tint: var(--text-color-kumo-subtle);
  display: flex; width: 100%; height: 100%; align-items: center; justify-content: center;
  color: var(--pd-tint); background: color-mix(in oklab, var(--pd-tint) 11%, var(--color-kumo-base));
}
.pd-icon svg { width: 16px; height: 16px; }
.pd-account { color: #fff; background: #06ac38; }
.pd-team { --pd-tint: oklch(53% 0.19 300); }
.pd-service { --pd-tint: oklch(54% 0.17 258); }
.pd-incident { --pd-tint: oklch(58% 0.2 28); }
.pd-schedule { --pd-tint: oklch(53% 0.13 152); }
@media (prefers-color-scheme: dark) {
  .pd-team { --pd-tint: oklch(74% 0.13 300); }
  .pd-service { --pd-tint: oklch(74% 0.13 258); }
  .pd-incident { --pd-tint: oklch(74% 0.15 28); }
  .pd-schedule { --pd-tint: oklch(74% 0.13 152); }
}
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
      missing = { url: resourceUrl, failed: errorMessage(error, "Couldn't reach PagerDuty.") };
      return {};
    }
    if (located === null) {
      // Never a fallback to the whole account: that would bind everything with one click, in place of what was asked for.
      missing = { url: resourceUrl };
      return {};
    }
    return valuesOf(located.ref);
  },

  resourceUrl({ values, ui }) {
    if (!values.ref) throw new Error("Choose what to connect.");
    return ui.resourceUrlFor(values.ref);
  },

  render(context) {
    rerender = () => context.setValues({});
    loadStatus(context);
    const failure = notices(context);
    if (failure) return <Section>{failure}</Section>;
    return <Section>
      <style>{STYLE}</style>
      {missing !== null && !context.values.ref ? prefillNotice(context, missing) : null}
      {connection.state === "ready" ? picker(context, connection.account.host) : placeholder(context)}
    </Section>;
  },
} satisfies ConfiguratorUISpec<Rpc, Values>;
