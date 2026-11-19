import {
  Autocomplete, Button, Field, h, HierarchyPicker, Section,
  type ConfiguratorUIHierarchyAncestor, type ConfiguratorUIHierarchyItem, type ConfiguratorUIRenderContext,
  type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  BigQueryConfiguratorRpc, BigQueryConfiguratorValues, BigQueryCrumb, BigQueryNode, BigQueryNodeKind, BigQueryNodePage,
} from "./bigquery-configurator-types";

// Must mirror `parseBigQueryUrl` in resources.ts, which is what actually mints the capability. This
// module is transpiled on its own and cannot import it, so `__tests__/configurator-url.test.ts` is
// what keeps the copies honest.
const HOST = "https://bigquery.googleapis.com";
const QUERY_PROJECT_PARAM = "queryProject";

/** The root's id, whose listing is the account's projects. Must equal the gatekeeper's. */
const ROOT_ID = "bigquery";

type Ref = { kind: BigQueryNodeKind; projectId: string; datasetId?: string; tableId?: string };

/** What a node id names, or undefined for an id of another shape. */
function refOf(id: string): Ref | undefined {
  const colon = id.indexOf(":");
  if (colon < 0) return undefined;
  const kind = id.slice(0, colon);
  const [projectId, datasetId, tableId, ...rest] = id.slice(colon + 1).split("/");
  if (!projectId || rest.length > 0) return undefined;
  if (kind === "project" && datasetId === undefined) return { kind, projectId };
  if (kind === "dataset" && datasetId && tableId === undefined) return { kind, projectId, datasetId };
  if (kind === "table" && datasetId && tableId) return { kind, projectId, datasetId, tableId };
  return undefined;
}

const idOf = ({ kind, projectId, datasetId, tableId }: Ref) =>
  `${kind}:${[projectId, datasetId, tableId].filter(Boolean).join("/")}`;

/** The id of the location a node is listed in. */
function parentOf(id: string): string | undefined {
  const ref = refOf(id);
  if (!ref) return undefined;
  if (ref.kind === "table") return idOf({ kind: "dataset", projectId: ref.projectId, datasetId: ref.datasetId });
  if (ref.kind === "dataset") return idOf({ kind: "project", projectId: ref.projectId });
  return ROOT_ID;
}

/** Material Symbols Outlined, as the Cloud console draws BigQuery's resources, on its 960-unit grid. */
const symbol = (d: string, fill = "currentColor") => <svg viewBox="0 -960 960 960" fill={fill}><path d={d} /></svg>;

