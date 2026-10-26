import {
  Button, Field, Fragment, h, HierarchyPicker, Notice, Section,
  type ConfiguratorUIHierarchyAncestor, type ConfiguratorUIHierarchyItem,
  type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  DriveConfiguratorRpc, DriveConfiguratorValues, DriveNode, DriveNodeAncestor,
} from "./drive-configurator-types";

// Must mirror `parseDriveUrl` in resources.ts, which is what actually mints the capability. This
// module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
// .test.ts` is what keeps the copies honest.
const ACCOUNT_PATTERN = "https://drive.google.com/drive/my-drive";
const FOLDER_PATTERN = "https://drive.google.com/drive/folders/:folderId";
const FILE_PATTERN = "https://drive.google.com/file/d/:fileId/view";

/** The whole account's node, the picker's root. */
const ROOT_ID = "drive";

/** The resource type a node binds, or undefined for a grouping, which binds nothing. */
const patternOf = (id: string): string | undefined =>
  id === ROOT_ID ? ACCOUNT_PATTERN
  : id.startsWith("folder:") ? FOLDER_PATTERN
  : id.startsWith("file:") ? FILE_PATTERN
  : undefined;

/** Whether the Workshop accepts the type a node binds. An older Workshop does not say, and takes any. */
const accepts = (accepted: readonly string[] | undefined, id: string): boolean => {
  const pattern = patternOf(id);
  return pattern !== undefined && (accepted === undefined || accepted.includes(pattern));
};

const fileIdOf = (id: string) => id.slice(id.indexOf(":") + 1);

const icon = (d: string, fill = "currentColor") => <svg viewBox="0 0 24 24" fill={fill}><path d={d} /></svg>;

/** One of Drive's file marks: a rounded square in the file type's colour, its marks stroked white. */
const tile = (fill: string, marks: unknown) => <svg viewBox="0 0 24 24">
  <rect x="3" y="3" width="18" height="18" rx="2.5" fill={fill} />
  <g fill="none" stroke="#fff" stroke-width="1.5">{marks}</g>
</svg>;

/** Material's filled folder, which the shared drive mark cuts a person out of. */
const FOLDER = "M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h5.175q.4 0 .763.15t.637.425L12 6h8q.825 0 1.413.588T22 8v10q0 .825-.587 1.413T20 20z";

