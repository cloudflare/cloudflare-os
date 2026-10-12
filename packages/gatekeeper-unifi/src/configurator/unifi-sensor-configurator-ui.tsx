import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { ProtectPickerRpc, SensorValues } from "./unifi-configurator-types";

// Mirrors the sensor URL in resources.ts, which this module, compiled on its own, can't import;
// __tests__/configurator-url.test.ts keeps the copies in step.
const ORIGIN = "https://unifi.ui.com";

/** A path segment as an ID, or null for an agent's `-` placeholder or a malformed one. */
function knownId(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    const id = decodeURIComponent(segment);
    return id && id !== "-" ? id : null;
  } catch {
    return null;
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%3A", ":");
}

export default {
  initial: { consoleId: null, sensorId: null },

  isReady({ values }) {
    return !!values.consoleId && !!values.sensorId;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = new URL(resourceUrl);
    const [consoles, consoleSegment, protect, sensors, sensorSegment] = url.pathname.split("/").filter(Boolean);
    if (url.origin !== ORIGIN || consoles !== "consoles" || protect !== "protect" || sensors !== "sensors") return {};
    const consoleId = knownId(consoleSegment);
    return { consoleId, sensorId: consoleId ? knownId(sensorSegment) : null };
  },

  resourceUrl({ values }) {
    if (!values.consoleId || !values.sensorId) throw new Error("Choose a console and a sensor.");
    return `${ORIGIN}/consoles/${encodeSegment(values.consoleId)}/protect/sensors/${encodeSegment(values.sensorId)}`;
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      <Field label="Console" description="The UniFi console that runs Protect.">
        <Autocomplete
          name="consoleId"
          value={values.consoleId}
          placeholder="Choose a console"
          loadOptions={query => ui.listConsoles(query)}
          onChange={consoleId => {
            // clearFields only drops the sensor's typed query, and setValues re-renders at once, so
            // clear first and null the value too, or the old console's sensor stays selected.
            clearFields("sensorId");
            setValues({ consoleId, sensorId: null });
          }}
        />
      </Field>
      <Field label="Sensor" description="The connection covers this sensor's readings only.">
        <Autocomplete
          name="sensorId"
          value={values.sensorId}
          placeholder={values.consoleId ? "Choose a sensor" : "Choose a console first"}
          disabled={!values.consoleId}
          loadOptions={query => values.consoleId ? ui.listSensors(values.consoleId, query) : Promise.resolve([])}
          onChange={sensorId => setValues({ sensorId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ProtectPickerRpc, SensorValues>;
