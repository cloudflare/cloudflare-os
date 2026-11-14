import {
  Button, Fragment, h, Notice, Section,
  type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  OutlookConfiguratorAccess as Access,
  OutlookConfiguratorRpc as Rpc,
  OutlookConfiguratorStatus as Status,
  OutlookConversation as Conversation,
  OutlookConversationList as ConversationList,
  OutlookDraft as Draft,
  OutlookFolderKind as FolderKind,
  OutlookFolderList as FolderList,
  OutlookFolderRow as FolderRow,
  OutlookPerson as Person,
  OutlookSharedMailbox as SharedMailbox,
} from "./outlook-configurator-types";

/** Must equal `OUTLOOK_RESOURCE.urlPattern` in microsoft-env.ts. */
const OUTLOOK_GRANT = "https://outlook.office.com/*";
const ACCESS_POLL_MS = 2_000;
const ACCESS_WAIT_MS = 3 * 60_000;
const SEARCH_DEBOUNCE_MS = 250;
/** Must not exceed `MAX_SENDERS` in outlook-scope.ts. */
const MAX_SENDERS = 50;
const ADDRESS = /^[^\s@<>()",;:/\\]+@[^\s@<>()",;:/\\]+\.[^\s@<>()",;:/\\]+$/;
const DOMAIN = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const BARE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

type Target = "all" | "folder" | "people" | "conversation";

type Values = {
  /** Whose mailbox: the user's own, or a shared one. */
  mailboxMode?: "mine" | "shared" | null;
  /** The shared mailbox, once it has been opened. */
  mailbox?: string | null;
  mailboxName?: string | null;
  target?: Target | null;
  folderId?: string | null;
  folderPath?: string | null;
  /** "0" to leave out the folder's subfolders. */
  subfolders?: string | null;
  /** JSON arrays, since names and addresses aren't safe to join. */
  senders?: string | null;
  conversationId?: string | null;
  conversationSubject?: string | null;
  access?: Access | null;
};

type Context = ConfiguratorUIRenderContext<Rpc, Values>;

type Connection =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "waiting" }
  | Status;

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed"; message: string };

let connection: Connection = { state: "loading" };
let asked = false;
// Bumped by every status request, so a reply that a newer one overtook is dropped.
let generation = 0;
// Re-renders with what has loaded. Every render installs its own, so a late reply reaches the
// current tree. It changes no values, so it never invalidates a resource URL being collected.
let rerender: () => void = () => {};

const folderLists = new Map<string, Load<FolderList>>();
let folderQuery = "";
/** Whether the folder list has been scrolled to the chosen folder, which happens once, when it first lists. */
let folderRevealed = false;

/** The little of the frame's DOM this module touches directly; the runtime builds everything else. */
type FrameNode = { offsetTop: number; offsetHeight: number; clientHeight: number; scrollTop: number; closest(selector: string): FrameNode | null };
const frameDocument = (globalThis as unknown as { document?: { getElementById(id: string): FrameNode | null } }).document;

let shared: { input: string; state: "idle" | "checking" | "failed"; message?: string; run: number; opened?: SharedMailbox } =
  { input: "", state: "idle", run: 0 };

/** The people picker: what is typed, its suggestions, and the one the arrow keys are on. */
let people: { query: string; results: Person[]; loading: boolean; failed?: string; active: number; open: boolean; run: number; invalid?: string } =
  { query: "", results: [], loading: false, active: -1, open: false, run: 0 };
let peopleTimer: ReturnType<typeof setTimeout> | undefined;
/** Names for addresses the user has picked, which the binding itself doesn't keep. */
const names = new Map<string, string>();

let conversations: { mailbox: string | null; query: string; load: Load<ConversationList>; run: number } | undefined;
let conversationTimer: ReturnType<typeof setTimeout> | undefined;


const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// -- the connection ---------------------------------------------------------------------------

function loadStatus({ ui }: Context): void {
  if (asked) return;
  asked = true;
  const run = ++generation;
  ui.getStatus().then(status => {
    if (run !== generation) return;
    connection = status;
    rerender();
  }, error => {
    if (run !== generation) return;
    connection = { state: "failed", message: errorMessage(error, "Couldn't reach Outlook.") };
    rerender();
  });
}

/**
 * Asks for Outlook access from the click, so the browser lets Workshop open the consent pop-up,
 * then waits for the grant to land.
 */
async function allowAccess({ ensureResources, ui }: Context): Promise<void> {
  const run = ++generation;
  const access = ensureResources([OUTLOOK_GRANT]);
  connection = { state: "waiting" };
  rerender();
  try {
    const held = await access;
    const deadline = Date.now() + ACCESS_WAIT_MS;
    for (;;) {
      if (!held) await sleep(ACCESS_POLL_MS);
      if (run !== generation) return;
      const status = await ui.getStatus();
      if (run !== generation) return;
      if (status.state !== "needsAccess" || held) {
        connection = status;
        rerender();
        return;
      }
      if (Date.now() > deadline) throw new Error("Access wasn't granted within 3 minutes. Select Allow access to try again.");
    }
  } catch (error) {
    if (run !== generation) return;
    connection = { state: "failed", message: errorMessage(error, "Access wasn't granted.") };
    rerender();
  }
}

/** Starts a load the first time `key` is asked for, and re-renders when it settles. */
function loaded<T>(map: Map<string, Load<T>>, key: string, fetch: () => Promise<T>, fallback: string): Load<T> {
  const known = map.get(key);
  if (known) return known;
  const entry: Load<T> = { state: "loading" };
  map.set(key, entry);
  fetch().then(value => {
    if (map.get(key) !== entry) return;
    map.set(key, { state: "ready", value });
    rerender();
  }, error => {
    if (map.get(key) !== entry) return;
    map.set(key, { state: "failed", message: errorMessage(error, fallback) });
    rerender();
  });
  return entry;
}

// -- values -----------------------------------------------------------------------------------

