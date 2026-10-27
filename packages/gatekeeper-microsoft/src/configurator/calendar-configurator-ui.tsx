import {
  Button, Fragment, h, Notice, Section,
  type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  CalendarColleague as Colleague,
  CalendarConfiguratorAccess as Access,
  CalendarConfiguratorDetails as Details,
  CalendarConfiguratorRpc as Rpc,
  CalendarConfiguratorStatus as Status,
  CalendarDraft as Draft,
  CalendarRow,
} from "./calendar-configurator-types";

/** Must equal `CALENDAR_RESOURCE.urlPattern` in microsoft-env.ts. */
const CALENDAR_GRANT = "https://outlook.office.com/calendar/*";
const ACCESS_POLL_MS = 2_000;
const ACCESS_WAIT_MS = 3 * 60_000;
const ADDRESS = /^[^\s@<>()",;:/\\]+@[^\s@<>()",;:/\\]+\.[^\s@<>()",;:/\\]+$/;
const COLOR = /^#[0-9a-f]{6}$/;
const ACCESS_ORDER: Access[] = ["read", "edit", "schedule"];

type Target = "all" | "calendar" | "freeTime" | "availability";

type Values = {
  target?: Target | null;
  /** Whose calendar, for one calendar: the user's own, or a colleague's. */
  ownerMode?: "mine" | "colleague" | null;
  /** The colleague, once their calendars have been opened. */
  owner?: string | null;
  ownerName?: string | null;
  calendarId?: string | null;
  calendarName?: string | null;
  /** "1" when the user can't change the chosen calendar's events. */
  calendarReadOnly?: string | null;
  details?: Details | null;
  /** "show" to show private events in full; absent shows them as busy time. */
  privateEvents?: "show" | null;
  access?: Access | null;
};

type Context = ConfiguratorUIRenderContext<Rpc, Values>;
type Ready = Extract<Status, { state: "ready" }>;

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

/** Calendar lists: the user's own under "", a colleague's under their address. */
const calendarLists = new Map<string, Load<CalendarRow[]>>();
const colleagueNotices = new Map<string, string>();
let colleague: { input: string; state: "idle" | "checking" | "failed"; message?: string; run: number } = { input: "", state: "idle", run: 0 };
/** Whether "More options" is open. It opens itself while anything in it differs from its default. */
let moreOpen = false;


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
 * Asks for calendar access from the click, so the browser lets Workshop open the consent pop-up,
 * then waits for the grant to land.
 */
async function allowAccess({ ensureResources, ui }: Context): Promise<void> {
  const run = ++generation;
  const access = ensureResources([CALENDAR_GRANT]);
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

const targetOf = (values: Values): Target => values.target ?? "all";
const detailsOf = (values: Values): Details => values.details ?? "full";
const colleagueOf = (values: Values) => values.ownerMode === "colleague" ? values.owner ?? null : null;

/** Why a level isn't offered for what's chosen, or nothing when it is. */
function levelLimit(values: Values, status: Ready, level: Access): string | undefined {
  const target = targetOf(values);
  if (target === "freeTime" || target === "availability") return level === "read" ? undefined : "Free/busy can only be read.";
  if (target === "calendar") {
    if (level !== "read" && detailsOf(values) !== "full") return "Changes need all details, under More options.";
    if (level !== "read" && values.calendarReadOnly === "1") return `You can't change events in "${values.calendarName ?? "this calendar"}" yourself.`;
  }
  const colleagueMode = target === "calendar" && values.ownerMode === "colleague";
  const allowed = colleagueMode ? status.sharedLevels : status.levels;
  if (allowed.includes(level)) return undefined;
  const top = LEVELS.find(option => option.value === allowed.at(-1))?.title;
  if (top === undefined) return colleagueMode ? "This connection can't open colleagues' calendars." : "This connection can't open calendars.";
  if (colleagueMode && status.levels.includes(level)) return `For colleagues' calendars, this connection allows up to "${top}".`;
  if (status.limitedByDeployment) return `Your organization allows up to "${top}".`;
  return `This connection allows up to "${top}". Reconnect Microsoft 365 to allow more.`;
}

/** The chosen level, or the most allowed below it when it isn't allowed. */
function accessOf(values: Values, status: Ready): Access | undefined {
  const allowed = ACCESS_ORDER.filter(level => levelLimit(values, status, level) === undefined);
  const wanted = values.access ?? "read";
  if (allowed.includes(wanted)) return wanted;
  return allowed.filter(level => ACCESS_ORDER.indexOf(level) < ACCESS_ORDER.indexOf(wanted)).at(-1) ?? allowed[0];
}

/** What the values bind, or what is still missing. */
function draftOf(values: Values): { draft: Draft } | { missing: string } {
  if (connection.state !== "ready") return { missing: "" };
  const status = connection;
  switch (targetOf(values)) {
    case "availability":
      return { draft: { kind: "availability" } };
    case "freeTime":
      return { draft: { kind: "calendar", calendarId: "default", details: "freeBusy", privateEvents: "busy", access: "read" } };
    case "all": {
      const access = accessOf(values, status);
      return access === undefined ? { missing: "This connection can't open calendars." } : { draft: { kind: "all", access } };
    }
    case "calendar": {
      if (values.ownerMode === "colleague" && !values.owner) return { missing: "Open a colleague's calendars to continue." };
      if (!values.calendarId) return { missing: "Choose a calendar." };
      const access = accessOf(values, status);
      if (access === undefined) return { missing: "This connection can't open that calendar." };
      const details = detailsOf(values);
      return {
        draft: {
          kind: "calendar", ...(colleagueOf(values) ? { owner: colleagueOf(values)! } : {}), calendarId: values.calendarId, details,
          privateEvents: details === "full" && values.privateEvents === "show" ? "show" : "busy", access,
        },
      };
    }
  }
}

/** Everything that belongs to one owner, cleared when the owner changes. */
const CALENDAR_FIELDS = { calendarId: null, calendarName: null, calendarReadOnly: null } as const;

// -- formatting -------------------------------------------------------------------------------

function initials(text: string): string {
  const words = text.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words.at(-1)![0] : "")).toUpperCase() || "?";
}