const ICONS = {
  // BigQuery's product mark: a magnifier over bars, on Google Cloud's hexagon.
  bigquery: <svg viewBox="0 0 24 24">
    <path fill="#4285F4" d="M6.2 21.4 1.5 13.3a2.6 2.6 0 0 1 0-2.6l4.7-8.1A2.6 2.6 0 0 1 8.4 1.3h7.2a2.6 2.6 0 0 1 2.2 1.3l4.7 8.1a2.6 2.6 0 0 1 0 2.6l-4.7 8.1a2.6 2.6 0 0 1-2.2 1.3H8.4a2.6 2.6 0 0 1-2.2-1.3z" />
    <path fill="#669DF6" d="M22.5 10.7 17.8 2.6a2.6 2.6 0 0 0-2.2-1.3H12v21.4h3.6a2.6 2.6 0 0 0 2.2-1.3l4.7-8.1a2.6 2.6 0 0 0 0-2.6z" />
    <circle cx="11.2" cy="11.2" r="4.6" fill="none" stroke="#fff" stroke-width="1.7" />
    <path fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" d="m14.6 14.6 3 3" />
    <path fill="#fff" d="M9 10.6h1.2v2.6H9zm1.6-1.6h1.2v4.2h-1.2zm1.6 2.2h1.2v2h-1.2z" />
  </svg>,
  // In the theme's grey, as the console draws them: a dataset outlined, a table or view filled.
  project: symbol("M251-160q-88 0-149.5-61.5T40-371q0-78 50-137t127-71q20-97 94-158.5T482-799q112 0 189 81.5T748-522v24q72-2 122 46.5T920-329q0 69-50 119t-119 50H251Zm0-60h500q45 0 77-32t32-77q0-45-32-77t-77-32h-63v-84q0-91-61-154t-149-63q-88 0-149.5 63T267-522h-19q-62 0-105 43.5T100-371q0 63 44 107t107 44Zm229-260Z"),
  dataset: symbol("M290-290h140v-140H290v140Zm240 0h140v-140H530v140ZM290-530h140v-140H290v140Zm240 0h140v-140H530v140ZM180-120q-24 0-42-18t-18-42v-600q0-24 18-42t42-18h600q24 0 42 18t18 42v600q0 24-18 42t-42 18H180Zm0-60h600v-600H180v600Zm0-600v600-600Z"),
  table: symbol("M450-340H120v160q0 24.75 17.63 42.37Q155.25-120 180-120h270v-220Zm60 0v220h270q24.75 0 42.38-17.63Q840-155.25 840-180v-160H510Zm-60-60v-220H120v220h330Zm60 0h330v-220H510v220ZM120-680h720v-100q0-24.75-17.62-42.38Q804.75-840 780-840H180q-24.75 0-42.37 17.62Q120-804.75 120-780v100Z"),
  view: symbol("M300-80h230v-178H240v118q0 24.75 17.63 42.37Q275.25-80 300-80Zm290 0h230q24.75 0 42.38-17.63Q880-115.25 880-140v-118H590v178ZM80-244v-576q0-24 18-42t42-18h576v60H140v576H80Zm160-74h290v-178H240v178Zm350 0h290v-178H590v178ZM240-556h640v-104q0-24.75-17.62-42.38Q844.75-720 820-720H300q-24.75 0-42.37 17.62Q240-684.75 240-660v104Z"),
};

/** How a container is offered as a choice: a grant of it reaches what is added to it later. */
const CHOICES: Partial<Record<BigQueryNodeKind, { subtitle: string }>> = {
  project: { subtitle: "Every dataset and table in it, including ones added later" },
  dataset: { subtitle: "Every table in it, including ones added later" },
};

/** A project's badge when the account can't run query jobs in it, as when only datasets in it were shared. */
const SHARED = "Shared";

/**
 * Whether query jobs can run in each project seen, from the nodes listed or looked up, keyed by
 * project id. Module state, as the runtime keeps none for a module.
 */
const runsQueries = new Map<string, boolean>();

/**
 * Nodes looked up by id, for a location that then cannot be listed: a table shared on its own can be
 * fetched while its dataset's tables cannot, and the picker still has to show it where it lives.
 */
const lookedUp = new Map<string, ConfiguratorUIHierarchyItem>();

const toAncestor = ({ id, kind, title }: BigQueryCrumb): ConfiguratorUIHierarchyAncestor =>
  ({ id, title, icon: kind, selectable: true, choice: CHOICES[kind] });

function toItem(node: BigQueryNode): ConfiguratorUIHierarchyItem {
  const ref = refOf(node.id);
  if (ref) runsQueries.set(ref.projectId, node.runsQueries);
  return {
    id: node.id,
    title: node.title,
    kind: node.kind === "table" ? "leaf" : "container",
    icon: node.view ? "view" : node.kind,
    subtitle: node.subtitle,
    badge: node.kind === "project" && !node.runsQueries ? SHARED : undefined,
    selectable: true,
    choice: CHOICES[node.kind],
    path: node.path?.map(toAncestor),
  };
}

type Context = ConfiguratorUIRenderContext<BigQueryConfiguratorRpc, BigQueryConfiguratorValues>;

