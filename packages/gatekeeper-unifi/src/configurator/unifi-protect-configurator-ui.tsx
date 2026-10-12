import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { ProtectPickerRpc, ProtectValues } from "./unifi-configurator-types";

// Mirrors the Protect URL in resources.ts, which this module, compiled on its own, can't import;
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
  initial: { consoleId: null },

  isReady({ values }) {
    return !!values.consoleId;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = new URL(resourceUrl);
    const [consoles, consoleSegment, protect] = url.pathname.split("/").filter(Boolean);
    if (url.origin !== ORIGIN || consoles !== "consoles" || protect !== "protect") return {};
    return { consoleId: knownId(consoleSegment) };
  },

  resourceUrl({ values }) {
    if (!values.consoleId) throw new Error("Choose a console.");
    return `${ORIGIN}/consoles/${encodeSegment(values.consoleId)}/protect`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Console" description="The connection covers everything in UniFi Protect on this console.">
        <Autocomplete
          name="consoleId"
          value={values.consoleId}
          placeholder="Choose a console"
          loadOptions={query => ui.listConsoles(query)}
          onChange={consoleId => setValues({ consoleId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ProtectPickerRpc, ProtectValues>;
