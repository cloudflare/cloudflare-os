import {
  Button, Field, Fragment, h, HierarchyPicker, Notice, Section,
  type ConfiguratorUIHierarchyAncestor, type ConfiguratorUIHierarchyItem,
  type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  DriveConfiguratorRpc, DriveConfiguratorValues, DriveNode, DriveNodeAncestor, OfficeConversionResult,
  OfficeFileInspection, OfficeKind,
} from "./drive-configurator-types";

// Must mirror `parseDriveUrl` and `parseDocsUrl` in resources.ts, which are what actually mint the
// capability. This module is transpiled on its own and cannot import those parsers, so
// `__tests__/configurator-url.test.ts` is what keeps the copies honest.
const ACCOUNT_PATTERN = "https://drive.google.com/drive/my-drive";
const FOLDER_PATTERN = "https://drive.google.com/drive/folders/:folderId";
const FILE_PATTERN = "https://drive.google.com/file/d/:fileId/view";

/** Per editor kind: the type it binds, its editor's URL path, its product's name and its files' type. */
const EDITORS: Record<OfficeKind, { pattern: string; path: string; title: string; mimeType: string }> = {
  doc: {
    pattern: "https://docs.google.com/document/d/:docId/*", path: "document", title: "Docs",
    mimeType: "application/vnd.google-apps.document",
  },
  sheets: {
    pattern: "https://docs.google.com/spreadsheets/d/:spreadsheetId/*", path: "spreadsheets", title: "Sheets",
    mimeType: "application/vnd.google-apps.spreadsheet",
  },
  slides: {
    pattern: "https://docs.google.com/presentation/d/:presentationId/*", path: "presentation", title: "Slides",
    mimeType: "application/vnd.google-apps.presentation",
  },
};

/** Must equal `OFFICE_IMPORT_GRANT` in resources.ts. */
const OFFICE_IMPORT_GRANT = "https://docs.google.com/import";
const ACCESS_POLL_MS = 2_000;
const ACCESS_WAIT_MS = 3 * 60_000;
/** How long a file check runs before saying so, so a quick one does not flash a notice. */
const CHECKING_NOTICE_DELAY_MS = 400;

/** The whole account's node, the picker's root. */
const ROOT_ID = "drive";

const fileIdOf = (id: string) => id.slice(id.indexOf(":") + 1);

const editorOf = (id: string): OfficeKind | undefined => {
  const prefix = /^(\w+):/.exec(id)?.[1];
  return prefix && Object.hasOwn(EDITORS, prefix) ? prefix as OfficeKind : undefined;
};

const allows = (accepted: readonly string[] | undefined, pattern: string) =>
  accepted === undefined || accepted.includes(pattern);

/**
 * The type a node binds among those the Workshop accepts (an older Workshop does not say, and takes
 * any), or undefined for a grouping or a type it does not take. A Docs, Sheets or Slides file binds
 * its editable type, or, where only Drive files are taken, a read-only Drive file.
 */
const patternOf = (id: string, accepted: readonly string[] | undefined): string | undefined => {
  const editor = editorOf(id);
  const pattern = editor ? EDITORS[editor].pattern
    : id === ROOT_ID ? ACCOUNT_PATTERN
    : id.startsWith("folder:") ? FOLDER_PATTERN
    : id.startsWith("file:") ? FILE_PATTERN
    : undefined;
  if (pattern !== undefined && allows(accepted, pattern)) return pattern;
  return editor && allows(accepted, FILE_PATTERN) ? FILE_PATTERN : undefined;
};

/** The editor kind `id` connects as, when it binds an editable type: one an Office file must be converted for. */
const editing = (id: string, accepted: readonly string[] | undefined): OfficeKind | undefined => {
  const editor = editorOf(id);
  return editor && patternOf(id, accepted) === EDITORS[editor].pattern ? editor : undefined;
};

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
  recent: icon("M12 21q-3.15 0-5.575-1.912T3.275 14.2q-.1-.375.15-.687t.675-.363q.4-.05.725.15t.45.6q.6 2.25 2.475 3.675T12 19q2.925 0 4.963-2.037T19 12t-2.037-4.962T12 5q-1.725 0-3.225.8T6.25 8H8q.425 0 .713.288T9 9t-.288.713T8 10H4q-.425 0-.712-.288T3 9V5q0-.425.288-.712T4 4t.713.288T5 5v1.35q1.275-1.6 3.113-2.475T12 3q1.875 0 3.513.713t2.85 1.924t1.925 2.85T21 12t-.712 3.513t-1.925 2.85t-2.85 1.925T12 21m1-9.4l2.5 2.5q.275.275.275.7t-.275.7t-.7.275t-.7-.275l-2.8-2.8q-.15-.15-.225-.337T11 11.975V8q0-.425.288-.712T12 7t.713.288T13 8z"),
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