/** The project of the chosen node when query jobs cannot run in it, so its queries need another. */
function sharedProject(target: string | null | undefined): string | undefined {
  const ref = target ? refOf(target) : undefined;
  return ref && runsQueries.get(ref.projectId) === false ? ref.projectId : undefined;
}

/** The account's one project, offered as the query project before the user has to look for it. */
let onlyProject: Promise<string | null> | undefined;

/**
 * The query project's state, which belongs to the latest choice's data project: a choice within the
 * same project keeps it, as does a moment with nothing chosen (while the user opens a location or
 * searches), and a choice in another project starts over. Seeded from the URL.
 */
type Billing = {
  dataProject: string;
  /** The URL named a query project, which stands until dropped, though queries could run in `dataProject`. */
  override: boolean;
  /**
   * The field was filled in, by the URL or the user, or a suggestion was asked for, whatever it
   * answered. A suggestion is asked for only before that, so what the user is replacing is never
   * replaced for them.
   */
  asked: boolean;
  /** A suggestion is on its way: the field waits, disabled, so nothing typed meanwhile is overwritten. */
  suggesting: boolean;
};
let billing: Billing | null = null;

/** {@link billing} when `target` is in its data project, else undefined. */
function billingOf(target: string | null | undefined): Billing | undefined {
  const ref = target ? refOf(target) : undefined;
  return ref && billing?.dataProject === ref.projectId ? billing : undefined;
}

/** The data project of `target` while the URL's query project stands for it and queries could run there. */
function overriddenProject(target: string | null | undefined): string | undefined {
  const state = billingOf(target);
  return state?.override && sharedProject(target) === undefined ? state.dataProject : undefined;
}

/**
 * Fills in the account's one project, once, for a choice in a shared project whose field is still
 * untouched. The answer lands only while that data project's state stands.
 */
function suggestQueryProject({ ui, setValues }: Context, target: string): void {
  const state = billingOf(target);
  if (!state || state.asked || sharedProject(target) === undefined) return;
  state.asked = state.suggesting = true;
  onlyProject ??= ui.listProjects("").then(
    options => options.length === 1 ? options[0]!.value : null,
    () => { onlyProject = undefined; return null; });
  void onlyProject.then(project => {
    if (billing !== state) return;
    state.suggesting = false;
    setValues(project ? { queryProject: project } : {});
  });
}

/** Empties the field; for the URL's query project, queries then run in, and are billed to, the data project. */
function dropQueryProject({ setValues, clearFields }: Context): void {
  if (billing) billing.override = false;
  clearFields("queryProject");
  setValues({ queryProject: null });
}

