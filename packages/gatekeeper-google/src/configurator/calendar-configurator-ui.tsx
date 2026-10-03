import { Autocomplete, Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CalendarConfiguratorRpc, CalendarConfiguratorValues } from "./calendar-configurator-types";

export default {
  initial: { availabilityMode: "thisCalendar" },

  isReady({ values }) {
    return typeof values.calendarId === "string" &&
      values.calendarId.length > 0 && values.calendarId !== "primary";
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const parsed = new URL(resourceUrl);
    const calendarId = decodeURIComponent(parsed.pathname.split("/")[2] ?? "");
    return {
      calendarId: calendarId === "primary" ? await ui.getPrimaryCalendarId() : calendarId,
      availabilityMode: parsed.searchParams.get("availability") === "allVisible"
        ? "allVisible" : "thisCalendar",
    };
  },

  resourceUrl({ values }) {
    const calendarId = encodeURIComponent(values.calendarId ?? "");
    const availabilityMode = values.availabilityMode === "allVisible" ? "allVisible" : "thisCalendar";
    return `https://calendar.google.com/calendar/${calendarId}/?availability=${availabilityMode}`;
  },

  render({ values, setValues, ui }) {
    const availabilityMode = values.availabilityMode === "allVisible" ? "allVisible" : "thisCalendar";
    return <Section>
      <Field label="Calendar" description="Choose the calendar this connection can read and manage.">
        <Autocomplete
          name="calendarId"
          value={values.calendarId}
          placeholder="Search calendars..."
          loadOptions={query => ui.listCalendars(query)}
          onChange={calendarId => setValues({ calendarId })}
        />
      </Field>

      <Field
        label="Availability lookup"
        description="Free/busy checks show only busy/free blocks, never event details."
      >
        <RadioCards
          value={availabilityMode}
          options={[
            {
              value: "thisCalendar",
              title: "This calendar only",
              description: "Check availability for this calendar only.",
            },
            {
              value: "allVisible",
              title: "All calendars visible to me",
              description: "Check anyone visible to your account. Collaborators must also be able to see their availability.",
            },
          ]}
          onChange={nextMode => {
            if (nextMode !== "thisCalendar" && nextMode !== "allVisible") return;
            setValues({ availabilityMode: nextMode });
          }}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CalendarConfiguratorRpc, CalendarConfiguratorValues>;
