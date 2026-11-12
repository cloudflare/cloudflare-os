import {
  Field, h, HierarchyPicker, Notice, Section,
  type ConfiguratorUIHierarchyItem, type ConfiguratorUIHierarchyTab, type ConfiguratorUIRenderContext,
  type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  CreationLocationConfiguratorRpc, CreationLocationConfiguratorValues,
} from "./creation-location-configurator-types";
import type { DriveNode } from "./drive-configurator-types";

// Copies of what resources.ts and google-configurators.ts name, since this module is transpiled on
// its own and cannot import them; `__tests__/creation-location-configurator.test.ts` keeps them honest.
const FOLDER_PATTERN = "https://drive.google.com/drive/folders/:folderId";
const CREATED_FILES_GRANT = "https://drive.google.com/drive/created-files";
/** My Drive, by Drive's alias for its root: a new Doc, Sheet or Presentation lands there unmoved. */
const MY_DRIVE = "folder:root";

const icon = (d: string) => <svg viewBox="0 0 24 24" fill="currentColor"><path d={d} /></svg>;
/** Material's filled folder, which the shared drive mark cuts a person out of. */
const FOLDER = "M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h5.175q.4 0 .763.15t.637.425L12 6h8q.825 0 1.413.588T22 8v10q0 .825-.587 1.413T20 20z";
const ICONS = {
  folder: icon(FOLDER),
  "shared-drives": icon(FOLDER + "m7-3h8v-.55q0-1.125-1.1-1.787T15 14t-2.9.663T11 16.45zm5.413-4.587Q17 11.825 17 11t-.587-1.412T15 9t-1.412.588T13 11t.588 1.413T15 13t1.413-.587"),
  "shared-with-me": icon("M1 17.2q0-.85.438-1.562T2.6 14.55q1.55-.775 3.15-1.162T9 13t3.25.388t3.15 1.162q.725.375 1.163 1.088T17 17.2v.8q0 .825-.587 1.413T15 20H3q-.825 0-1.412-.587T1 18zM18.45 20q.275-.45.413-.962T19 18v-1q0-1.1-.612-2.113T16.65 13.15q1.275.15 2.4.513t2.1.887q.9.5 1.375 1.112T23 17v1q0 .825-.587 1.413T21 20zM6.175 10.825Q5 9.65 5 8t1.175-2.825T9 4t2.825 1.175T13 8t-1.175 2.825T9 12t-2.825-1.175m11.65 0Q16.65 12 15 12q-.275 0-.7-.062t-.7-.138q.675-.8 1.038-1.775T15 8t-.362-2.025T13.6 4.2q.35-.125.7-.163T15 4q1.65 0 2.825 1.175T19 8t-1.175 2.825"),
};

const HERE = { title: "In this folder" };
const TABS: ConfiguratorUIHierarchyTab[] = [
  { id: MY_DRIVE, title: "My Drive", icon: "folder", selectable: true, choice: HERE },
  { id: "shared-with-me", title: "Shared with me", icon: "shared-with-me" },
  { id: "shared-drives", title: "Shared drives", icon: "shared-drives" },
];

const CANNOT_ADD = "This account can't add files here.";

const placeable = (addable?: true) =>
  ({ selectable: addable === true, unselectableReason: addable ? undefined : CANNOT_ADD, choice: HERE });

const toItem = (node: DriveNode): ConfiguratorUIHierarchyItem => ({
  id: node.id,
  title: node.title,
  kind: node.kind === "sharedDrive" || node.listable ? "container" : "leaf",
  icon: node.kind === "sharedDrive" ? "shared-drives" : "folder",
  subtitle: node.detail,
  ...placeable(node.addable),
  path: node.path?.map(({ id, title, addable }) => ({ id, title, ...placeable(addable) })),
});

/**
 * Whether creating in `folder` needs CREATED_FILES_GRANT: a new folder does anywhere, and a file
 * outside My Drive. A host that does not say which type it creates (`accepted` absent) may be
 * creating a folder, so it is asked for there too.
 */
const needsGrant = (folder: string, accepted: readonly string[] | undefined) =>
  folder !== MY_DRIVE || accepted?.includes(FOLDER_PATTERN) !== false;

type Context = ConfiguratorUIRenderContext<CreationLocationConfiguratorRpc, CreationLocationConfiguratorValues>;
type Note = { text: string; tone?: "error" };

// Module state, as the runtime keeps none for a module.
/** Whether the account holds CREATED_FILES_GRANT, once asked or given. */
let canCreate: boolean | undefined;
let askedCanCreate = false;
/** The grant listing the location shown needs (shared drives'), while the picker shows it could not. */
let listingGrant: string | null = null;
/** Counts listings, so only the latest, the one for the location shown, sets `listingGrant`. */
let listings = 0;
/** What asking for each grant came to. */
const notes = new Map<string, Note>();