// -- icons ------------------------------------------------------------------------------------

const ICONS: Record<string, string> = {
  all: "M2.75 4.75h8.5v8.5h-8.5Z M2.75 7.25h8.5 M5 3.25v2.5 M9 3.25v2.5 M4.75 2.75h8.5v8.5",
  calendar: "M2.25 3.75h11.5v10H2.25Z M2.25 6.75h11.5 M5 2.25v3 M11 2.25v3",
  freeTime: "M8 1.75a6.25 6.25 0 1 0 0 12.5A6.25 6.25 0 0 0 8 1.75Z M8 4.5V8l2.5 1.5",
  availability: "M6 7.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z M1.75 13.25c0-2.35 1.9-4 4.25-4s4.25 1.65 4.25 4 M10.5 2.9a2.25 2.25 0 0 1 0 4.2 M12 9.6c1.35.5 2.25 1.85 2.25 3.65",
  chevron: "M6 3.5 10.5 8 6 12.5",
};

function icon(name: string, size = 16) {
  return <svg viewBox="0 0 16 16" width={String(size)} height={String(size)} aria-hidden="true" focusable="false">
    <path d={ICONS[name] ?? ICONS.calendar} fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
  </svg>;
}

// -- pieces -----------------------------------------------------------------------------------

/** A radio card. The native radio carries the semantics and the arrow keys; the card is its label. */
function card(props: {
  group: string; value: string; checked: boolean; title: string; description: string; icon: string;
  onChoose: () => void;
}) {
  const id = `${props.group}-${props.value}`;
  return <label className={`cal-card${props.checked ? " selected" : ""}`} htmlFor={id}>
    <span className="cal-card-icon">{icon(props.icon)}</span>
    <span className="cal-card-text">
      <span className="cal-card-title">{props.title}</span>
      <span className="cal-card-description" id={`${id}-description`}>{props.description}</span>
    </span>
    <input
      type="radio" className="cal-radio" id={id} name={props.group} value={props.value}
      data-configurator-input={id} checked={props.checked}
      aria-describedby={`${id}-description`}
      onChange={() => props.onChoose()}
    />
  </label>;
}

/** A step of the form: a group of choices under its title. */
function step(title: string, children: unknown) {
  return <fieldset className="cal-step">
    <legend className="cal-step-title">{title}</legend>
    {children}
  </fieldset>;
}