function list(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const json = (items: string[]) => items.length ? JSON.stringify(items) : null;
const mailboxOf = (values: Values) => values.mailboxMode === "shared" ? values.mailbox ?? null : null;
const mailboxKey = (values: Values) => mailboxOf(values) ?? "";

/** The levels the chosen mailbox allows, lowest first. */
function allowedLevels(values: Values): Access[] {
  if (connection.state !== "ready") return [];
  return values.mailboxMode === "shared" ? connection.sharedLevels : connection.levels;
}

/** The chosen level, or the most the mailbox allows below it when it allows less. */
function accessOf(values: Values): Access | undefined {
  const allowed = allowedLevels(values);
  const wanted = values.access ?? "read";
  if (allowed.includes(wanted)) return wanted;
  const order: Access[] = ["read", "draft", "send"];
  return allowed.filter(level => order.indexOf(level) < order.indexOf(wanted)).at(-1) ?? allowed[0];
}

/** What the values bind, or what is still missing. */
function draftOf(values: Values): { draft: Draft } | { missing: string } {
  if (values.mailboxMode === "shared" && !values.mailbox) return { missing: "Open the shared mailbox to continue." };
  const access = accessOf(values);
  if (access === undefined) return { missing: "This connection can't open that mailbox." };
  const draft: Draft = { access, ...(mailboxOf(values) ? { mailbox: mailboxOf(values)! } : {}) };
  const target = values.target ?? "all";
  if (target === "conversation") {
    if (!values.conversationId) return { missing: "Choose a conversation." };
    return { draft: { ...draft, conversationId: values.conversationId } };
  }
  if (target === "folder") {
    if (!values.folderId) return { missing: "Choose a folder." };
    draft.folder = { id: values.folderId, subfolders: values.subfolders !== "0" };
  }
  const senders = list(values.senders);
  if (target === "people" && senders.length === 0) return { missing: "Add a person or a domain." };
  if (senders.length > 0 && target !== "all") draft.senders = senders;
  return { draft };
}

/** Everything that belongs to one mailbox, cleared when the mailbox changes. */
const MAILBOX_FIELDS = { folderId: null, folderPath: null, subfolders: null, conversationId: null, conversationSubject: null } as const;

// -- formatting -------------------------------------------------------------------------------

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** "9:41 AM" today, "Tue" this week, "Oct 12" this year, "Oct 12, 2024" before, in the viewer's zone. */
function when(iso: string | undefined, now = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days >= 0 && days < 6) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

function initials(text: string): string {
  const words = text.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words.at(-1)![0] : "")).toUpperCase() || "?";
}

// -- icons ------------------------------------------------------------------------------------

const ICONS: Record<string, string> = {
  all: "M1.75 5.75h12.5v7.5H1.75Z M3.25 3.75h9.5 M4.75 1.75h6.5 M1.75 6.25 8 10.25l6.25-4",
  folder: "M1.75 4A1.25 1.25 0 0 1 3 2.75h3l1.5 1.5H13A1.25 1.25 0 0 1 14.25 5.5v6.75A1.25 1.25 0 0 1 13 13.5H3a1.25 1.25 0 0 1-1.25-1.25Z",
  people: "M8 7.25a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z M2.75 14.25c0-2.9 2.35-5 5.25-5s5.25 2.1 5.25 5",
  conversation: "M2 3.25C2 2.55 2.55 2 3.25 2h7.5C11.45 2 12 2.55 12 3.25v4.5C12 8.45 11.45 9 10.75 9H6l-2.5 2V9h-.25C2.55 9 2 8.45 2 7.75Z M12 5.5h.75c.7 0 1.25.55 1.25 1.25v4.5c0 .7-.55 1.25-1.25 1.25h-.25V14L10 12.5H7.25c-.7 0-1.25-.55-1.25-1.25V11",
  inbox: "M2 9.5h3.25l1 1.5h3.5l1-1.5H14 M2 9.5l1.6-6h8.8l1.6 6v3.25c0 .7-.55 1.25-1.25 1.25h-9.5C2.55 14 2 13.45 2 12.75Z",
  drafts: "M10.5 2.25l3.25 3.25L6 13.25H2.75V10Z M9 3.75 12.25 7",
  sent: "M14.25 1.75 1.75 7.25l5 1.85 1.85 5.15Z M6.75 9.1l7.5-7.35",
  deleted: "M2.5 4h11 M6 4V2.5h4V4 M3.75 4l.7 9.25c.05.7.6 1.25 1.3 1.25h4.5c.7 0 1.25-.55 1.3-1.25L12.25 4",
  junk: "M8 1.75a6.25 6.25 0 1 0 0 12.5A6.25 6.25 0 0 0 8 1.75Z M3.6 3.6l8.8 8.8",
  archive: "M1.75 2.5h12.5v3.25H1.75Z M2.75 5.75v7.75h10.5V5.75 M6.25 8.5h3.5",
  history: "M8 1.75a6.25 6.25 0 1 0 0 12.5A6.25 6.25 0 0 0 8 1.75Z M8 4.5V8l2.5 1.5",
  outbox: "M2 9.5h3.25l1 1.5h3.5l1-1.5H14 M2 9.5v3.25c0 .7.55 1.25 1.25 1.25h9.5c.7 0 1.25-.55 1.25-1.25V9.5 M8 8V1.75 M5.5 4.25 8 1.75l2.5 2.5",
  yes: "M3 8.5l3 3 7-7",
  close: "M4.5 4.5l7 7M11.5 4.5l-7 7",
};

function icon(name: string, size = 16) {
  return <svg viewBox="0 0 16 16" width={String(size)} height={String(size)} aria-hidden="true" focusable="false">
    <path d={ICONS[name] ?? ICONS.folder} fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
  </svg>;
}

function searchIcon() {
  return <span className="search-icon">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M7 2.25a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5ZM1.25 7a5.75 5.75 0 1 1 10.21 3.63l3.2 3.2a.59.59 0 0 1-.83.83l-3.2-3.2A5.75 5.75 0 0 1 1.25 7Z" fill="currentColor" />
    </svg>
  </span>;
}

const FOLDER_ICONS: Record<FolderKind, string> = {
  inbox: "inbox", drafts: "drafts", sent: "sent", deleted: "deleted", junk: "junk", archive: "archive", outbox: "outbox", history: "history", folder: "folder",
};

// -- pieces -----------------------------------------------------------------------------------

/** A radio card. The native radio carries the semantics and the arrow keys; the card is its label. */
function card(props: {
  group: string; value: string; checked: boolean; title: string; description: string; icon: string;
  onChoose: () => void;
}) {
  const id = `${props.group}-${props.value}`;
  return <label className={`ol-card${props.checked ? " selected" : ""}`} htmlFor={id}>
    <span className="ol-card-icon">{icon(props.icon)}</span>
    <span className="ol-card-text">
      <span className="ol-card-title">{props.title}</span>
      <span className="ol-card-description" id={`${id}-description`}>{props.description}</span>
    </span>
    <input
      type="radio" className="ol-radio" id={id} name={props.group} value={props.value}
      data-configurator-input={id} checked={props.checked}
      aria-describedby={`${id}-description`}
      onChange={() => props.onChoose()}
    />
  </label>;
}

/** A step of the form: a group of choices under its title. */
function step(title: string, children: unknown) {
  return <fieldset className="ol-step">
    <legend className="ol-step-title">{title}</legend>
    {children}
  </fieldset>;
}

function skeletonRows(count: number) {
  return <div className="ol-list" aria-busy="true" aria-label="Loading">
    {Array.from({ length: count }, (_, index) => <div className="ol-row ol-skeleton-row">
      <span className="ol-skeleton" style={{ width: "16px", height: "16px", borderRadius: "50%" }} />
      <span className="ol-skeleton" style={{ width: `${46 + (index * 17) % 34}%` }} />
    </div>)}
  </div>;
}

