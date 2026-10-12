import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { NetworkPickerRpc, WifiValues } from "./unifi-configurator-types";

// Mirrors the WiFi network URL in resources.ts, which this module, compiled on its own, can't
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
  initial: { consoleId: null, siteId: null, wifiNetworkId: null },

  isReady({ values }) {
    return !!values.consoleId && !!values.siteId && !!values.wifiNetworkId;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = new URL(resourceUrl);
    const [consoles, consoleSegment, network, sites, siteSegment, wifi, wifiSegment] =
      url.pathname.split("/").filter(Boolean);
    if (url.origin !== ORIGIN || consoles !== "consoles" || network !== "network" || sites !== "sites" ||
        wifi !== "wifi") {
      return {};
    }
    const consoleId = knownId(consoleSegment);
    const siteId = consoleId ? knownId(siteSegment) : null;
    return { consoleId, siteId, wifiNetworkId: siteId ? knownId(wifiSegment) : null };
  },

  resourceUrl({ values }) {
    if (!values.consoleId || !values.siteId || !values.wifiNetworkId) {
      throw new Error("Choose a console, a site, and a WiFi network.");
    }
    return `${ORIGIN}/consoles/${encodeSegment(values.consoleId)}/network/sites/${encodeSegment(values.siteId)}` +
      `/wifi/${encodeSegment(values.wifiNetworkId)}`;
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      <Field label="Console" description="The UniFi console that hosts the WiFi network.">
        <Autocomplete
          name="consoleId"
          value={values.consoleId}
          placeholder="Choose a console"
          loadOptions={query => ui.listConsoles(query)}
          onChange={consoleId => {
            // clearFields only drops the dependents' typed queries, and setValues re-renders at
            // once, so clear first and null the values too, or stale choices stay selected.
            clearFields("siteId", "wifiNetworkId");
            setValues({ consoleId, siteId: null, wifiNetworkId: null });
          }}
        />
      </Field>
      <Field label="Site" description="The site the WiFi network belongs to.">
        <Autocomplete
          name="siteId"
          value={values.siteId}
          placeholder={values.consoleId ? "Choose a site" : "Choose a console first"}
          disabled={!values.consoleId}
          loadOptions={query => values.consoleId ? ui.listSites(values.consoleId, query) : Promise.resolve([])}
          onChange={siteId => {
            clearFields("wifiNetworkId");
            setValues({ siteId, wifiNetworkId: null });
          }}
        />
      </Field>
      <Field label="WiFi network" description="The connection covers this network's settings and password.">
        <Autocomplete
          name="wifiNetworkId"
          value={values.wifiNetworkId}
          placeholder={values.siteId ? "Choose a WiFi network" : "Choose a site first"}
          disabled={!values.consoleId || !values.siteId}
          loadOptions={query => values.consoleId && values.siteId
            ? ui.listWifiNetworks(values.consoleId, values.siteId, query)
            : Promise.resolve([])}
          onChange={wifiNetworkId => setValues({ wifiNetworkId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NetworkPickerRpc, WifiValues>;
