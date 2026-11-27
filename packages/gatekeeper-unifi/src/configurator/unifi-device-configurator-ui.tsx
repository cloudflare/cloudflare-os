import { Autocomplete, Field, h, Notice, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { DeviceValues, NetworkPickerRpc, PickerOption } from "./unifi-configurator-types";

// Mirrors the device URL in resources.ts, which this module, compiled on its own, can't import;
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
  initial: { consoleId: null, siteId: null, deviceId: null, clients: null, prefilled: null },

  isReady({ values }) {
    return !!values.consoleId && !!values.siteId && !!values.deviceId;
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const url = new URL(resourceUrl);
    const [consoles, consoleSegment, network, sites, siteSegment, devices, deviceSegment] =
      url.pathname.split("/").filter(Boolean);
    if (url.origin !== ORIGIN || consoles !== "consoles" || network !== "network" || sites !== "sites" ||
        devices !== "devices") {
      return {};
    }
    const ids = await named([
      ["consoleId", "console", knownId(consoleSegment), (_, query) => ui.listConsoles(query)],
      ["siteId", "site", knownId(siteSegment), (found, query) => ui.listSites(found.consoleId!, query)],
      ["deviceId", "device", knownId(deviceSegment), (found, query) => ui.listDevices(found.consoleId!, found.siteId!, query)],
    ]);
    return { ...ids, clients: url.searchParams.get("clients") === "1" ? "1" : null };
  },

  resourceUrl({ values }) {
    if (!values.consoleId || !values.siteId || !values.deviceId) throw new Error("Choose a console, a site, and a device.");
    return `${ORIGIN}/consoles/${encodeSegment(values.consoleId)}/network/sites/${encodeSegment(values.siteId)}` +
      `/devices/${encodeSegment(values.deviceId)}${values.clients === "1" ? "?clients=1" : ""}`;
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      {values.prefilled ? <Notice>Filled in: {values.prefilled}.</Notice> : null}
      <Field label="Console" description="The UniFi console that manages the device.">
        <Autocomplete
          name="consoleId"
          value={values.consoleId}
          placeholder="Choose a console"
          loadOptions={query => ui.listConsoles(query)}
          onChange={consoleId => {
            // clearFields only drops the dependents' typed queries, and setValues re-renders at
            // once, so clear first and null the values too, or stale choices stay selected.
            clearFields("siteId", "deviceId");
            setValues({ prefilled: null, consoleId, siteId: null, deviceId: null });
          }}
        />
      </Field>
      <Field label="Site" description="The site the device belongs to.">
        <Autocomplete
          name="siteId"
          value={values.siteId}
          placeholder={values.consoleId ? "Choose a site" : "Choose a console first"}
          disabled={!values.consoleId}
          loadOptions={query => values.consoleId ? ui.listSites(values.consoleId, query) : Promise.resolve([])}
          onChange={siteId => {
            clearFields("deviceId");
            setValues({ prefilled: null, siteId, deviceId: null });
          }}
        />
      </Field>
      <Field label="Device" description="The gateway, switch, or access point.">
        <Autocomplete
          name="deviceId"
          value={values.deviceId}
          placeholder={values.siteId ? "Choose a device" : "Choose a site first"}
          disabled={!values.consoleId || !values.siteId}
          loadOptions={query => values.consoleId && values.siteId
            ? ui.listDevices(values.consoleId, values.siteId, query)
            : Promise.resolve([])}
          onChange={deviceId => setValues({ prefilled: null, deviceId })}
        />
      </Field>
      <Field label="Connected clients" description="Whether the connection may also see the clients connected through this device.">
        <RadioCards
          value={values.clients === "1" ? "1" : "0"}
          options={[
            { value: "0", title: "This device only", description: "Its status, ports, and statistics." },
            { value: "1", title: "This device and its clients", description: "Also the phones, computers, and other clients connected through it." },
          ]}
          onChange={next => setValues({ clients: next === "1" ? "1" : null })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NetworkPickerRpc, DeviceValues>;