// Drawn as Drive draws them: its 2025 logo (from svg-logos), its file marks, and Material Symbols
// Rounded for the rest, in Google's colours. Folders keep the theme's grey.
const ICONS = {
  drive: <svg viewBox="0 0 256 238">
    <defs>
      <linearGradient id="drive-logo-yellow" x1="86.924%" x2="7.63%" y1="94.294%" y2="45.952%">
        <stop offset="9%" stop-color="#FFE921" /><stop offset="100%" stop-color="#FEC700" />
      </linearGradient>
      <linearGradient id="drive-logo-blue" x1="99.538%" x2="23.437%" y1="93.901%" y2="54.033%">
        <stop offset="15%" stop-color="#A9A8FF" /><stop offset="33%" stop-color="#6D97FF" /><stop offset="48%" stop-color="#3186FF" />
      </linearGradient>
      <linearGradient id="drive-logo-green" x1="87.128%" x2="-.639%" y1="51.518%" y2="93.078%">
        <stop offset="55%" stop-color="#0EBC5F" /><stop offset="85%" stop-color="#78C9FF" />
      </linearGradient>
      <clipPath id="drive-logo">
        <path d="M77.303 29.27c22.531-39.026 78.863-39.027 101.394 0l69.373 120.158c22.531 39.027-5.633 87.81-50.698 87.81H58.628c-45.065 0-73.23-48.783-50.698-87.81z" />
      </clipPath>
    </defs>
    <g clip-path="url(#drive-logo)">
      <path fill="url(#drive-logo-yellow)" d="M298.849 237.267H157.296l-29.293-50.735 70.777-122.589z" />
      <path fill="url(#drive-logo-blue)" d="M-42.87 237.246l100.069-173.325-29.282 50.726h58.57l70.783 122.596-200.138.001z" />
      <path fill="url(#drive-logo-green)" d="M128.011-58.67l70.781 122.6-29.286 50.726H27.942z" />
    </g>
  </svg>,
  folder: icon(FOLDER),
  "shared-drives": icon(FOLDER + "m7-3h8v-.55q0-1.125-1.1-1.787T15 14t-2.9.663T11 16.45zm5.413-4.587Q17 11.825 17 11t-.587-1.412T15 9t-1.412.588T13 11t.588 1.413T15 13t1.413-.587"),
  "shared-with-me": icon("M1 17.2q0-.85.438-1.562T2.6 14.55q1.55-.775 3.15-1.162T9 13t3.25.388t3.15 1.162q.725.375 1.163 1.088T17 17.2v.8q0 .825-.587 1.413T15 20H3q-.825 0-1.412-.587T1 18zM18.45 20q.275-.45.413-.962T19 18v-1q0-1.1-.612-2.113T16.65 13.15q1.275.15 2.4.513t2.1.887q.9.5 1.375 1.112T23 17v1q0 .825-.587 1.413T21 20zM6.175 10.825Q5 9.65 5 8t1.175-2.825T9 4t2.825 1.175T13 8t-1.175 2.825T9 12t-2.825-1.175m11.65 0Q16.65 12 15 12q-.275 0-.7-.062t-.7-.138q.675-.8 1.038-1.775T15 8t-.362-2.025T13.6 4.2q.35-.125.7-.163T15 4q1.65 0 2.825 1.175T19 8t-1.175 2.825"),
  doc: tile("#008EFA", <path stroke-width="2" stroke-linecap="round" d="M8 12h8M8 15.8h4" />),
  sheet: tile("#00AC5E", <path d="M5.25 9.2h12.4M9.2 5.25v12.4" />),
  slides: tile("#FFC335", <rect x="5.75" y="8" width="12.5" height="8" />),
  markdown: tile("#4285F4", <path fill="#fff" stroke="none" d="M6.1 9.2H12v6.2h-1.4v-4.5H9.75v2.8h-1.4v-2.8H7.5v4.5H6.1zm9 0h1.4v2.5h2.25l-2.95 3.4-2.95-3.4h2.25z" />),
  code: tile("#B3251E", <path stroke-width="1.3" d="M9 7.85 5 11.85l4 4m6-8 4 4-4 4" />),
  csv: tile("#00AF57", <text fill="#fff" stroke="none" x="12" y="15.1" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="8.7" textLength="14.6" lengthAdjust="spacingAndGlyphs">CSV</text>),
  text: <svg viewBox="0 0 24 24">
    <path fill="#3186FF" d="M6.7 3h6.4l6.2 6.2V19a2 2 0 0 1-2 2H6.7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path fill="#fff" d="M13 5v3.9h3.9z" />
    <path fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" d="M8.2 12.7h7.6M8.2 16.65h3.9" />
  </svg>,
  video: <svg viewBox="0 0 24 24">
    <rect x="3" y="4.7" width="18" height="14.6" rx="2.5" fill="#FC413D" />
    <path fill="#FFE3E2" d="M4.5 5h2.15l1.83 3.35H5.96zm4.97 0h2.53l1.83 3.35h-2.53zm5.48 0h2.53l1.83 3.35h-2.53z" />
  </svg>,
  pdf: icon("M10 10.5h1q.425 0 .713-.288T12 9.5v-1q0-.425-.288-.712T11 7.5H9.5q-.2 0-.35.15T9 8v4q0 .2.15.35t.35.15t.35-.15T10 12zm0-1v-1h1v1zm5 3q.425 0 .713-.288T16 11.5v-3q0-.425-.288-.712T15 7.5h-1.5q-.2 0-.35.15T13 8v4q0 .2.15.35t.35.15zm-1-1v-3h1v3zm4-1h.5q.2 0 .35-.15T19 10t-.15-.35t-.35-.15H18v-1h.5q.2 0 .35-.15T19 8t-.15-.35t-.35-.15h-1q-.2 0-.35.15T17 8v4q0 .2.15.35t.35.15t.35-.15T18 12zM8 18q-.825 0-1.412-.587T6 16V4q0-.825.588-1.412T8 2h12q.825 0 1.413.588T22 4v12q0 .825-.587 1.413T20 18zm-4 4q-.825 0-1.412-.587T2 20V7q0-.425.288-.712T3 6t.713.288T4 7v13h13q.425 0 .713.288T18 21t-.288.713T17 22z", "#EA4335"),
  image: icon("M5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21zm2-4h10q.3 0 .45-.275t-.05-.525l-2.75-3.675q-.15-.2-.4-.2t-.4.2L11.25 16L9.4 13.525q-.15-.2-.4-.2t-.4.2l-2 2.675q-.2.25-.05.525T7 17", "#EA4335"),
};

