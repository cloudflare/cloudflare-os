import { Autocomplete, Field, h, Notice, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { LightValues, PickerOption, ProtectPickerRpc } from "./unifi-configurator-types";

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

// Control characters and bidirectional formatting, which the runtime strips from the titles it
// shows: in a name UniFi supplied, they could reorder or hide the notice's text around it.
const INVISIBLE_CONTROLS = /[\p{Cc}\p{Bidi_Control}]/gu;
const MAX_NAME_LENGTH = 240;

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
    names.push(`${label} “${option.title.replace(INVISIBLE_CONTROLS, "").slice(0, MAX_NAME_LENGTH) || option.value}”`);
  }
  return names.length > 0 ? { ...found, prefilled: names.join(", ") } : found;
}

export default {
  initial: { consoleId: null, lightId: null, prefilled: null },

  isReady({ values }) {
    return !!values.consoleId && !!values.lightId;
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const url = new URL(resourceUrl);
    const [consoles, consoleSegment, protect, lights, lightSegment] = url.pathname.split("/").filter(Boolean);
    if (url.origin !== ORIGIN || consoles !== "consoles" || protect !== "protect" || lights !== "lights") return {};
    return await named([
      ["consoleId", "console", knownId(consoleSegment), (_, query) => ui.listConsoles(query)],
      // Read by its ID: a key can be allowed one floodlight's details without the list of them.
      ["lightId", "floodlight", knownId(lightSegment), (found, id) => ui.findLight(found.consoleId!, id).then(item => item ? [item] : [])],
    ]);
  },

  resourceUrl({ values }) {
    if (!values.consoleId || !values.lightId) throw new Error("Choose a console and a floodlight.");
    return `${ORIGIN}/consoles/${encodeSegment(values.consoleId)}/protect/lights/${encodeSegment(values.lightId)}`;
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
            // clearFields only drops the floodlight's typed query, and setValues re-renders at once,
            // so clear first and null the value too, or the old console's floodlight stays selected.
            clearFields("lightId");
            setValues({ prefilled: null, consoleId, lightId: null });
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
          onChange={lightId => setValues({ prefilled: null, lightId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ProtectPickerRpc, LightValues>;
