import type { ConfiguratorOption } from "./configurator-option";
export type { ConfiguratorOption };

export type { CalendarAvailabilityMode } from "../calendar-types";

export type CalendarConfiguratorValues = {
  calendarId?: string | null;
  availabilityMode?: CalendarAvailabilityMode | null;
}

export interface CalendarConfiguratorRpc {
  /** List writable calendars matching the search query. */
  listCalendars(query: string): Promise<ConfiguratorOption[]>;

  /** Return whether the connected account can write the exact calendar. */
  canWriteCalendar(calendarId: string): Promise<boolean>;

  /** Resolve the connected account's primary calendar to its stable calendar ID. */
  getPrimaryCalendarId(): Promise<string>;
}
