import { Autocomplete, Field, h, Notice, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CameraValues, PickerOption, ProtectPickerRpc } from "./unifi-configurator-types";

// Mirrors the camera URL in resources.ts, which this module, compiled on its own, can't import;
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
  initial: { consoleId: null, cameraId: null, prefilled: null },

  isReady({ values }) {
    return !!values.consoleId && !!values.cameraId;
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const url = new URL(resourceUrl);
    const [consoles, consoleSegment, protect, cameras, cameraSegment] = url.pathname.split("/").filter(Boolean);
    if (url.origin !== ORIGIN || consoles !== "consoles" || protect !== "protect" || cameras !== "cameras") return {};
    return await named([
      ["consoleId", "console", knownId(consoleSegment), (_, query) => ui.listConsoles(query)],
      ["cameraId", "camera", knownId(cameraSegment), (found, query) => ui.listCameras(found.consoleId!, query)],
    ]);
  },

  resourceUrl({ values }) {
    if (!values.consoleId || !values.cameraId) throw new Error("Choose a console and a camera.");
    return `${ORIGIN}/consoles/${encodeSegment(values.consoleId)}/protect/cameras/${encodeSegment(values.cameraId)}`;
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
            // clearFields only drops the camera's typed query, and setValues re-renders at once, so
            // clear first and null the value too, or the old console's camera stays selected.
            clearFields("cameraId");
            setValues({ prefilled: null, consoleId, cameraId: null });
          }}
        />
      </Field>
      <Field label="Camera" description="The connection covers this camera or doorbell only.">
        <Autocomplete
          name="cameraId"
          value={values.cameraId}
          placeholder={values.consoleId ? "Choose a camera" : "Choose a console first"}
          disabled={!values.consoleId}
          loadOptions={query => values.consoleId ? ui.listCameras(values.consoleId, query) : Promise.resolve([])}
          onChange={cameraId => setValues({ prefilled: null, cameraId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ProtectPickerRpc, CameraValues>;