export default {
  initial: { target: null, queryProject: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    if (!URL.canParse(resourceUrl)) return {};
    const url = new URL(resourceUrl);
    const [projectId, datasetId, tableId] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (!projectId) return {};
    const kind = tableId ? "table" : datasetId ? "dataset" : "project";
    const queryProject = url.searchParams.get(QUERY_PROJECT_PARAM);
    const target = idOf({ kind, projectId, datasetId, tableId });
    const prefilled = queryProject && queryProject !== projectId ? queryProject : null;
    // Recorded now, not when the lookup answers, so a choice made before then keeps it too.
    billing = { dataProject: projectId, override: prefilled !== null, asked: prefilled !== null, suggesting: false };
    return { target, queryProject: prefilled };
  },

  isReady({ values: { target, queryProject } }) {
    const ref = target ? refOf(target) : undefined;
    if (!ref) return false;
    // Until the picker's lookup of a pre-filled choice says whether queries can run in its project,
    // the form is not ready: a connection made before then might not be able to query.
    const runs = runsQueries.get(ref.projectId);
    if (runs === undefined) return false;
    // A query project is needed where queries can't run, and where the URL's one stands, until it is
    // replaced or dropped: typing over it bills nothing new.
    const chosen = typeof queryProject === "string" && queryProject.length > 0;
    return chosen || (runs && overriddenProject(target) === undefined);
  },

  resourceUrl({ values: { target, queryProject } }) {
    const ref = target ? refOf(target) : undefined;
    if (!ref) throw new Error("Choose what to connect.");
    const path = [ref.projectId, ref.datasetId, ref.tableId]
      .filter((segment): segment is string => segment !== undefined)
      .map(encodeURIComponent)
      .join("/");
    // A project alone keeps a trailing slash, which the `/:projectId/*` pattern needs to match.
    const url = new URL(`${HOST}/${path}${ref.kind === "project" ? "/" : ""}`);
    if (queryProject && queryProject !== ref.projectId) url.searchParams.set(QUERY_PROJECT_PARAM, queryProject);
    return url.toString();
  },

  render(context) {
    const { values: { target = null, queryProject = null }, setValues, clearFields, ui } = context;
    const shared = sharedProject(target);
    const override = overriddenProject(target);
    return <Section>
      <Field label="What to connect">
        <HierarchyPicker
          name="target"
          value={target}
          root={{ id: ROOT_ID, title: "BigQuery", subtitle: "The projects you have a role in", icon: "bigquery", selectable: false }}
          loadItems={async ({ parentId, query, cursor }) => {
            let page: BigQueryNodePage;
            try {
              page = await ui.listNodes(parentId, query, cursor);
            } catch (error) {
              const shared = query === "" && cursor === null
                ? [...lookedUp.values()].filter(item => parentOf(item.id) === parentId)
                : [];
              if (shared.length === 0) throw error;
              return { items: shared, notice: "Only what was shared with you is shown; the rest of this location can't be listed." };
            }
            return { items: page.nodes.map(toItem), notice: page.notice, nextCursor: page.nextCursor };
          }}
          loadItem={async id => {
            const node = await ui.getNode(id);
            if (!node) return null;
            const known = runsQueries.has(refOf(id)?.projectId ?? "");
            const item = toItem(node);
            lookedUp.set(id, item);
            // Whether a pre-filled choice can be connected is known only now, which matters only while
            // the choice is still in its data project.
            if (!known && billingOf(id)) {
              setValues({});
              suggestQueryProject(context, id);
            }
            return item;
          }}
          onChange={next => {
            // Opening a location or searching lets go of the choice; the query project waits for the next.
            if (next === null) {
              setValues({ target: null });
              return;
            }
            if (billingOf(next)) {
              setValues({ target: next });
            } else {
              const ref = refOf(next);
              billing = ref ? { dataProject: ref.projectId, override: false, asked: false, suggesting: false } : null;
              clearFields("queryProject");
              setValues({ target: next, queryProject: null });
            }
            // Also within the project, which a search result can say is shared before a lookup does.
            suggestQueryProject(context, next);
          }}
          icons={ICONS}
          searchPlaceholder="Search here, or paste a link or project ID"
        />
      </Field>
      {(shared !== undefined || override !== undefined) && <Field
        label="Run queries in"
        description={shared !== undefined
          ? `This account can't run query jobs in "${shared}", so its queries run in, and are billed to, a project of yours. They still read only what is chosen above.`
          : `Queries run in, and are billed to, the project picked here rather than "${override}".`}
      >
        <Autocomplete
          name="queryProject"
          value={queryProject}
          placeholder="Search your projects..."
          loadOptions={query => ui.listProjects(query)}
          onChange={next => {
            if (billing) billing.asked = true;
            setValues({ queryProject: next });
          }}
          disabled={billingOf(target)?.suggesting === true}
          optional={override !== undefined}
          onClear={() => dropQueryProject(context)}
        />
      </Field>}
      {/* Clear shows only while a project is picked, and Tab skips it, so dropping the override has its own control. */}
      {override !== undefined && <div>
        <Button variant="secondary" onClick={() => dropQueryProject(context)}>{`Run queries in "${override}"`}</Button>
      </div>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<BigQueryConfiguratorRpc, BigQueryConfiguratorValues>;