function failedBox(message: string, retry: () => void) {
  return <div className="ol-failed">
    <p className="ol-failed-text" role="alert">{message}</p>
    <Button variant="secondary" onClick={retry}>Try again</Button>
  </div>;
}

/** A compact radio group. Each option is a native radio, so the arrow keys move between them. */
function segmented<T extends string>(props: {
  group: string; label: string; options: { value: T; title: string; id?: string }[]; value: T | undefined;
  onChoose: (value: T) => void; describedBy?: string; heading?: boolean;
}) {
  return <div className="ol-subfield" role="radiogroup" aria-labelledby={`${props.group}-label`}>
    <span className={props.heading ? "ol-step-title" : "ol-label"} id={`${props.group}-label`}>{props.label}</span>
    <div className="ol-segmented">
      {props.options.map(option => {
        const id = option.id ?? `${props.group}-${option.value}`;
        const checked = option.value === props.value;
        return <label className={`ol-segment${checked ? " selected" : ""}`} htmlFor={id}>
          <input type="radio" className="visually-hidden" id={id} name={props.group} data-configurator-input={id}
            checked={checked} aria-describedby={props.describedBy} onChange={() => props.onChoose(option.value)} />
          {option.title}
        </label>;
      })}
    </div>
  </div>;
}

// -- step 1: the mailbox ------------------------------------------------------------------------

/** Shown in place of the shared mailbox the grant can't open. Opening one never means signing in as it. */
const SHARED_MAILBOX_HINT = "Shared mailboxes open through your own account, once an admin approves more Microsoft 365 permissions and you reconnect.";

function mailboxStep(context: Context, status: Extract<Status, { state: "ready" }>) {
  const { values, setValues } = context;
  const mode = values.mailboxMode ?? "mine";
  const sharedAllowed = status.sharedLevels.length > 0;
  const choose = (next: "mine" | "shared") => {
    if (next === mode) return;
    shared = { ...shared, state: "idle", message: undefined };
    folderQuery = "";
    setValues({ mailboxMode: next, mailbox: null, mailboxName: null, ...MAILBOX_FIELDS });
  };
  // A binding being edited keeps its shared mailbox on show even after the grant narrows.
  if (!sharedAllowed && mode !== "shared") return <section className="ol-step"><p className="ol-hint">{SHARED_MAILBOX_HINT}</p></section>;
  return <section className="ol-step">
    {segmented({
      group: "ol-mailbox", label: "Mailbox", value: mode, onChoose: choose,
      options: [{ value: "mine", title: "Yours" }, { value: "shared", title: "A shared mailbox" }],
    })}
    {mode === "shared" ? sharedMailbox(context) : null}
  </section>;
}

function sharedMailbox(context: Context) {
  const { values, setValues } = context;
  if (values.mailbox) {
    const name = values.mailboxName && values.mailboxName !== values.mailbox ? values.mailboxName : undefined;
    return <div className="ol-opened">
      <span className="ol-avatar" aria-hidden="true">{initials(name ?? values.mailbox)}</span>
      <span className="ol-opened-text">
        <span className="ol-opened-title">{name ?? values.mailbox}</span>
        {name ? <span className="ol-opened-subtitle">{values.mailbox}</span> : null}
      </span>
      <span className="ol-verified">{icon("yes", 14)}You have access</span>
      <Button variant="secondary" onClick={() => {
        shared = { ...shared, input: values.mailbox ?? "", state: "idle", message: undefined };
        setValues({ mailbox: null, mailboxName: null, ...MAILBOX_FIELDS });
      }}>Change</Button>
    </div>;
  }
  const checking = shared.state === "checking";
  const invalid = shared.state === "failed";
  return <div className="ol-shared-entry">
    <label className="ol-label" htmlFor="ol-shared-input">Shared mailbox address</label>
    <div className="ol-inline">
      <div className="input-wrapper ol-grow">
        <input
          id="ol-shared-input" className={`input no-icon${invalid ? " invalid" : ""}`} type="email" inputmode="email"
          data-configurator-input="ol-shared-input" value={shared.input} placeholder="support@contoso.com"
          autocomplete="off" spellcheck="false" aria-invalid={invalid ? "true" : "false"}
          aria-describedby={invalid ? "ol-shared-error" : "ol-shared-hint"}
          onInput={(event: { currentTarget: { value: string } }) => { shared.input = event.currentTarget.value; }}
          onKeydown={(event: { key: string; preventDefault(): void }) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void openShared(context);
            }
          }}
        />
      </div>
      <Button variant="primary" disabled={checking} onClick={() => void openShared(context)}>{checking ? "Opening…" : "Open"}</Button>
    </div>
    {invalid
      ? <p className="ol-error" id="ol-shared-error" role="alert">{shared.message}</p>
      : <p className="ol-hint" id="ol-shared-hint">{checking ? "Checking that you can open it…" : "We'll open its Inbox to check that you have access."}</p>}
  </div>;
}

async function openShared({ ui, setValues }: Context): Promise<void> {
  const address = shared.input.trim().toLowerCase();
  const fail = (message: string) => {
    shared = { ...shared, state: "failed", message };
    rerender();
  };
  if (address === "") return fail("Enter the shared mailbox's email address, like support@contoso.com.");
  if (!ADDRESS.test(address)) return fail(`"${address}" isn't an email address. Enter one like support@contoso.com.`);
  if (connection.state === "ready" && address === connection.me.address.toLowerCase()) {
    return fail("That's your own mailbox. Choose Yours above instead.");
  }
  const run = ++shared.run;
  shared = { ...shared, input: address, state: "checking", message: undefined };
  rerender();
  try {
    const opened = await ui.openSharedMailbox(address);
    if (run !== shared.run) return;
    shared = { input: opened.address, state: "idle", run, opened };
    folderQuery = "";
    setValues({ mailbox: opened.address, mailboxName: opened.name, ...MAILBOX_FIELDS });
  } catch (error) {
    if (run !== shared.run) return;
    fail(errorMessage(error, "That mailbox couldn't be opened."));
  }
}

// -- step 2: what to connect ----------------------------------------------------------------------

const TARGETS: { value: Target; title: string; description: string; icon: string }[] = [
  { value: "all", title: "Whole mailbox", description: "Every folder, and new mail.", icon: "all" },
  { value: "folder", title: "One folder", description: "Inbox or a folder you choose.", icon: "folder" },
  { value: "people", title: "From certain people", description: "Mail from people or domains you name.", icon: "people" },
  { value: "conversation", title: "One conversation", description: "A single thread and its replies.", icon: "conversation" },
];

