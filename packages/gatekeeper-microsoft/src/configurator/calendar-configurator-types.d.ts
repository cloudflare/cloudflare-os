// The contract between the Calendar configurator frame and `CalendarConfiguratorUI`. The frame is
// transpiled on its own and cannot import runtime code, so the shapes it trades are declared here.
// The frame never builds a resource URL itself: it sends a draft, and the gatekeeper resolves it
// and writes the URL with `calendarUrl`.

/** What a binding lets agents do, lowest first. Matches `CalendarAccessLevel` in calendar-scope.ts. */
export type CalendarConfiguratorAccess = "read" | "edit" | "schedule";

/** How much of each event a one-calendar binding shows. Matches `DetailLevel` in calendar-scope.ts. */
export type CalendarConfiguratorDetails = "freeBusy" | "limited" | "full";

/** What the connection allows, read when the frame opens and again after a consent pop-up. */
export type CalendarConfiguratorStatus =
  | {
    state: "ready";
    /** The signed-in user, whose calendars are the default. */
    me: { address: string; name: string };
    /** The levels a binding of the user's own calendars may have, lowest first. */
    levels: CalendarConfiguratorAccess[];
    /** The levels a binding of a colleague's calendar may have, lowest first; empty when the grant can't open one. */
    sharedLevels: CalendarConfiguratorAccess[];
    /** Whether the deployment, rather than the connection's grant, is what stops `levels` short of `schedule`. */
    limitedByDeployment: boolean;
  }
  /** The connection's grant does not cover calendars; `ensureResources` asks for it. */
  | { state: "needsAccess" }
  /** The account has no calendar, such as one with no Exchange Online license. */
  | { state: "unavailable"; message: string };

/** A binding being configured, before the gatekeeper has resolved it. */
export type CalendarDraft =
  | { kind: "all"; access: CalendarConfiguratorAccess }
  | { kind: "availability" }
  | {
    kind: "calendar";
    /** A colleague's address; absent for the user's own calendar. */
    owner?: string;
    /** A calendar's immutable ID, or "default" for the owner's main calendar. */
    calendarId: string;
    details: CalendarConfiguratorDetails;
    /** "show" only at "full". */
    privateEvents: "busy" | "show";
    access: CalendarConfiguratorAccess;
  };

/** One calendar in a list to choose from. */
export type CalendarRow = {
  /** The calendar's immutable ID. */
  id: string;
  name: string;
  isDefault: boolean;
  /** Whether the user can change its events: false for a holiday or birthday calendar, or one shared to read. */
  canEdit: boolean;
  /** Its Outlook color as `#rrggbb`, when it has one. */
  color?: string;
};

/** A colleague's calendars that the user can open. */
export type CalendarColleague = {
  address: string;
  name: string;
  calendars: CalendarRow[];
  /** Set when the list may be incomplete, saying why. */
  notice?: string;
};

/** A binding URL, read back into what the frame shows, for editing a binding. */
export type CalendarLocated =
  | { kind: "all"; access: CalendarConfiguratorAccess }
  | { kind: "availability" }
  | {
    kind: "calendar";
    owner?: { address: string; name: string };
    calendar: CalendarRow;
    details: CalendarConfiguratorDetails;
    privateEvents: "busy" | "show";
    access: CalendarConfiguratorAccess;
  };

export interface CalendarConfiguratorRpc {
  getStatus(): Promise<CalendarConfiguratorStatus>;
  /** The user's own calendars, the main one first. */
  listCalendars(): Promise<CalendarRow[]>;
  /** The calendars a colleague has shared with the user. Rejections carry a message written for the user. */
  openColleague(address: string): Promise<CalendarColleague>;
  /** The resource URL a draft binds, once the gatekeeper has resolved and checked it. */
  resourceUrlFor(draft: CalendarDraft): Promise<string>;
  /** What a resource URL binds, or null when it names nothing the user can open. */
  locate(resourceUrl: string): Promise<CalendarLocated | null>;
}
