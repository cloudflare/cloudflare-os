import type { ConfiguratorOption } from "./configurator-option";
export type { ConfiguratorOption };

export type { CalendarAvailabilityMode } from "../calendar-types";

export type CalendarConfiguratorValues = {
  calendarId?: string | null;
  availabilityMode?: CalendarAvailabilityMode | null;
}

export interface CalendarConfiguratorRpc {
  listCalendars(query: string): Promise<ConfiguratorOption[]>;
}