function targetStep(context: Context) {
  const { values, setValues } = context;
  const target = values.target ?? "all";
  return step("What to connect", <Fragment>
    <div className="ol-cards" role="radiogroup" aria-label="What to connect">
      {TARGETS.map(option => card({
        group: "ol-target", value: option.value, checked: target === option.value, icon: option.icon,
        title: option.title, description: option.description, onChoose: () => setValues({ target: option.value }),
      }))}
    </div>
    {target === "folder" ? folderPicker(context) : null}
    {target === "people" ? peoplePicker(context) : null}
    {target === "conversation" ? conversationPicker(context) : null}
  </Fragment>);
}

function folderPicker(context: Context) {
  const { values, setValues, ui } = context;
  const mailbox = mailboxOf(values);
  const load = loaded(folderLists, mailboxKey(values), () => ui.listFolders(mailbox), "Couldn't list this mailbox's folders.");
  const query = folderQuery.trim().toLowerCase();
  const folders = load.state === "ready" ? load.value.folders : [];
  const shown = query === "" ? folders : folders.filter(folder => folder.path.toLowerCase().includes(query));
  const chosen = folders.find(folder => folder.id === values.folderId);
  const choose = (folder: FolderRow) => setValues({ folderId: folder.id, folderPath: folder.path, subfolders: values.folderId === folder.id ? values.subfolders ?? null : null });
  const senders = list(values.senders);
  if (!folderRevealed && load.state === "ready") {
    folderRevealed = true;
    // A binding being edited opens on its folder, wherever it is in a long list.
    if (values.folderId) setTimeout(() => revealFolder(values.folderId!), 0);
  }
  return <div className="ol-panel">
    <div className="ol-panel-toolbar">
      <div className="input-wrapper ol-grow">
        {searchIcon()}
        <input
          className="input" type="search" data-configurator-input="ol-folder-search" value={folderQuery}
          placeholder="Find a folder" aria-label="Find a folder" aria-controls="ol-folders" autocomplete="off"
          disabled={load.state !== "ready"}
          onInput={(event: { currentTarget: { value: string } }) => {
            folderQuery = event.currentTarget.value;
            rerender();
          }}
          onKeydown={(event: { key: string; preventDefault(): void }) => {
            if (event.key === "Escape" && folderQuery !== "") {
              event.preventDefault();
              folderQuery = "";
              rerender();
            }
          }}
        />
      </div>
    </div>
    {load.state === "loading" ? skeletonRows(5) : null}
    {load.state === "failed" ? failedBox(load.message, () => {
      folderLists.delete(mailboxKey(values));
      rerender();
    }) : null}
    {load.state === "ready" ? <Fragment>
      {load.value.notice ? <p className="ol-panel-notice">{load.value.notice}</p> : null}
      <div className="ol-list" id="ol-folders" role="radiogroup" aria-label="Folders">
        {shown.length === 0
          ? <p className="ol-empty">{query ? `No folders match "${folderQuery.trim()}".` : "This mailbox has no folders to choose from."}</p>
          : shown.map(folder => {
            const checked = folder.id === values.folderId;
            const id = `ol-folder-${folder.id}`;
            return <label className={`ol-row${checked ? " selected" : ""}`} htmlFor={id} style={{ paddingLeft: `${8 + (query ? 0 : folder.depth) * 18}px` }}>
              <input type="radio" className="ol-radio" id={id} name="ol-folder" data-configurator-input={id} checked={checked}
                aria-label={folder.path} onChange={() => choose(folder)} />
              <span className="ol-row-icon">{icon(FOLDER_ICONS[folder.kind])}</span>
              <span className="ol-row-text">
                <span className="ol-row-title">{folder.name}</span>
                {query && folder.path !== folder.name ? <span className="ol-row-subtitle">{folder.path}</span> : null}
              </span>
            </label>;
          })}
      </div>
    </Fragment> : null}
    {values.folderId ? <div className="ol-panel-footer">
      <span className="ol-chosen">{icon(FOLDER_ICONS[chosen?.kind ?? "folder"], 14)}<strong>{values.folderPath ?? chosen?.path ?? "The chosen folder"}</strong></span>
      <label className="ol-check" htmlFor="ol-subfolders">
        <input type="checkbox" id="ol-subfolders" data-configurator-input="ol-subfolders" checked={values.subfolders !== "0"}
          onChange={(event: { currentTarget: { checked: boolean } }) => setValues({ subfolders: event.currentTarget.checked ? null : "0" })} />
        <span>{chosen && chosen.descendants > 0 ? `Include its ${plural(chosen.descendants, "subfolder")}` : "Include subfolders, and any added later"}</span>
      </label>
    </div> : null}
    {senders.length > 0 ? <div className="ol-panel-footer">
      <span className="ol-hint">{`Only mail from ${senders.join(", ")}.`}</span>
      <Button variant="secondary" onClick={() => setValues({ senders: null })}>Include everyone</Button>
    </div> : null}
  </div>;
}

function revealFolder(id: string): void {
  const list = frameDocument?.getElementById("ol-folders");
  const row = frameDocument?.getElementById(`ol-folder-${id}`)?.closest("label");
  if (!list || !row) return;
  list.scrollTop = Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2);
}

/** The options the people box offers for what is typed: the typed address or domain itself, then matches. */
function peopleOptions(chosen: string[]): { address: string; title: string; subtitle?: string; domain?: boolean }[] {
  const typed = people.query.trim().toLowerCase();
  const options: { address: string; title: string; subtitle?: string; domain?: boolean }[] = [];
  const domain = DOMAIN.test(typed) ? typed : BARE_DOMAIN.test(typed) && !typed.includes("@") ? `@${typed}` : undefined;
  if (domain && !chosen.includes(domain)) options.push({ address: domain, title: `Everyone at ${domain.slice(1)}`, subtitle: domain, domain: true });
  if (ADDRESS.test(typed) && !chosen.includes(typed) && !people.results.some(person => person.address === typed)) options.push({ address: typed, title: typed });
  for (const person of people.results) {
    if (!chosen.includes(person.address)) options.push({ address: person.address, title: person.name ?? person.address, ...(person.name ? { subtitle: person.address } : {}) });
  }
  return options;
}