const checkCanCreate = ({ ui, setValues }: Context) => {
  if (askedCanCreate) return;
  askedCanCreate = true;
  void ui.hasCreationAccess().catch(() => false).then(held => {
    canCreate ??= held;
    setValues({});
  });
};

const ACCESS_POLL_MS = 2_000;
const ACCESS_WAIT_MS = 3 * 60_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Polls for CREATED_FILES_GRANT for up to ACCESS_WAIT_MS, setting `canCreate` once it is held:
 * Workshop reports only that Google's consent pop-up opened, not what was answered in it.
 */
const awaitCreationAccess = async (ui: Context["ui"]) => {
  for (const deadline = Date.now() + ACCESS_WAIT_MS; canCreate !== true && Date.now() < deadline;) {
    await sleep(ACCESS_POLL_MS);
    if (await ui.hasCreationAccess().catch(() => false)) canCreate = true;
  }
};

/**
 * Asks from the click, so the browser lets Workshop open Google's consent pop-up. CREATED_FILES_GRANT
 * is then waited for, so Approve unlocks once it is given, without asking again.
 */
const allow = async ({ ensureResources, setValues, ui }: Context, grant: string) => {
  const note = (text: string, tone?: "error") => {
    notes.set(grant, { text, tone });
    setValues({});
  };
  try {
    const held = await ensureResources([grant]);
    if (grant !== CREATED_FILES_GRANT) {
      return note(held ? "Access is allowed. Select Retry." : "Allow access in Google's window, then select Allow access again.");
    }
    if (held) canCreate = true;
    else {
      note("Allow access in Google's window.");
      await awaitCreationAccess(ui);
    }
    if (canCreate) setValues({});
    else note("Access wasn't allowed within 3 minutes. Select Allow access to try again.", "error");
  } catch (error) {
    note(error instanceof Error && error.message || "Access wasn't allowed.", "error");
  }
};

const grantNotice = (context: Context, grant: string, why: string) =>
  <Notice tone={notes.get(grant)?.tone} action={{ label: "Allow access", onClick: () => void allow(context, grant) }}>
    {notes.get(grant)?.text ?? why}
  </Notice>;

export default {
  initial: { folder: MY_DRIVE },
  isReady: ({ values: { folder }, acceptedResourceUrlPatterns: accepted }) =>
    typeof folder === "string" && (!needsGrant(folder, accepted) || canCreate === true),
  // `creationFolderId` in creation.ts reads this back with `parseResourceUrl`.
  resourceUrl: ({ values: { folder } }) => {
    if (!folder) throw new Error("Choose where to create it.");
    return FOLDER_PATTERN.replace(":folderId", encodeURIComponent(folder.slice(folder.indexOf(":") + 1)));
  },
  render(context) {
    const { values: { folder = null }, setValues, ui, acceptedResourceUrlPatterns: accepted } = context;
    return <Section>
      <Field label="Where to create it">
        <HierarchyPicker
          name="folder"
          value={folder}
          root={{ id: "drive", title: "Google Drive" }}
          tabs={TABS}
          loadItems={async ({ parentId, query, cursor }) => {
            checkCanCreate(context);
            const listing = ++listings;
            const page = await ui.listFolders(parentId, query, cursor);
            if (listing === listings && listingGrant !== (page.needsGrant ?? null)) {
              listingGrant = page.needsGrant ?? null;
              setValues({});
            }
            return page.needsGrant
              ? { items: [], unavailable: "Listing shared drives needs one more permission from Google. Allow it below, then select Retry." }
              : { items: page.nodes.map(toItem), nextCursor: page.nextCursor };
          }}
          onChange={next => setValues({ folder: next })}
          icons={ICONS}
          searchPlaceholder="Search all of Drive or paste a folder link…"
        />
      </Field>
      {listingGrant && grantNotice(context, listingGrant, "Google will ask to let this app \"View and download all " +
        "your Drive files\". It is used only to list your shared drives.")}
      {folder && needsGrant(folder, accepted) && canCreate === false && grantNotice(context, CREATED_FILES_GRANT,
        "Google will ask to let this app \"See, edit, create, and delete only the specific Google Drive files you " +
        "use with this app\". It is used only to put what you create where you choose.")}
    </Section>;
  },
} satisfies ConfiguratorUISpec<CreationLocationConfiguratorRpc, CreationLocationConfiguratorValues>;
