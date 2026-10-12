import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CameraValues, ProtectPickerRpc } from "./unifi-configurator-types";

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

export default {
  initial: { consoleId: null, cameraId: null },

  isReady({ values }) {
    return !!values.consoleId && !!values.cameraId;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = new URL(resourceUrl);
    const [consoles, consoleSegment, protect, cameras, cameraSegment] = url.pathname.split("/").filter(Boolean);
    if (url.origin !== ORIGIN || consoles !== "consoles" || protect !== "protect" || cameras !== "cameras") return {};
    const consoleId = knownId(consoleSegment);
    return { consoleId, cameraId: consoleId ? knownId(cameraSegment) : null };
  },

  resourceUrl({ values }) {
    if (!values.consoleId || !values.cameraId) throw new Error("Choose a console and a camera.");
    return `${ORIGIN}/consoles/${encodeSegment(values.consoleId)}/protect/cameras/${encodeSegment(values.cameraId)}`;
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
            // clearFields only drops the camera's typed query, and setValues re-renders at once, so
            // clear first and null the value too, or the old console's camera stays selected.
            clearFields("cameraId");
            setValues({ consoleId, cameraId: null });
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
          onChange={cameraId => setValues({ cameraId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ProtectPickerRpc, CameraValues>;