/** Splits what was typed or pasted into senders, keeping back what isn't one. */
function parseSenders(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[,;\s]+/)) {
    // "Ada Lovelace <ada@contoso.com>" pastes as its address.
    const token = (/<([^<>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase().replace(/^mailto:/, "");
    if (token === "") continue;
    if (ADDRESS.test(token) || DOMAIN.test(token)) valid.push(token);
    else if (BARE_DOMAIN.test(token)) valid.push(`@${token}`);
    else invalid.push(token);
  }
  return { valid, invalid };
}

function peoplePicker(context: Context) {
  const { values, setValues, ui } = context;
  const chosen = list(values.senders);
  const options = people.open ? peopleOptions(chosen) : [];
  const active = Math.min(people.active, options.length - 1);
  const full = chosen.length >= MAX_SENDERS;
  const add = (addresses: string[], keep = "", invalid?: string) => {
    const next = [...new Set([...chosen, ...addresses])].slice(0, MAX_SENDERS);
    people = { ...people, query: keep, results: keep ? people.results : [], active: -1, open: keep !== "", invalid };
    setValues({ senders: json(next) });
  };
  const remove = (address: string) => setValues({ senders: json(chosen.filter(item => item !== address)) });
  const search = (query: string) => {
    clearTimeout(peopleTimer);
    const run = ++people.run;
    const term = query.trim();
    if (term.length < 2 || term.startsWith("@")) {
      people = { ...people, results: [], loading: false, failed: undefined };
      rerender();
      return;
    }
    people.loading = true;
    peopleTimer = setTimeout(() => {
      ui.searchPeople(term).then(results => {
        if (run !== people.run) return;
        for (const person of results) if (person.name) names.set(person.address, person.name);
        people = { ...people, results, loading: false, failed: undefined, active: people.active < 0 ? 0 : people.active };
        rerender();
      }, error => {
        if (run !== people.run) return;
        people = { ...people, results: [], loading: false, failed: errorMessage(error, "Couldn't look people up.") };
        rerender();
      });
    }, SEARCH_DEBOUNCE_MS);
    rerender();
  };
  const commit = (): boolean => {
    const { valid, invalid } = parseSenders(people.query);
    if (valid.length === 0 && invalid.length === 0) return false;
    if (invalid.length > 0) {
      const message = `"${invalid[0]}" isn't an email address or a domain like @contoso.com.`;
      if (valid.length > 0) {
        add(valid, invalid.join(" "), message);
      } else {
        people = { ...people, invalid: message };
        rerender();
      }
      return true;
    }
    add(valid);
    return true;
  };
  const describedBy = people.invalid ? "ol-people-error" : "ol-people-hint";
  return <div className="ol-panel ol-panel-padded">
    <label className="ol-label" htmlFor="ol-people-input">People and domains</label>
    <div className={`ol-chipbox${people.invalid ? " invalid" : ""}`}>
      {chosen.map(address => {
        const name = names.get(address);
        const domain = address.startsWith("@");
        return <span className={`ol-chip${domain ? " domain" : ""}`} title={address}>
          <span className="ol-chip-avatar" aria-hidden="true">{domain ? "@" : initials(name ?? address)}</span>
          <span className="ol-chip-label">{domain ? `Anyone at ${address.slice(1)}` : name ?? address}</span>
          <button type="button" className="ol-chip-remove" data-configurator-button="" onClick={() => remove(address)}>
            {icon("close", 12)}<span className="visually-hidden">{`Remove ${name ?? address}`}</span>
          </button>
        </span>;
      })}
      <input
        id="ol-people-input" className="ol-chip-input" type="text" data-configurator-input="ol-people"
        value={people.query} disabled={full} autocomplete="off" spellcheck="false"
        placeholder={full ? `You can add up to ${MAX_SENDERS}` : chosen.length ? "Add another…" : "Name, email address, or @domain"}
        role="combobox" aria-autocomplete="list" aria-expanded={options.length > 0 ? "true" : "false"}
        aria-controls="ol-people-options" aria-describedby={describedBy}
        aria-activedescendant={active >= 0 && options.length > 0 ? `ol-person-${active}` : undefined}
        aria-invalid={people.invalid ? "true" : "false"}
        onInput={(event: { currentTarget: { value: string } }) => {
          const text = event.currentTarget.value;
          // A paste of several addresses, or a typed separator, adds what is complete.
          if (/[,;]/.test(text) || /\s/.test(text.trim()) && parseSenders(text).invalid.length === 0 && /@/.test(text)) {
            people.query = text;
            if (commit()) return;
          }
          people = { ...people, query: text, open: text.trim() !== "", active: 0, invalid: undefined };
          search(text);
        }}
        onKeydown={(event: { key: string; preventDefault(): void }) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const count = peopleOptions(chosen).length;
            if (count === 0) return;
            const step = event.key === "ArrowDown" ? 1 : -1;
            people = { ...people, open: true, active: people.open ? (Math.max(active, -1) + step + count) % count : 0 };
            rerender();
          } else if (event.key === "Enter") {
            event.preventDefault();
            const option = options[active];
            if (option) add([option.address]);
            else commit();
          } else if (event.key === "Escape" && people.open) {
            event.preventDefault();
            people = { ...people, open: false };
            rerender();
          } else if (event.key === "Backspace" && people.query === "" && chosen.length > 0) {
            remove(chosen.at(-1)!);
          }
        }}
        onBlur={(event: { currentTarget: { ownerDocument: { activeElement: { id?: string } | null } } }) => {
          const document = event.currentTarget.ownerDocument;
          // A render puts focus straight back; only a real move away closes the list or keeps what was typed.
          setTimeout(() => {
            if (document.activeElement?.id === "ol-people-input" || !people.open && people.query === "") return;
            people = { ...people, open: false };
            if (parseSenders(people.query).invalid.length === 0 && people.query.trim() !== "") commit();
            else rerender();
          }, 0);
        }}
      />
    </div>
    {options.length > 0 ? <ul className="ol-options" id="ol-people-options" role="listbox" aria-label="Suggestions">
      {options.map((option, index) => <li
        id={`ol-person-${index}`} role="option" aria-selected={index === active ? "true" : "false"}
        className={`ol-option${index === active ? " active" : ""}`}
        onMousedown={(event: { preventDefault(): void }) => event.preventDefault()}
        onClick={() => {
          if (option.subtitle && !option.domain) names.set(option.address, option.title);
          add([option.address]);
        }}
      >
        <span className="ol-chip-avatar" aria-hidden="true">{option.domain ? "@" : initials(option.title)}</span>
        <span className="ol-option-text">
          <span className="ol-option-title">{option.title}</span>
          {option.subtitle && !option.domain ? <span className="ol-option-subtitle">{option.subtitle}</span> : null}
        </span>
        {option.domain ? <span className="ol-option-meta">Whole domain</span> : null}
      </li>)}
    </ul> : people.open && people.loading ? <p className="ol-hint ol-options-status">Looking people up…</p>
      : people.open && people.failed ? <p className="ol-hint ol-options-status">{people.failed}</p> : null}
    {people.invalid
      ? <p className="ol-error" id="ol-people-error" role="alert">{people.invalid}</p>
      : <p className="ol-hint" id="ol-people-hint">
        {"Pick someone you work with, type an address, or type @contoso.com for everyone at a company. Their mail in any folder counts, except Drafts, Junk Email and Deleted Items."}
      </p>}
  </div>;
}