function skeletonRows(count: number) {
  return <div className="cal-list" aria-busy="true" aria-label="Loading">
    {Array.from({ length: count }, (_, index) => <div className="cal-row cal-skeleton-row">
      <span className="cal-skeleton" style={{ width: "12px", height: "12px", borderRadius: "4px" }} />
      <span className="cal-skeleton" style={{ width: `${46 + (index * 17) % 34}%` }} />
    </div>)}
  </div>;
}

function failedBox(message: string, retry: () => void) {
  return <div className="cal-failed">
    <p className="cal-failed-text" role="alert">{message}</p>
    <Button variant="secondary" onClick={retry}>Try again</Button>
  </div>;
}

/** A compact radio group. Each option is a native radio, so the arrow keys move between them. */
function segmented<T extends string>(props: {
  group: string; label: string; options: { value: T; title: string; disabled?: boolean }[]; value: T | undefined;
  onChoose: (value: T) => void; describedBy?: string; heading?: boolean;
}) {
  return <div className="cal-subfield" role="radiogroup" aria-labelledby={`${props.group}-label`}>
    <span className={props.heading ? "cal-step-title" : "cal-label"} id={`${props.group}-label`}>{props.label}</span>
    <div className="cal-segmented">
      {props.options.map(option => {
        const id = `${props.group}-${option.value}`;
        const checked = option.value === props.value;
        return <label className={`cal-segment${checked ? " selected" : ""}${option.disabled ? " disabled" : ""}`} htmlFor={id}>
          <input type="radio" className="visually-hidden" id={id} name={props.group} data-configurator-input={id}
            checked={checked} disabled={option.disabled} aria-describedby={props.describedBy}
            onChange={() => props.onChoose(option.value)} />
          {option.title}
        </label>;
      })}
    </div>
  </div>;
}

// -- step 1: what to connect ----------------------------------------------------------------------

const TARGETS: { value: Target; title: string; description: string }[] = [
  { value: "all", title: "All your calendars", description: "Every event, including private ones." },
  { value: "calendar", title: "One calendar", description: "Yours, or one a colleague shares with you." },
  { value: "freeTime", title: "Your free time", description: "When you're busy, without event details." },
  { value: "availability", title: "Colleagues' availability", description: "When people in your organization are free." },
];

/** Shown in place of options the grant can't open. Opening them never means signing in as their owner. */
const SHARED_CALENDARS_HINT = "Calendars others share with you open through your own account, once an admin approves more Microsoft 365 permissions and you reconnect.";

function targetStep({ values, setValues }: Context) {
  const target = targetOf(values);
  return step("What to connect", <div className="cal-cards cal-cards-two" role="radiogroup" aria-label="What to connect">
    {TARGETS.map(option => card({
      group: "cal-target", value: option.value, checked: target === option.value, icon: option.value,
      title: option.title, description: option.description, onChoose: () => setValues({ target: option.value }),
    }))}
  </div>);
}

// -- step 2: the calendar ---------------------------------------------------------------------------

function calendarStep(context: Context, status: Ready) {
  const { values, setValues } = context;
  const mode = values.ownerMode ?? "mine";
  const colleaguesAllowed = status.sharedLevels.length > 0;
  const choose = (next: "mine" | "colleague") => {
    if (next === mode) return;
    colleague = { ...colleague, state: "idle", message: undefined };
    setValues({ ownerMode: next, owner: null, ownerName: null, ...CALENDAR_FIELDS });
  };
  return step("Calendar", <Fragment>
    {/* A binding being edited keeps its colleague's calendar on show even after the grant narrows. */}
    {colleaguesAllowed || mode === "colleague" ? segmented({
      group: "cal-owner", label: "Whose", value: mode, onChoose: choose,
      options: [{ value: "mine", title: "Yours" }, { value: "colleague", title: "A colleague's", disabled: !colleaguesAllowed }],
    }) : null}
    {mode === "colleague" && !values.owner ? colleagueEntry(context) : null}
    {mode === "colleague" && values.owner ? openedColleague(context) : null}
    {mode === "mine" || values.owner ? calendarPicker(context) : null}
    {colleaguesAllowed ? null : <p className="cal-hint">{SHARED_CALENDARS_HINT}</p>}
  </Fragment>);
}

