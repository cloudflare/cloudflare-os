import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { LightValues, ProtectPickerRpc } from "./unifi-configurator-types";

// Mirrors the floodlight URL in resources.ts, which this module, compiled on its own, can't
// import; __tests__/configurator-url.test.ts keeps the copies in step.
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
  initial: { consoleId: null, lightId: null },

  isReady({ values }) {
    return !!values.consoleId && !!values.lightId;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = new URL(resourceUrl);
    const [consoles, consoleSegment, protect, lights, lightSegment] = url.pathname.split("/").filter(Boolean);
    if (url.origin !== ORIGIN || consoles !== "consoles" || protect !== "protect" || lights !== "lights") return {};
    const consoleId = knownId(consoleSegment);
    return { consoleId, lightId: consoleId ? knownId(lightSegment) : null };
  },

  resourceUrl({ values }) {
    if (!values.consoleId || !values.lightId) throw new Error("Choose a console and a floodlight.");
    return `${ORIGIN}/consoles/${encodeSegment(values.consoleId)}/protect/lights/${encodeSegment(values.lightId)}`;
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
            // clearFields only drops the floodlight's typed query, and setValues re-renders at once,
            // so clear first and null the value too, or the old console's floodlight stays selected.
            clearFields("lightId");
            setValues({ consoleId, lightId: null });
          }}
        />
      </Field>
      <Field label="Floodlight" description="The connection covers this floodlight only.">
        <Autocomplete
          name="lightId"
          value={values.lightId}
          placeholder={values.consoleId ? "Choose a floodlight" : "Choose a console first"}
          disabled={!values.consoleId}
          loadOptions={query => values.consoleId ? ui.listLights(values.consoleId, query) : Promise.resolve([])}
          onChange={lightId => setValues({ lightId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ProtectPickerRpc, LightValues>;
