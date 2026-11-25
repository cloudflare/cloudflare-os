import { Autocomplete, Field, h, Notice, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { PickerOption, ProtectPickerRpc, SensorValues } from "./unifi-configurator-types";

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

/**
 * Looks up, in order, what a pre-filled URL's IDs name: a field shows a pre-filled ID rather than
 * its name, so the form says what it holds before it can be submitted. The first ID its list
 * doesn't offer is left, with every ID after it, for the user to choose.
 * @param steps Each field's key and label, its ID from the URL, and its list once those before it
 * are found.
 * @returns The IDs found, as the lists spell them, and `prefilled` naming them.
 */
async function named(
  steps: [string, string, string | null, (found: Record<string, string>, query: string) => Promise<PickerOption[]>][],
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const names: string[] = [];
  for (const [key, label, id, list] of steps) {
    if (!id) break;
    let option: PickerOption | undefined;
    try {
      option = (await list(found, id)).find(o => o.value.toLowerCase() === id.toLowerCase());
    } catch {
      break;
    }
    if (!option) break;
    found[key] = option.value;
    names.push(`${label} “${option.title}”`);
  }
  return names.length > 0 ? { ...found, prefilled: names.join(", ") } : found;
}

export default {
  initial: { consoleId: null, sensorId: null, prefilled: null },

  isReady({ values }) {
    return !!values.consoleId && !!values.sensorId;
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const url = new URL(resourceUrl);
    const [consoles, consoleSegment, protect, sensors, sensorSegment] = url.pathname.split("/").filter(Boolean);
    if (url.origin !== ORIGIN || consoles !== "consoles" || protect !== "protect" || sensors !== "sensors") return {};
    return await named([
      ["consoleId", "console", knownId(consoleSegment), (_, query) => ui.listConsoles(query)],
      ["sensorId", "sensor", knownId(sensorSegment), (found, query) => ui.listSensors(found.consoleId!, query)],
    ]);
  },

  resourceUrl({ values }) {
    if (!values.consoleId || !values.sensorId) throw new Error("Choose a console and a sensor.");
    return `${ORIGIN}/consoles/${encodeSegment(values.consoleId)}/protect/sensors/${encodeSegment(values.sensorId)}`;
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      {values.prefilled ? <Notice>Filled in: {values.prefilled}.</Notice> : null}
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
            setValues({ prefilled: null, consoleId, sensorId: null });
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
          onChange={sensorId => setValues({ prefilled: null, sensorId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ProtectPickerRpc, SensorValues>;
