import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { NetworkPickerRpc, SiteValues } from "./unifi-configurator-types";

// Mirrors the site URL in resources.ts, which this module, compiled on its own, can't import;
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
  initial: { consoleId: null, siteId: null },

  isReady({ values }) {
    return !!values.consoleId && !!values.siteId;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = new URL(resourceUrl);
    const [consoles, consoleSegment, network, sites, siteSegment] = url.pathname.split("/").filter(Boolean);
    if (url.origin !== ORIGIN || consoles !== "consoles" || network !== "network" || sites !== "sites") return {};
    const consoleId = knownId(consoleSegment);
    return { consoleId, siteId: consoleId ? knownId(siteSegment) : null };
  },

  resourceUrl({ values }) {
    if (!values.consoleId || !values.siteId) throw new Error("Choose a console and a site.");
    return `${ORIGIN}/consoles/${encodeSegment(values.consoleId)}/network/sites/${encodeSegment(values.siteId)}`;
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      <Field label="Console" description="The UniFi console that hosts the site.">
        <Autocomplete
          name="consoleId"
          value={values.consoleId}
          placeholder="Choose a console"
          loadOptions={query => ui.listConsoles(query)}
          onChange={consoleId => {
            // clearFields only drops the site's typed query, and setValues re-renders at once, so
            // clear first and null the value too, or the old console's site stays selected.
            clearFields("siteId");
            setValues({ consoleId, siteId: null });
          }}
        />
      </Field>
      <Field label="Site" description="The connection covers this site: its devices, clients, WiFi networks and their passwords, and guest hotspot.">
        <Autocomplete
          name="siteId"
          value={values.siteId}
          placeholder={values.consoleId ? "Choose a site" : "Choose a console first"}
          disabled={!values.consoleId}
          loadOptions={query => values.consoleId ? ui.listSites(values.consoleId, query) : Promise.resolve([])}
          onChange={siteId => setValues({ siteId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NetworkPickerRpc, SiteValues>;