const FILE_ICONS: Record<string, keyof typeof ICONS> = {
  "application/vnd.google-apps.document": "doc",
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.presentation": "slides",
  "application/pdf": "pdf",
  "application/json": "code",
  "application/javascript": "code",
  "application/xml": "text",
  "text/plain": "text",
  "text/rtf": "text",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/csv": "csv",
};

/** By the part of a MIME type before the slash, as Drive draws any other text file as code. */
const MEDIA_ICONS: Record<string, keyof typeof ICONS> = { image: "image", video: "video", text: "code" };

const iconOf = (node: DriveNode): keyof typeof ICONS | undefined => {
  switch (node.kind) {
    case "group": return node.id === "shared-with-me" ? "shared-with-me" : "shared-drives";
    case "sharedDrive": return "shared-drives";
    case "folder": return "folder";
    default: {
      const mimeType = node.mimeType ?? "";
      return FILE_ICONS[mimeType] ?? MEDIA_ICONS[mimeType.split("/")[0]];
    }
  }
};

const modified = (value: string | undefined): string | undefined => {
  const date = value === undefined ? undefined : new Date(value);
  return date && !Number.isNaN(date.getTime())
    ? `Modified ${date.toLocaleDateString(undefined, { dateStyle: "medium" })}`
    : undefined;
};

// A folder or shared drive grant reaches everything in it, checked again on every read.
const CONTAINER_CHOICE = { subtitle: "All of its contents, including anything added later" };

/** As for {@link toItem}: a folder on the path whose children this account cannot list is only seen. */
const toAncestor = (
  { id, title, listable }: DriveNodeAncestor,
  accepted: readonly string[] | undefined,
): ConfiguratorUIHierarchyAncestor =>
  ({ id, title, selectable: listable === true && accepts(accepted, id), choice: CONTAINER_CHOICE });

/** A folder whose children this account cannot list cannot be opened or bound, only seen. */
const toItem = (node: DriveNode, accepted: readonly string[] | undefined): ConfiguratorUIHierarchyItem => {
  const container = node.kind !== "file" && (node.kind !== "folder" || node.listable === true);
  return {
    id: node.id,
    title: node.title,
    kind: container ? "container" : "leaf",
    icon: iconOf(node),
    subtitle: [modified(node.modifiedTime), node.detail].filter(Boolean).join(" · ") || undefined,
    selectable: (container || node.kind === "file") && accepts(accepted, node.id),
    choice: container ? CONTAINER_CHOICE : undefined,
    path: node.path?.map(ancestor => toAncestor(ancestor, accepted)),
  };
};

type Context = ConfiguratorUIRenderContext<DriveConfiguratorRpc, DriveConfiguratorValues>;
type Note = { text: string; tone?: "error" };