function colleagueEntry(context: Context) {
  const checking = colleague.state === "checking";
  const invalid = colleague.state === "failed";
  return <div className="cal-subfield">
    <label className="cal-label" htmlFor="cal-colleague-input">Colleague's email address</label>
    <div className="cal-inline">
      <div className="input-wrapper cal-grow">
        <input
          id="cal-colleague-input" className={`input no-icon${invalid ? " invalid" : ""}`} type="email" inputmode="email"
          data-configurator-input="cal-colleague-input" value={colleague.input} placeholder="sarah@contoso.com"
          autocomplete="off" spellcheck="false" aria-invalid={invalid ? "true" : "false"}
          aria-describedby={invalid ? "cal-colleague-error" : "cal-colleague-hint"}
          onInput={(event: { currentTarget: { value: string } }) => { colleague.input = event.currentTarget.value; }}
          onKeydown={(event: { key: string; preventDefault(): void }) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void openColleague(context);
            }
          }}
        />
      </div>
      <Button variant="primary" disabled={checking} onClick={() => void openColleague(context)}>{checking ? "Opening…" : "Open"}</Button>
    </div>
    {invalid
      ? <p className="cal-error" id="cal-colleague-error" role="alert">{colleague.message}</p>
      : <p className="cal-hint" id="cal-colleague-hint">{checking ? "Finding the calendars they've shared with you…" : "We'll list the calendars they've shared with you."}</p>}
  </div>;
}

async function openColleague({ ui, setValues }: Context): Promise<void> {
  const address = colleague.input.trim().toLowerCase();
  const fail = (message: string) => {
    colleague = { ...colleague, state: "failed", message };
    rerender();
  };
  if (address === "") return fail("Enter your colleague's email address, like sarah@contoso.com.");
  if (!ADDRESS.test(address)) return fail(`"${address}" isn't an email address. Enter one like sarah@contoso.com.`);
  if (connection.state === "ready" && address === connection.me.address.toLowerCase()) return fail("That's you. Choose Yours above instead.");
  const run = ++colleague.run;
  colleague = { ...colleague, input: address, state: "checking", message: undefined };
  rerender();
  try {
    const opened: Colleague = await ui.openColleague(address);
    if (run !== colleague.run) return;
    colleague = { input: opened.address, state: "idle", run };
    calendarLists.set(opened.address, { state: "ready", value: opened.calendars });
    if (opened.notice) colleagueNotices.set(opened.address, opened.notice);
    else colleagueNotices.delete(opened.address);
    // A colleague with one calendar has nothing to choose between.
    const only = opened.calendars.length === 1 ? opened.calendars[0]! : undefined;
    setValues({
      owner: opened.address, ownerName: opened.name,
      ...(only ? { calendarId: only.id, calendarName: only.name, calendarReadOnly: only.canEdit ? null : "1" } : CALENDAR_FIELDS),
    });
  } catch (error) {
    if (run !== colleague.run) return;
    fail(errorMessage(error, "Their calendars couldn't be opened."));
  }
}

function openedColleague({ values, setValues }: Context) {
  const name = values.ownerName && values.ownerName !== values.owner ? values.ownerName : undefined;
  return <div className="cal-opened">
    <span className="cal-avatar" aria-hidden="true">{initials(name ?? values.owner ?? "")}</span>
    <span className="cal-opened-text">
      <span className="cal-opened-title">{name ?? values.owner}</span>
      {name ? <span className="cal-opened-subtitle">{values.owner}</span> : null}
    </span>
    <Button variant="secondary" onClick={() => {
      colleague = { ...colleague, input: values.owner ?? "", state: "idle", message: undefined };
      setValues({ owner: null, ownerName: null, ...CALENDAR_FIELDS });
    }}>Change</Button>
  </div>;
}