const GROUP_ICONS: Record<string, keyof typeof ICONS> = {
  "shared-with-me": "shared-with-me",
  recent: "recent",
};
const iconOf = (node: DriveNode): keyof typeof ICONS | undefined => {
  switch (node.kind) {
    case "group": return GROUP_ICONS[node.id] ?? "shared-drives";
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

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** "1.5 MB", in binary units (1 KB = 1024 bytes), going up a unit once the number would show 1024. */
const size = (bytes: number | undefined): string | undefined => {
  if (bytes === undefined) return undefined;
  let value = bytes;
  let unit = 0;
  while (Math.round(value) >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ${SIZE_UNITS[unit]}`;
};

// A folder or shared drive grant reaches everything in it, checked again on every read.
const CONTAINER_CHOICE = { subtitle: "All of its contents, including anything added later" };

/** As for {@link toItem}: a folder on the path whose children this account cannot list is only seen. */
const toAncestor = (
  { id, title, listable }: DriveNodeAncestor,
  accepted: readonly string[] | undefined,
): ConfiguratorUIHierarchyAncestor =>
  ({ id, title, selectable: listable === true && patternOf(id, accepted) !== undefined, choice: CONTAINER_CHOICE });

/**
 * Docs, Sheets and Slides files the latest listing or lookup of each showed to be native. Choosing
 * one connects it as it is without asking Drive again, since `inspectFile` decides from that same type.
 */
const natives = new Set<string>();

/**
 * A folder whose children this account cannot list cannot be opened or bound, only seen. Records in
 * {@link natives} whether a Docs, Sheets or Slides file is native.
 */
const toItem = (node: DriveNode, accepted: readonly string[] | undefined): ConfiguratorUIHierarchyItem => {
  const editor = editorOf(node.id);
  if (editor) natives[node.mimeType === EDITORS[editor].mimeType ? "add" : "delete"](node.id);
  const container = node.kind !== "file" && (node.kind !== "folder" || node.listable === true);
  return {
    id: node.id,
    title: node.title,
    kind: container ? "container" : "leaf",
    icon: iconOf(node),
    subtitle: [modified(node.modifiedTime), node.detail].filter(Boolean).join(" · ") || undefined,
    meta: size(node.size),
    selectable: (container || node.kind === "file") && patternOf(node.id, accepted) !== undefined,
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

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** Asks from the click, so the browser lets Workshop open Google's consent pop-up. */
const allow = async ({ ensureResources, setValues }: Context, grant: string) => {
  const note = await ensureResources([grant]).then(
    (held): Note => ({ text: held ? "Access is allowed. Select Retry." : "Allow access in Google's window, then select Retry." }),
    (error: unknown): Note => ({ text: errorMessage(error, "Access wasn't allowed."), tone: "error" }));
  if (access?.grant !== grant) return;
  access = { grant, note };
  setValues({});
};

/**
 * Asking for the editable types from a read-only file's notice: `busy` while Google's pop-up is
 * open, `error` when asking failed, and `unavailable` when the account held them already, so the
 * card leaves them out on purpose (an admin disabled them). A grant restarts the picker, clearing it.
 */
let editAccess: { busy?: boolean; error?: string; unavailable?: boolean } = {};

/** Asks from the click, so the browser lets Workshop open Google's consent pop-up. */
const allowEditing = async ({ ensureResources, setValues }: Context, grants: string[]) => {
  const asked = ensureResources(grants);
  editAccess = { busy: true };
  setValues({});
  editAccess = await asked.then(
    held => held ? { unavailable: true } : {},
    (error: unknown) => ({ error: errorMessage(error, "Access wasn't allowed.") }));
  setValues({});
};

type OfficeFile = Extract<OfficeFileInspection, { type: "office" }>;
type Converted = Extract<OfficeConversionResult, { type: "converted" }>;
type Busy = "converting" | "waiting";

/**
 * What the chosen Docs, Sheets or Slides file needs before it can be connected. `checked` holds only
 * a target that can be connected as it is.
 */
type Flow =
  | { step: "idle" }
  | { step: "inspecting"; target: string; slow?: true }
  | { step: "unsupported"; target: string }
  | { step: "refused"; target: string; message: string }
  | { step: "office"; target: string; file: OfficeFile; busy?: Busy; error?: string }
  | { step: "converted"; kind: OfficeKind; copy: Converted };

let flow: Flow = { step: "idle" };
// Bumped by every choice, prefill and Convert, so an await that resolves after one is a no-op.
let generation = 0;

const begin = (next: Flow): number => {
  flow = next;
  return ++generation;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The copy just made, shown as it is when the picker's lookup of it comes too soon for Drive or
 * fails, so that lookup does not let go of a copy that exists.
 */
const convertedNode = (id: string): DriveNode | undefined =>
  flow.step === "converted" && id === `${flow.kind}:${flow.copy.fileId}`
    ? { id, title: flow.copy.title, kind: "file", mimeType: EDITORS[flow.kind].mimeType }
    : undefined;

/**
 * What `target` needs before it can be connected. `idle` means nothing: it is native, or Drive could
 * not say, in which case it is connected as it is and the gatekeeper's describe() decides.
 */
async function inspect(ui: DriveConfiguratorRpc, target: string): Promise<Flow> {
  try {
    const file = await ui.inspectFile(editorOf(target)!, fileIdOf(target));
    if (file.type === "native") return { step: "idle" };
    if (file.type === "unsupported") return { step: "unsupported", target };
    if (file.type === "refused") return { step: "refused", target, message: file.message };
    return { step: "office", target, file };
  } catch {
    return { step: "idle" };
  }
}

/**
 * Inspects `target` into `flow`, resolving to its `checked` value: `target` when it connects as it
 * is, else null. Undefined when a later choice superseded it. `rerender` shows the check's notice
 * once it is slow.
 */
async function check(ui: DriveConfiguratorRpc, target: string, rerender?: () => void): Promise<string | null | undefined> {
  const run = begin({ step: "inspecting", target });
  const slow = setTimeout(() => {
    if (run !== generation) return;
    flow = { step: "inspecting", target, slow: true };
    rerender?.();
  }, CHECKING_NOTICE_DELAY_MS);
  const next = await inspect(ui, target);
  clearTimeout(slow);
  if (run !== generation) return undefined;
  flow = next;
  return next.step === "idle" ? target : null;
}

/** The user's choice. A Docs, Sheets or Slides file is held back until it is known to connect as it is. */
async function choose(context: Context, target: string | null) {
  const { setValues, ui, acceptedResourceUrlPatterns } = context;
  // A failed request's error belongs to the file it was made from; busy and unavailable do not.
  if (editAccess.error) editAccess = {};
  if (target === null || !editing(target, acceptedResourceUrlPatterns)) {
    begin({ step: "idle" });
    setValues({ target, checked: null });
    return;
  }
  if (natives.has(target)) {
    begin({ step: "idle" });
    setValues({ target, checked: target });
    return;
  }
  const checking = check(ui, target, () => setValues({}));
  setValues({ target, checked: null });
  const checked = await checking;
  if (checked !== undefined) setValues({ checked });
}

/**
 * Converts the chosen Office file, or with `reuse` takes the copy made of it before. A new copy asks
 * for access first, from the click, so the browser lets Workshop open the consent pop-up; when the
 * grant is still to come, the gatekeeper is polled until it holds it. Reusing a copy reads only what
 * the connection already may, so it asks for nothing.
 */
async function convert({ setValues, ensureResources, ui }: Context, reuse?: string) {
  if (flow.step !== "office") return;
  const asked = reuse === undefined ? ensureResources([OFFICE_IMPORT_GRANT]) : Promise.resolve(true);
  const { target, file } = flow;
  const kind = editorOf(target)!;
  const fileId = fileIdOf(target);
  const run = begin({ step: "office", target, file, busy: "converting" });
  const show = (busy: Busy | undefined, error?: string) => {
    flow = { step: "office", target, file, ...(busy ? { busy } : {}), ...(error ? { error } : {}) };
    setValues({});
  };

  let deadline: number | undefined;
  const waitForAccess = async () => {
    deadline ??= Date.now() + ACCESS_WAIT_MS;
    show("waiting");
    while (Date.now() < deadline) {
      await sleep(ACCESS_POLL_MS);
      if (run !== generation) return false;
      const granted = await ui.hasConversionAccess();
      if (run !== generation) return false;
      if (granted) {
        show("converting");
        return true;
      }
    }
    throw new Error("Access wasn't granted within 3 minutes. Select Convert to try again.");
  };

  try {
    setValues({});
    const held = await asked;
    if (run !== generation) return;
    if (!held && !(await waitForAccess())) return;
    for (;;) {
      const result = reuse === undefined
        ? await ui.convertFile(kind, fileId)
        : await ui.convertFile(kind, fileId, { reuse });
      if (run !== generation) return;
      if (result.type === "converted") {
        // The copy is a new value, which the picker looks up and opens where it lives.
        const copy = `${kind}:${result.fileId}`;
        flow = { step: "converted", kind, copy: result };
        setValues({ target: copy, checked: copy });
        return;
      }
      // No pop-up was opened, so no grant is on its way.
      if (held) {
        throw new Error("Google hasn't granted access to copy the file. Select Convert to try again.");
      }
      if (!(await waitForAccess())) return;
    }
  } catch (error) {
    if (run !== generation) return;
    const message = errorMessage(error, "The copy could not be made.");
    show(undefined, message);
    // A copy whose reply was lost may still have been made, and a copy offered for reuse may be
    // gone, so look again before offering either.
    const latest = await inspect(ui, target);
    if (run !== generation || latest.step !== "office") return;
    flow = { step: "office", target, file: latest.file, error: message };
    setValues({});
  }
}

function convertedText({ kind, copy }: Extract<Flow, { step: "converted" }>): string {
  const product = EDITORS[kind].title;
  if (copy.reused) {
    const where = copy.location === "myDrive" ? "in My Drive" : "next to the original";
    return `Using the Google ${product} copy "${copy.title}" made earlier, ${where}. ` +
      "Later edits to the original won't sync.";
  }
  const where = copy.location === "myDrive"
    ? "in My Drive, because the original's folder could not take it"
    : "next to the original";
  return `Made the Google ${product} copy "${copy.title}" ${where}. ` +
    "The original is unchanged, and later edits to it won't sync.";
}

/**
 * Says a Docs, Sheets or Slides file the Workshop takes only as a Drive file connects read-only, and
 * on the Google Drive card offers to ask for the editable types the account lacks.
 */
function readOnlyNotice(context: Context) {
  const { values: { target }, acceptedResourceUrlPatterns: accepted } = context;
  const editor = editorOf(target ?? "");
  if (!editor || patternOf(target!, accepted) !== FILE_PATTERN) return null;
  // The editable types the Google Drive card offers that the account has not granted. None for a
  // blueprint's binding, which takes its own type alone, rather than all of Drive and folders too.
  const ungranted = accepted?.includes(ACCOUNT_PATTERN) && accepted.includes(FOLDER_PATTERN)
    ? Object.values(EDITORS).map(({ pattern }) => pattern).filter(pattern => !accepted.includes(pattern))
    : [];
  if (editAccess.unavailable) return <Notice>Editing isn't available here, so this connects read-only as a Drive file.</Notice>;
  if (!ungranted.length) return <Notice>Connects read-only as a Drive file.</Notice>;
  const action = { label: "Allow editing", disabled: editAccess.busy, onClick: () => void allowEditing(context, ungranted) };
  return editAccess.error
    ? <Notice tone="error" action={action}>{editAccess.error}</Notice>
    : <Notice action={action}>
      {`Connects read-only as a Drive file. To edit it as a Google ${EDITORS[editor].title} file, allow editing and choose it again.`}
    </Notice>;
}

function officeNotices(context: Context) {
  if (flow.step === "idle") return readOnlyNotice(context);
  if (flow.step === "converted") return <Notice>{convertedText(flow)}</Notice>;
  // A notice describes the file chosen now; a choice the picker let go of takes its notice with it.
  if (flow.target !== context.values.target) return null;
  const product = EDITORS[editorOf(flow.target)!].title;
  if (flow.step === "inspecting") return flow.slow ? <Notice>Checking the file…</Notice> : null;
  if (flow.step === "unsupported") {
    return <Notice tone="error">
      {`This file isn't a Google ${product} file, or an Office file that can be converted into one.`}
    </Notice>;
  }
  if (flow.step === "refused") return <Notice tone="error">{flow.message}</Notice>;
  const { file, busy, error } = flow;
  const existing = file.existingCopy;
  // Turning off copying stops new copies only: a copy made before stays the account's to use.
  if (!file.canCopy && !existing) {
    return <Notice tone="error">
      {`The owner of this file has turned off copying, so it can't be converted into a Google ${product} file.`}
    </Notice>;
  }
  return <Fragment>
    {file.canCopy
      ? <Notice>
        {`Connecting makes a Google ${product} copy next to the original. The original is ` +
          "unchanged, and later edits to it won't sync."}
      </Notice>
      : <Notice tone="error">
        {"The owner of this file has turned off copying, so it can't be converted again, but " +
          "the copy made before can still be used."}
      </Notice>}
    {busy && <Notice>
      {busy === "waiting" ? "Waiting for access in the pop-up…" : "Making the copy…"}
    </Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
      {file.canCopy && <Button
        variant="primary"
        disabled={busy !== undefined}
        onClick={() => void convert(context)}
      >
        Convert
      </Button>}
      {existing && <Button
        variant="secondary"
        disabled={busy !== undefined}
        onClick={() => void convert(context, existing.fileId)}
      >
        {`Use the copy made on ${new Date(existing.convertedAt).toLocaleDateString()}`}
      </Button>}
    </div>
  </Fragment>;
}

export default {
  initial: { target: null },
  async initialValuesFromResourceUrl({ resourceUrl, ui, acceptedResourceUrlPatterns }) {
    if (!URL.canParse(resourceUrl)) return {};
    const { pathname } = new URL(resourceUrl);
    if (/^\/drive\/my-drive\/?$/.test(pathname)) return { target: ROOT_ID };
    const folder = /^\/drive\/folders\/([^/]+)\/?$/.exec(pathname);
    if (folder) return { target: `folder:${decodeURIComponent(folder[1])}` };
    const file = /^\/file\/d\/([^/]+)\/view\/?$/.exec(pathname);
    if (file) return { target: `file:${decodeURIComponent(file[1])}` };
    // An editor's URL, read as `parseDocsUrl` does, but only with an ID in Drive's alphabet, which
    // `inspectFile` requires.
    const [, path, d, id] = pathname.split("/");
    const kind = (Object.keys(EDITORS) as OfficeKind[]).find(kind => EDITORS[kind].path === path);
    if (!kind || d !== "d" || id === undefined || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) return {};
    const target = `${kind}:${id}`;
    if (!editing(target, acceptedResourceUrlPatterns)) return { target };
    const checked = await check(ui, target);
    // Anything else stays chosen but unchecked, so its notice says why it cannot be connected.
    return checked === undefined ? {} : checked ? { target, checked } : { target };
  },
  isReady: ({ values: { target, checked }, acceptedResourceUrlPatterns: accepted }) =>
    typeof target === "string" && patternOf(target, accepted) !== undefined &&
    (editing(target, accepted) === undefined || checked === target),
  resourceUrl: ({ values: { target }, acceptedResourceUrlPatterns: accepted }) => {
    const pattern = target ? patternOf(target, accepted) : undefined;
    if (!target || !pattern) throw new Error("Choose what to connect.");
    const id = encodeURIComponent(fileIdOf(target));
    const editor = editing(target, accepted);
    return editor ? `https://docs.google.com/${EDITORS[editor].path}/d/${id}/edit` : pattern.replace(/:\w+Id\b/, () => id);
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
            selectable: patternOf(ROOT_ID, accepted) !== undefined,
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
            const copy = convertedNode(id);
            const node = await ui.getDriveNode(id).then(found => found ?? copy, error => copy ?? Promise.reject(error));
            return node ? toItem(node, accepted) : null;
          }}
          onChange={next => void choose(context, next)}
          icons={ICONS}
          searchPlaceholder="Search all of Drive or paste a link…"
        />
      </Field>
      {officeNotices(context)}
      {pending && <Notice tone={pending.note?.tone} action={{ label: "Allow access", onClick: () => void allow(context, pending.grant) }}>
        {pending.note?.text ?? "Google will ask to let this app \"View and download all your Drive files\". It is used " +
          "only to list your shared drives: a connection still reaches only what you choose."}
      </Notice>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveConfiguratorRpc, DriveConfiguratorValues>;