/**
 * The grant a location needs that the account lacks (shared drives), while the picker shows that it
 * could not list it, and what asking for the grant came to. Module state, as the runtime keeps none
 * for a module.
 */
let access: { grant: string; note?: Note } | null = null;

/**
 * Counts listing requests. The picker drops a reply for a location it has left only after
 * `loadItems` returns, so only the latest request, the one for the location shown, sets `access`.
 */
let listings = 0;

/** Asks from the click, so the browser lets Workshop open Google's consent pop-up. */
const allow = async ({ ensureResources, setValues }: Context, grant: string) => {
  const note = await ensureResources([grant]).then(
    (held): Note => ({ text: held ? "Access is allowed. Select Retry." : "Allow access in Google's window, then select Retry." }),
    (error: unknown): Note => ({
      text: error instanceof Error && error.message ? error.message : "Access wasn't allowed.",
      tone: "error",
    }));
  if (access?.grant !== grant) return;
  access = { grant, note };
  setValues({});
};

export default {
  initial: { target: null },
  initialValuesFromResourceUrl: ({ resourceUrl }) => {
    const { pathname } = new URL(resourceUrl);
    if (/^\/drive\/my-drive\/?$/.test(pathname)) return { target: ROOT_ID };
    const folder = /^\/drive\/folders\/([^/]+)\/?$/.exec(pathname);
    if (folder) return { target: `folder:${decodeURIComponent(folder[1])}` };
    const file = /^\/file\/d\/([^/]+)\/view\/?$/.exec(pathname);
    if (file) return { target: `file:${decodeURIComponent(file[1])}` };
    return {};
  },
  isReady: ({ values: { target }, acceptedResourceUrlPatterns }) =>
    typeof target === "string" && accepts(acceptedResourceUrlPatterns, target),
  resourceUrl: ({ values: { target } }) => {
    const pattern = target ? patternOf(target) : undefined;
    if (!target || !pattern) throw new Error("Choose what to connect.");
    return pattern.replace(/:\w+Id\b/, () => encodeURIComponent(fileIdOf(target)));
  },
  render(context) {
    const { values: { target = null }, setValues, ui, acceptedResourceUrlPatterns: accepted } = context;
    const pending = access;
    return <Section>
      <Field label="What to connect">
        <HierarchyPicker
          name="target"
          value={target}
          root={{
            id: ROOT_ID,
            title: "Google Drive",
            subtitle: "My Drive, shared drives, and files shared with you",
            icon: "drive",
            selectable: accepts(accepted, ROOT_ID),
          }}
          loadItems={async ({ parentId, query, cursor }) => {
            const listing = ++listings;
            const page = await ui.listDriveNodes(parentId, query, cursor);
            if (listing === listings && (access || page.needsGrant)) {
              access = page.needsGrant ? { grant: page.needsGrant } : null;
              setValues({});
            }
            return page.needsGrant
              ? { items: [], unavailable: "Listing shared drives needs one more permission from Google. Allow it below, then select Retry." }
              : { items: page.nodes.map(node => toItem(node, accepted)), nextCursor: page.nextCursor };
          }}
          loadItem={async id => {
            const node = await ui.getDriveNode(id);
            return node && toItem(node, accepted);
          }}
          onChange={next => setValues({ target: next })}
          icons={ICONS}
          searchPlaceholder="Search all of Drive or paste a link…"
        />
      </Field>
      {pending && <Fragment>
        <Notice>
          Google will ask to let this app "View and download all your Drive files". It is used only to
          list your shared drives: a connection still reaches only what you choose.
        </Notice>
        <Button onClick={() => void allow(context, pending.grant)}>Allow access</Button>
        {pending.note && <Notice tone={pending.note.tone}>{pending.note.text}</Notice>}
      </Fragment>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveConfiguratorRpc, DriveConfiguratorValues>;