function calendarPicker(context: Context) {
  const { values, setValues, ui } = context;
  const owner = colleagueOf(values);
  const key = owner ?? "";
  const load = loaded(calendarLists, key, () => owner === null ? ui.listCalendars() : ui.openColleague(owner).then(opened => {
    if (opened.notice) colleagueNotices.set(owner, opened.notice);
    return opened.calendars;
  }), owner === null ? "Couldn't list your calendars." : "Couldn't list their calendars.");
  const choose = (calendar: CalendarRow) => setValues({ calendarId: calendar.id, calendarName: calendar.name, calendarReadOnly: calendar.canEdit ? null : "1" });
  const noticeText = owner === null ? undefined : colleagueNotices.get(owner);
  return <div className="cal-panel">
    {load.state === "loading" ? skeletonRows(3) : null}
    {load.state === "failed" ? failedBox(load.message, () => {
      calendarLists.delete(key);
      rerender();
    }) : null}
    {load.state === "ready" ? <Fragment>
      <div className="cal-list" id="cal-calendars" role="radiogroup" aria-label="Calendars">
        {load.value.length === 0
          ? <p className="cal-empty">{owner === null ? "You have no calendars to choose from." : "They haven't shared a calendar you can open."}</p>
          : load.value.map(calendar => {
            const checked = calendar.id === values.calendarId;
            const id = `cal-calendar-${calendar.id}`;
            const badges = [calendar.isDefault ? "Main calendar" : "", calendar.canEdit ? "" : "Read only"].filter(Boolean);
            return <label className={`cal-row${checked ? " selected" : ""}`} htmlFor={id}>
              <span className="cal-swatch" style={{ backgroundColor: calendar.color && COLOR.test(calendar.color) ? calendar.color : "var(--cal-accent)" }} aria-hidden="true" />
              <span className="cal-row-text">
                <span className="cal-row-title">{calendar.name}</span>
              </span>
              {badges.length ? <span className="cal-row-meta">{badges.map(badge => <span className="cal-badge">{badge}</span>)}</span> : null}
              <input type="radio" className="cal-radio" id={id} name="cal-calendar" data-configurator-input={id} checked={checked}
                aria-label={[calendar.name, ...badges].join(", ")} onChange={() => choose(calendar)} />
            </label>;
          })}
      </div>
      {noticeText ? <p className="cal-panel-notice">{noticeText}</p> : null}
    </Fragment> : null}
  </div>;
}

// -- permission -----------------------------------------------------------------------------------

const LEVELS: { value: Access; title: string; description: string }[] = [
  { value: "read", title: "Read only", description: "Nothing can be changed." },
  { value: "edit", title: "Add and change", description: "Events can be added, moved and removed. Each change waits for your approval." },
  { value: "schedule", title: "Also invite", description: "Invitations can also be sent and answered. Each one waits for your approval." },
];

function permissionStep({ values, setValues }: Context, status: Ready) {
  const current = accessOf(values, status);
  const limits = ACCESS_ORDER.map(level => levelLimit(values, status, level));
  const reason = limits.find((limit): limit is string => limit !== undefined);
  return <section className="cal-step">
    {segmented({
      group: "cal-access", label: "Permission", heading: true, value: current, describedBy: "cal-access-hint",
      options: LEVELS.map((level, index) => ({ value: level.value, title: level.title, disabled: limits[index] !== undefined })),
      onChoose: value => setValues({ access: value }),
    })}
    <p className="cal-hint" id="cal-access-hint">
      {[LEVELS.find(level => level.value === current)?.description ?? "", reason ?? ""].filter(Boolean).join(" ")}
    </p>
  </section>;
}

// -- more options: event details ------------------------------------------------------------------

const DETAILS: { value: Details; title: string; description: string }[] = [
  { value: "freeBusy", title: "Free/busy", description: "Only when it's busy." },
  { value: "limited", title: "Titles and places", description: "Each event's title and location." },
  { value: "full", title: "All details", description: "Titles, places, descriptions, attendees and join links." },
];

function moreOptions({ values, setValues }: Context) {
  const details = detailsOf(values);
  const showPrivate = details === "full" && values.privateEvents === "show";
  const summary = [DETAILS.find(option => option.value === details)!.title, showPrivate ? "private events shown" : ""].filter(Boolean).join(" · ");
  const toggle = <button type="button" className="cal-disclosure" id="cal-more" data-configurator-button="" aria-expanded={moreOpen ? "true" : "false"}
    aria-controls="cal-more-panel" onClick={() => {
      moreOpen = !moreOpen;
      rerender();
    }}>
    <span className="cal-disclosure-chevron" aria-hidden="true">{icon("chevron", 14)}</span>
    <span className="cal-step-title">More options</span>
    <span className="cal-hint">{summary}</span>
  </button>;
  if (!moreOpen) return <section className="cal-step">{toggle}</section>;
  return <section className="cal-step">
    {toggle}
    <div className="cal-more" id="cal-more-panel">
      {segmented({
        group: "cal-details", label: "Event details", value: details, describedBy: "cal-details-hint",
        options: DETAILS, onChoose: value => setValues({ details: value }),
      })}
      <p className="cal-hint" id="cal-details-hint">{DETAILS.find(option => option.value === details)!.description}</p>
      {details === "full" ? <label className="cal-check" htmlFor="cal-private">
        <input type="checkbox" id="cal-private" data-configurator-input="cal-private" checked={showPrivate}
          onChange={(event: { currentTarget: { checked: boolean } }) => setValues({ privateEvents: event.currentTarget.checked ? "show" : null })} />
        <span>Show private events in full</span>
      </label> : null}
    </div>
  </section>;
}