function conversationPicker(context: Context) {
  const { values, setValues, ui } = context;
  const mailbox = mailboxOf(values);
  if (conversations === undefined || conversations.mailbox !== mailbox) {
    conversations = { mailbox, query: "", load: { state: "loading" }, run: 0 };
    fetchConversations(ui, 0);
  }
  const state = conversations;
  const load = state.load;
  const items = load.state === "ready" ? load.value.items : [];
  const searching = state.query.trim() !== "";
  const link = /^https?:\/\//i.test(state.query.trim());
  const chosenListed = items.some(item => item.id === values.conversationId);
  const row = (item: Conversation) => {
    const checked = item.id === values.conversationId;
    const id = `ol-conversation-${item.id}`;
    const meta = [item.from, when(item.receivedAt)].filter(Boolean).join(" · ");
    return <label className={`ol-row ol-row-tall${checked ? " selected" : ""}`} htmlFor={id}>
      <input type="radio" className="ol-radio" id={id} name="ol-conversation" data-configurator-input={id} checked={checked}
        onChange={() => setValues({ conversationId: item.id, conversationSubject: item.subject })} />
      <span className="ol-row-icon">{icon("conversation")}</span>
      <span className="ol-row-text">
        <span className="ol-row-title">{item.subject}</span>
        {meta ? <span className="ol-row-subtitle">{meta}</span> : null}
      </span>
    </label>;
  };
  return <div className="ol-panel">
    <div className="ol-panel-toolbar">
      <div className="input-wrapper ol-grow">
        {searchIcon()}
        <input
          className="input" type="search" data-configurator-input="ol-conversation-search" value={state.query}
          placeholder="Search subjects, or paste a link to a message" aria-label="Search conversations by subject, or paste an Outlook link"
          aria-controls="ol-conversations" autocomplete="off" spellcheck="false"
          onInput={(event: { currentTarget: { value: string } }) => {
            state.query = event.currentTarget.value;
            fetchConversations(ui, /^https?:\/\//i.test(state.query.trim()) ? 0 : SEARCH_DEBOUNCE_MS);
          }}
          onKeydown={(event: { key: string; preventDefault(): void }) => {
            if (event.key === "Enter") {
              event.preventDefault();
              fetchConversations(ui, 0);
            } else if (event.key === "Escape" && state.query !== "") {
              event.preventDefault();
              state.query = "";
              fetchConversations(ui, 0);
            }
          }}
        />
      </div>
    </div>
    {values.conversationId && !chosenListed ? <div className="ol-list ol-list-pinned">
      {row({ id: values.conversationId, subject: values.conversationSubject ?? "The chosen conversation" })}
    </div> : null}
    {load.state === "loading" ? <Fragment>
      <p className="ol-panel-notice" role="status">{link ? "Opening that link…" : searching ? "Searching…" : "Loading recent conversations…"}</p>
      {skeletonRows(3)}
    </Fragment> : null}
    {load.state === "failed" ? failedBox(load.message, () => fetchConversations(ui, 0)) : null}
    {load.state === "ready" ? <Fragment>
      {load.value.notice ? <p className="ol-panel-notice">{load.value.notice}</p> : null}
      {!searching && items.length > 0 ? <p className="ol-panel-notice">Recent conversations</p> : null}
      <div className="ol-list" id="ol-conversations" role="radiogroup" aria-label="Conversations">
        {items.length === 0
          ? <p className="ol-empty">{searching ? `No conversations have "${state.query.trim()}" in their subject.` : "This mailbox has no conversations yet."}</p>
          : items.map(row)}
      </div>
    </Fragment> : null}
  </div>;
}

function fetchConversations(ui: Rpc, delay: number): void {
  const state = conversations;
  if (state === undefined) return;
  clearTimeout(conversationTimer);
  const run = ++state.run;
  const start = () => {
    if (run !== state.run || conversations !== state) return;
    state.load = { state: "loading" };
    rerender();
    ui.findConversations(state.mailbox, state.query.trim()).then(value => {
      if (run !== state.run || conversations !== state) return;
      state.load = { state: "ready", value };
      rerender();
    }, error => {
      if (run !== state.run || conversations !== state) return;
      state.load = { state: "failed", message: errorMessage(error, "Couldn't search this mailbox.") };
      rerender();
    });
  };
  if (delay === 0) start();
  else conversationTimer = setTimeout(start, delay);
}

// -- permission -----------------------------------------------------------------------------------

const LEVELS: { value: Access; title: string; description: string }[] = [
  { value: "read", title: "Read only", description: "Mail can be read and searched. Nothing is changed." },
  { value: "draft", title: "Draft and organize", description: "Drafts can also be written, and messages flagged, categorized, marked as read and moved. Each change waits for your approval; you send drafts yourself." },
  { value: "send", title: "Send", description: "Mail can also be sent. Each message waits for your approval." },
];

function permissionStep(context: Context, status: Extract<Status, { state: "ready" }>) {
  const { values, setValues } = context;
  const allowed = allowedLevels(values);
  const current = accessOf(values);
  const top = LEVELS.find(option => option.value === allowed.at(-1));
  const limit = allowed.length < LEVELS.length && top
    ? values.mailboxMode === "shared" && status.levels.length > allowed.length
      ? `For shared mailboxes, this connection allows up to "${top.title}".`
      : status.limitedByDeployment
        ? `Your organization allows up to "${top.title}".`
        : `This connection allows up to "${top.title}". Reconnect Microsoft 365 to allow more.`
    : undefined;
  return <section className="ol-step">
    {segmented({
      group: "ol-access", label: "Permission", heading: true, value: current, describedBy: "ol-access-hint",
      options: LEVELS.filter(option => allowed.includes(option.value)).map(option => ({ value: option.value, title: option.title })),
      onChoose: value => setValues({ access: value }),
    })}
    <p className="ol-hint" id="ol-access-hint">
      {[LEVELS.find(option => option.value === current)?.description ?? "", limit ?? ""].filter(Boolean).join(" ")}
    </p>
  </section>;
}

// The frame's own styles, on the runtime's tokens, so it follows the host's light and dark themes.
const STYLE = `
/* Plain text inputs and hidden labels, which the runtime's components don't provide. */
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.input-wrapper { position: relative; }
.input { display: block; width: 100%; height: 36px; border: 1px solid var(--color-kumo-line); border-radius: 8px; padding: 8px 10px 8px 30px; background: var(--color-kumo-base); color: inherit; outline: none; font: inherit; font-size: 13px; line-height: 18px; letter-spacing: -0.25px; }
.input.no-icon { padding-left: 10px; }
.input:focus { border-color: var(--color-kumo-interact); box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-kumo-interact) 12%, transparent); }
.input.invalid { border-color: var(--color-kumo-danger); box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-kumo-danger) 10%, transparent); }
.input:disabled { background: var(--color-kumo-elevated); color: var(--text-color-kumo-subtle); cursor: not-allowed; }
.search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; color: var(--text-color-kumo-inactive); pointer-events: none; line-height: 0; }

.ol {
  --ol-accent: oklch(51% 0.15 252);
  --ol-yes: oklch(53% 0.13 152);
  display: grid; gap: 22px; min-width: 0;
}
@media (prefers-color-scheme: dark) {
  .ol { --ol-accent: oklch(74% 0.12 252); --ol-yes: oklch(74% 0.13 152); }
}
.ol { --ol-accent-tint: color-mix(in oklab, var(--ol-accent) 8%, var(--color-kumo-base)); --ol-accent-line: color-mix(in oklab, var(--ol-accent) 55%, var(--color-kumo-line)); }
.ol button { font: inherit; color: inherit; }
.ol-step { display: grid; gap: 8px; min-width: 0; margin: 0; border: 0; padding: 0; }
.ol-step-title { display: flex; align-items: baseline; gap: 8px; margin: 0 0 2px; padding: 0; color: var(--text-color-kumo-default); font-size: 12px; font-weight: 600; line-height: 16px; }
.ol-optional { color: var(--text-color-kumo-subtle); font-weight: 400; }
.ol-step-hint, .ol-hint { margin: 0; color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; }
.ol-error { margin: 0; color: var(--color-kumo-danger); font-size: 12px; line-height: 16px; }
.ol-label { color: var(--text-color-kumo-default); font-size: 12px; font-weight: 500; line-height: 16px; }
.ol-inline { display: flex; gap: 8px; align-items: center; min-width: 0; }
.ol-grow { flex: 1; min-width: 0; }
.ol-loading { display: flex; align-items: center; gap: 8px; padding: 18px 2px; color: var(--text-color-kumo-subtle); }

.ol-cards { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.ol-card { position: relative; display: flex; align-items: flex-start; gap: 10px; min-width: 0; border: 1px solid var(--color-kumo-line); border-radius: 10px; padding: 10px 12px 10px 10px; background: var(--color-kumo-base); cursor: pointer; transition: border-color .12s ease, background-color .12s ease; }
.ol-card:hover { background: var(--color-kumo-elevated); }
.ol-card.selected { border-color: var(--ol-accent-line); background: var(--ol-accent-tint); box-shadow: inset 0 0 0 1px var(--ol-accent-line); }
.ol-card:has(input:focus-visible) { outline: 2px solid var(--ol-accent); outline-offset: 1px; }
.ol-card-icon { display: flex; flex-shrink: 0; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 7px; color: var(--ol-accent); background: color-mix(in oklab, var(--ol-accent) 11%, var(--color-kumo-base)); }
.ol-card.selected .ol-card-icon { background: var(--color-kumo-base); }
.ol-card-text { display: grid; flex: 1; gap: 1px; min-width: 0; }
.ol-card-title { color: var(--text-color-kumo-default); font-size: 13px; font-weight: 600; line-height: 18px; letter-spacing: -0.15px; }
.ol-card-description { overflow-wrap: anywhere; color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; }
.ol-radio { appearance: none; -webkit-appearance: none; flex-shrink: 0; width: 16px; height: 16px; margin: 6px 0 0; border: 1.5px solid var(--color-kumo-interact); border-radius: 50%; background: var(--color-kumo-base); cursor: inherit; }
.ol-row .ol-radio { margin: 0; }
.ol-radio:checked { border-color: var(--ol-accent); background: var(--ol-accent); box-shadow: inset 0 0 0 3.5px var(--color-kumo-base); }
.ol-radio:focus { outline: none; }

.ol-shared-entry { display: grid; gap: 6px; }
.ol-opened { display: flex; align-items: center; gap: 10px; min-width: 0; border: 1px solid var(--color-kumo-line); border-radius: 10px; padding: 8px 8px 8px 10px; background: var(--color-kumo-base); }
.ol-opened-text { display: grid; flex: 1; min-width: 0; }
.ol-opened-title { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.ol-opened-subtitle { overflow: hidden; color: var(--text-color-kumo-subtle); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.ol-verified { display: inline-flex; flex-shrink: 0; align-items: center; gap: 4px; color: var(--ol-yes); font-size: 12px; font-weight: 500; }
.ol-avatar, .ol-chip-avatar { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; border-radius: 50%; color: var(--ol-accent); background: color-mix(in oklab, var(--ol-accent) 14%, var(--color-kumo-base)); font-weight: 600; letter-spacing: .02em; }
.ol-avatar { width: 30px; height: 30px; font-size: 11.5px; }
.ol-chip-avatar { width: 20px; height: 20px; font-size: 9.5px; }

.ol-panel { display: grid; min-width: 0; border: 1px solid var(--color-kumo-line); border-radius: 10px; background: var(--color-kumo-base); contain: inline-size; }
.ol-panel-padded { gap: 6px; padding: 10px; }
.ol-panel-toolbar { padding: 8px; }
.ol-panel-toolbar .input { height: 32px; }
.ol-panel-notice { margin: 0; border-top: 1px solid var(--color-kumo-line); padding: 7px 12px; color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; }
.ol-panel-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 14px; border-top: 1px solid var(--color-kumo-line); padding: 8px 12px; }
.ol-chosen { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--ol-accent); }
.ol-chosen strong { overflow: hidden; color: var(--text-color-kumo-default); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.ol-check { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; cursor: pointer; }
.ol-check input { width: 14px; height: 14px; margin: 0; accent-color: var(--ol-accent); }
.ol-list { position: relative; display: grid; align-content: start; gap: 1px; max-height: 264px; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid var(--color-kumo-line); padding: 4px; }
.ol-list-pinned { max-height: none; }
.ol-row { display: flex; align-items: center; gap: 9px; min-width: 0; min-height: 34px; border-radius: 7px; padding: 4px 10px 4px 8px; cursor: pointer; }
.ol-row-tall { min-height: 44px; }
.ol-row:hover { background: var(--color-kumo-elevated); }
.ol-row.selected { background: var(--ol-accent-tint); }
.ol-row:has(input:focus-visible) { box-shadow: inset 0 0 0 2px var(--ol-accent); }
.ol-row-icon { display: flex; flex-shrink: 0; color: var(--text-color-kumo-subtle); }
.ol-row.selected .ol-row-icon { color: var(--ol-accent); }
.ol-row-text { display: grid; flex: 1; min-width: 0; }
.ol-row-title { overflow: hidden; color: var(--text-color-kumo-default); font-weight: 500; line-height: 18px; letter-spacing: -0.15px; text-overflow: ellipsis; white-space: nowrap; }
.ol-row-subtitle { overflow: hidden; color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
.ol-skeleton-row { cursor: default; }
.ol-skeleton-row:hover { background: none; }
.ol-skeleton { display: block; height: 11px; border-radius: 4px; background: var(--color-kumo-tint); animation: ol-pulse 1.3s ease-in-out infinite; }
@keyframes ol-pulse { 50% { opacity: .45; } }
.ol-spinner { display: inline-block; flex-shrink: 0; width: 12px; height: 12px; border: 1.5px solid var(--color-kumo-line); border-top-color: var(--text-color-kumo-subtle); border-radius: 50%; animation: ol-spin .7s linear infinite; }
@keyframes ol-spin { to { transform: rotate(360deg); } }
.ol-empty { margin: 0; padding: 14px 10px; color: var(--text-color-kumo-subtle); font-size: 12.5px; text-align: center; }
.ol-failed { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--color-kumo-line); padding: 10px 12px; }
.ol-panel-padded .ol-failed, .ol-subfield .ol-failed { border-top: 0; padding: 0; }
.ol-failed-text { margin: 0; color: var(--color-kumo-danger); font-size: 12.5px; line-height: 17px; }

.ol-chipbox { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 36px; border: 1px solid var(--color-kumo-line); border-radius: 8px; padding: 4px 6px; background: var(--color-kumo-base); cursor: text; }
.ol-chipbox.invalid { border-color: var(--color-kumo-danger); }
.ol-chipbox:focus-within { border-color: var(--color-kumo-interact); box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-kumo-interact) 35%, transparent); }
.ol-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; height: 26px; border-radius: 999px; padding: 0 3px 0 3px; background: var(--color-kumo-tint); font-size: 12.5px; }
.ol-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ol-chip-remove { display: inline-flex; flex-shrink: 0; width: 20px; height: 20px; align-items: center; justify-content: center; border: 0; border-radius: 50%; padding: 0; background: transparent; color: var(--text-color-kumo-subtle); cursor: pointer; }
.ol-chip-remove:hover { background: var(--color-kumo-base); color: var(--text-color-kumo-default); }
.ol-chip-remove:focus-visible { outline: 2px solid var(--ol-accent); outline-offset: 0; }
.ol-chip-input { flex: 1 1 160px; min-width: 120px; height: 26px; border: 0; padding: 0 4px; background: transparent; color: inherit; outline: none; font: inherit; font-size: 13px; }
.ol-chip-input::placeholder { color: var(--text-color-kumo-inactive); }
.ol-options { display: grid; gap: 1px; margin: 0; border: 1px solid var(--color-kumo-line); border-radius: 8px; padding: 4px; list-style: none; background: var(--color-kumo-base); box-shadow: 0 2px 6px rgb(0 0 0 / 6%); }
.ol-option { display: flex; align-items: center; gap: 8px; min-height: 34px; border-radius: 6px; padding: 4px 8px; cursor: pointer; }
.ol-option:hover, .ol-option.active { background: var(--color-kumo-tint); }
.ol-option-text { display: grid; flex: 1; min-width: 0; }
.ol-option-title { overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.ol-option-subtitle, .ol-option-meta { overflow: hidden; color: var(--text-color-kumo-subtle); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.ol-options-status { padding: 2px 2px; }

.ol-subfield { display: grid; gap: 6px; min-width: 0; }
.ol-segmented { display: inline-flex; flex-wrap: wrap; justify-self: start; gap: 2px; border-radius: 9px; padding: 2px; background: var(--color-kumo-tint); }
.ol-segment { display: inline-flex; height: 28px; align-items: center; border-radius: 7px; padding: 0 11px; color: var(--text-color-kumo-subtle); font-size: 12.5px; font-weight: 500; cursor: pointer; }
.ol-segment:hover { color: var(--text-color-kumo-default); }
.ol-segment.selected { color: var(--text-color-kumo-default); background: var(--color-kumo-base); box-shadow: 0 1px 2px rgb(0 0 0 / 10%), 0 0 0 1px var(--color-kumo-line); }
.ol-segment:has(input:focus-visible) { outline: 2px solid var(--ol-accent); outline-offset: 1px; }

@media (max-width: 460px) {
  .ol-opened { flex-wrap: wrap; }
  .ol-cards { grid-template-columns: 1fr; }
  .ol-verified { order: 3; }
  .ol-segment { padding: 0 8px; font-size: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .ol-skeleton, .ol-spinner { animation: none; }
  .ol-card { transition: none; }
}
`;

// -- the frame ----------------------------------------------------------------------------------

function connectionNotices(context: Context) {
  switch (connection.state) {
    case "needsAccess":
    case "waiting":
      return <Fragment>
        <Notice>
          {"This Microsoft 365 connection hasn't been allowed to open Outlook yet. Allow it, then choose what to connect."}
        </Notice>
        <div>
          <Button variant="primary" disabled={connection.state === "waiting"} onClick={() => void allowAccess(context)}>
            {connection.state === "waiting" ? "Waiting for the pop-up…" : "Allow access"}
          </Button>
        </div>
      </Fragment>;
    case "unavailable":
    case "failed":
      return <Fragment>
        <Notice tone="error">{connection.message}</Notice>
        {connection.state === "failed" ? <div>
          <Button variant="secondary" onClick={() => {
            asked = false;
            connection = { state: "loading" };
            loadStatus(context);
            rerender();
          }}>Try again</Button>
        </div> : null}
      </Fragment>;
    default:
      return null;
  }
}

export default {
  initial: { mailboxMode: "mine", target: "all", access: "read" },

  isReady({ values }) {
    return connection.state === "ready" && "draft" in draftOf(values);
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const located = await ui.locate(resourceUrl);
    if (located === null) return {};
    const target: Target = located.conversation ? "conversation" : located.folder ? "folder" : located.senders?.length ? "people" : "all";
    if (located.mailbox) {
      shared = { ...shared, input: located.mailbox.address };
    }
    return {
      mailboxMode: located.mailbox ? "shared" : "mine",
      mailbox: located.mailbox?.address ?? null,
      mailboxName: located.mailbox?.name ?? null,
      target,
      folderId: located.folder?.id ?? null,
      folderPath: located.folder?.path ?? null,
      subfolders: located.folder && !located.folder.subfolders ? "0" : null,
      senders: json(located.senders ?? []),
      conversationId: located.conversation?.id ?? null,
      conversationSubject: located.conversation?.subject ?? null,
      access: located.access,
    };
  },

  resourceUrl({ values, ui }) {
    const result = draftOf(values);
    if (!("draft" in result)) throw new Error(result.missing);
    return ui.resourceUrlFor(result.draft);
  },

  render(context) {
    rerender = () => context.setValues({});
    loadStatus(context);
    const ready = connection.state === "ready" ? connection : undefined;
    return <Section>
      <style>{STYLE}</style>
      <div className="ol">
        {connectionNotices(context)}
        {connection.state === "loading" ? <div className="ol-loading" role="status">
          <span className="ol-spinner" aria-hidden="true" />Opening your mailbox…
        </div> : null}
        {ready ? mailboxStep(context, ready) : null}
        {/* Everything below belongs to one mailbox, so it waits until a shared one has been opened. */}
        {ready && (context.values.mailboxMode !== "shared" || context.values.mailbox) ? <Fragment>
          {targetStep(context)}
          {permissionStep(context, ready)}
        </Fragment> : null}
      </div>
    </Section>;
  },
} satisfies ConfiguratorUISpec<Rpc, Values>;