// The frame's own styles, on the runtime's tokens, so it follows the host's light and dark themes.
// The accent matches the Outlook configurator's.
const STYLE = `
/* Plain text inputs and hidden labels, which the runtime's components don't provide. */
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.input-wrapper { position: relative; }
.input { display: block; width: 100%; height: 36px; border: 1px solid var(--color-kumo-line); border-radius: 8px; padding: 8px 10px 8px 30px; background: var(--color-kumo-base); color: inherit; outline: none; font: inherit; font-size: 13px; line-height: 18px; letter-spacing: -0.25px; }
.input.no-icon { padding-left: 10px; }
.input:focus { border-color: var(--color-kumo-interact); box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-kumo-interact) 12%, transparent); }
.input.invalid { border-color: var(--color-kumo-danger); box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-kumo-danger) 10%, transparent); }
.input:disabled { background: var(--color-kumo-elevated); color: var(--text-color-kumo-subtle); cursor: not-allowed; }

.cal {
  --cal-accent: oklch(51% 0.15 252);
  display: grid; gap: 22px; min-width: 0;
}
@media (prefers-color-scheme: dark) {
  .cal { --cal-accent: oklch(74% 0.12 252); }
}
.cal { --cal-accent-tint: color-mix(in oklab, var(--cal-accent) 8%, var(--color-kumo-base)); --cal-accent-line: color-mix(in oklab, var(--cal-accent) 55%, var(--color-kumo-line)); }
.cal button { font: inherit; color: inherit; }
.cal-step { display: grid; gap: 8px; min-width: 0; margin: 0; border: 0; padding: 0; }
.cal-step-title { display: flex; align-items: baseline; gap: 8px; margin: 0 0 2px; padding: 0; color: var(--text-color-kumo-default); font-size: 12px; font-weight: 600; line-height: 16px; }
.cal-hint { margin: 0; color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; }
.cal-error { margin: 0; color: var(--color-kumo-danger); font-size: 12px; line-height: 16px; }
.cal-label { color: var(--text-color-kumo-default); font-size: 12px; font-weight: 500; line-height: 16px; }
.cal-inline { display: flex; gap: 8px; align-items: center; min-width: 0; }
.cal-grow { flex: 1; min-width: 0; }
.cal-subfield { display: grid; gap: 6px; min-width: 0; }
.cal-loading { display: flex; align-items: center; gap: 8px; padding: 18px 2px; color: var(--text-color-kumo-subtle); }

.cal-cards { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.cal-cards-two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.cal-card { position: relative; display: flex; align-items: flex-start; gap: 10px; min-width: 0; border: 1px solid var(--color-kumo-line); border-radius: 10px; padding: 10px 12px 10px 10px; background: var(--color-kumo-base); cursor: pointer; transition: border-color .12s ease, background-color .12s ease; }
.cal-card:hover { background: var(--color-kumo-elevated); }
.cal-card.selected { border-color: var(--cal-accent-line); background: var(--cal-accent-tint); box-shadow: inset 0 0 0 1px var(--cal-accent-line); }
.cal-card:has(input:focus-visible) { outline: 2px solid var(--cal-accent); outline-offset: 1px; }
.cal-card-icon { display: flex; flex-shrink: 0; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 7px; color: var(--cal-accent); background: color-mix(in oklab, var(--cal-accent) 11%, var(--color-kumo-base)); }
.cal-card.selected .cal-card-icon { background: var(--color-kumo-base); }
.cal-card-text { display: grid; flex: 1; gap: 1px; min-width: 0; }
.cal-card-title { color: var(--text-color-kumo-default); font-size: 13px; font-weight: 600; line-height: 18px; letter-spacing: -0.15px; }
.cal-card-description { overflow-wrap: anywhere; color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; }
.cal-radio { appearance: none; -webkit-appearance: none; flex-shrink: 0; width: 16px; height: 16px; margin: 6px 0 0; border: 1.5px solid var(--color-kumo-interact); border-radius: 50%; background: var(--color-kumo-base); cursor: inherit; }
.cal-row .cal-radio { margin: 0; }
.cal-radio:checked { border-color: var(--cal-accent); background: var(--cal-accent); box-shadow: inset 0 0 0 3.5px var(--color-kumo-base); }
.cal-radio:focus { outline: none; }
.cal-check { display: inline-flex; align-items: center; gap: 8px; justify-self: start; font-size: 12.5px; cursor: pointer; }
.cal-check input { width: 14px; height: 14px; margin: 0; accent-color: var(--cal-accent); }
.cal-segmented { display: inline-flex; flex-wrap: wrap; justify-self: start; gap: 2px; border-radius: 9px; padding: 2px; background: var(--color-kumo-tint); }
.cal-segment { display: inline-flex; height: 28px; align-items: center; border-radius: 7px; padding: 0 11px; color: var(--text-color-kumo-subtle); font-size: 12.5px; font-weight: 500; cursor: pointer; }
.cal-segment:hover { color: var(--text-color-kumo-default); }
.cal-segment.selected { color: var(--text-color-kumo-default); background: var(--color-kumo-base); box-shadow: 0 1px 2px rgb(0 0 0 / 10%), 0 0 0 1px var(--color-kumo-line); }
.cal-segment.disabled { color: var(--text-color-kumo-inactive); cursor: not-allowed; }
.cal-segment:has(input:focus-visible) { outline: 2px solid var(--cal-accent); outline-offset: 1px; }
.cal-disclosure { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; justify-self: start; margin: 0 0 0 -4px; border: 0; border-radius: 6px; padding: 2px 6px 2px 4px; background: none; cursor: pointer; text-align: left; }
.cal-disclosure .cal-step-title { margin: 0; }
.cal-disclosure:hover { background: var(--color-kumo-tint); }
.cal-disclosure:focus-visible { outline: 2px solid var(--cal-accent); outline-offset: 1px; }
.cal-disclosure-chevron { display: flex; align-self: center; color: var(--text-color-kumo-subtle); transition: transform .12s ease; }
.cal-disclosure[aria-expanded="true"] .cal-disclosure-chevron { transform: rotate(90deg); }
.cal-more { display: grid; gap: 14px; padding-left: 20px; }

.cal-opened { display: flex; align-items: center; gap: 10px; min-width: 0; border: 1px solid var(--color-kumo-line); border-radius: 10px; padding: 8px 8px 8px 10px; background: var(--color-kumo-base); }
.cal-opened-text { display: grid; flex: 1; min-width: 0; }
.cal-opened-title { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.cal-opened-subtitle { overflow: hidden; color: var(--text-color-kumo-subtle); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.cal-avatar { display: inline-flex; flex-shrink: 0; width: 30px; height: 30px; align-items: center; justify-content: center; border-radius: 50%; color: var(--cal-accent); background: color-mix(in oklab, var(--cal-accent) 14%, var(--color-kumo-base)); font-size: 11.5px; font-weight: 600; letter-spacing: .02em; }

.cal-panel { display: grid; min-width: 0; border: 1px solid var(--color-kumo-line); border-radius: 10px; background: var(--color-kumo-base); contain: inline-size; }
.cal-panel-notice { margin: 0; border-top: 1px solid var(--color-kumo-line); padding: 7px 12px; color: var(--text-color-kumo-subtle); font-size: 12px; line-height: 16px; }
.cal-list { position: relative; display: grid; align-content: start; gap: 1px; max-height: 232px; overflow-y: auto; overscroll-behavior: contain; padding: 4px; }
.cal-row { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 36px; border-radius: 7px; padding: 4px 10px; cursor: pointer; }
.cal-row:hover { background: var(--color-kumo-elevated); }
.cal-row.selected { background: var(--cal-accent-tint); }
.cal-row:has(input:focus-visible) { box-shadow: inset 0 0 0 2px var(--cal-accent); }
.cal-swatch { flex-shrink: 0; width: 12px; height: 12px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%); }
.cal-row-text { display: grid; flex: 1; min-width: 0; }
.cal-row-title { overflow: hidden; color: var(--text-color-kumo-default); font-weight: 500; line-height: 18px; letter-spacing: -0.15px; text-overflow: ellipsis; white-space: nowrap; }
.cal-row-meta { display: flex; flex-shrink: 0; gap: 4px; }
.cal-badge { border-radius: 999px; padding: 0 7px; color: var(--text-color-kumo-subtle); background: var(--color-kumo-tint); font-size: 11px; font-weight: 500; line-height: 18px; white-space: nowrap; }
.cal-skeleton-row { cursor: default; }
.cal-skeleton-row:hover { background: none; }
.cal-skeleton { display: block; height: 11px; border-radius: 4px; background: var(--color-kumo-tint); animation: cal-pulse 1.3s ease-in-out infinite; }
@keyframes cal-pulse { 50% { opacity: .45; } }
.cal-spinner { display: inline-block; flex-shrink: 0; width: 12px; height: 12px; border: 1.5px solid var(--color-kumo-line); border-top-color: var(--text-color-kumo-subtle); border-radius: 50%; animation: cal-spin .7s linear infinite; }
@keyframes cal-spin { to { transform: rotate(360deg); } }
.cal-empty { margin: 0; padding: 14px 10px; color: var(--text-color-kumo-subtle); font-size: 12.5px; text-align: center; }
.cal-failed { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; }
.cal-failed-text { margin: 0; color: var(--color-kumo-danger); font-size: 12.5px; line-height: 17px; }

@media (max-width: 460px) {
  .cal-opened { flex-wrap: wrap; }
  .cal-cards-two { grid-template-columns: 1fr; }
  .cal-segment { padding: 0 8px; font-size: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .cal-skeleton, .cal-spinner { animation: none; }
  .cal-card, .cal-disclosure-chevron { transition: none; }
}
`;

// -- the frame ----------------------------------------------------------------------------------

function connectionNotices(context: Context) {
  switch (connection.state) {
    case "needsAccess":
    case "waiting":
      return <Fragment>
        <Notice>
          {"This Microsoft 365 connection hasn't been allowed to open calendars yet. Allow it, then choose what to connect."}
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
  initial: { target: "all", ownerMode: "mine", details: "full", access: "read" },

  isReady({ values }) {
    return connection.state === "ready" && "draft" in draftOf(values);
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const located = await ui.locate(resourceUrl);
    if (located === null) return {};
    if (located.kind === "all") return { target: "all", access: located.access };
    if (located.kind === "availability") return { target: "availability" };
    if (located.owner) colleague = { ...colleague, input: located.owner.address };
    // Opened when it holds anything but the defaults, so what the binding has isn't hidden.
    moreOpen = located.details !== "full" || located.privateEvents === "show";
    const freeTime = !located.owner && located.calendar.isDefault && located.details === "freeBusy";
    return {
      target: freeTime ? "freeTime" : "calendar",
      ownerMode: located.owner ? "colleague" : "mine",
      owner: located.owner?.address ?? null,
      ownerName: located.owner?.name ?? null,
      calendarId: located.calendar.id,
      calendarName: located.calendar.name,
      calendarReadOnly: located.calendar.canEdit ? null : "1",
      details: located.details,
      privateEvents: located.privateEvents === "show" ? "show" : null,
      access: located.access,
    };
  },

  resourceUrl({ values, ui }) {
    const result = draftOf(values);
    if (!("draft" in result)) throw new Error(result.missing || "Calendar access isn't ready yet.");
    return ui.resourceUrlFor(result.draft);
  },

  render(context) {
    rerender = () => context.setValues({});
    loadStatus(context);
    const ready = connection.state === "ready" ? connection : undefined;
    const target = targetOf(context.values);
    // A one-calendar binding's options wait until its calendar is chosen.
    const chosen = target !== "calendar" || Boolean(context.values.calendarId);
    return <Section>
      <style>{STYLE}</style>
      <div className="cal">
        {connectionNotices(context)}
        {connection.state === "loading" ? <div className="cal-loading" role="status">
          <span className="cal-spinner" aria-hidden="true" />Opening your calendars…
        </div> : null}
        {ready ? <Fragment>
          {targetStep(context)}
          {target === "calendar" ? calendarStep(context, ready) : null}
          {(target === "all" || target === "calendar") && chosen ? permissionStep(context, ready) : null}
          {target === "calendar" && chosen ? moreOptions(context) : null}
        </Fragment> : null}
      </div>
    </Section>;
  },
} satisfies ConfiguratorUISpec<Rpc, Values>;
