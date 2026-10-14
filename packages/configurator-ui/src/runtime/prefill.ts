import type { ConfiguratorUISpec, ConfiguratorUIValues } from "../index.ts";
import { reportFrontendIssue } from "./reporting.ts";

/** The resource a configurator opens pre-filled to, as `ResourceConfiguratorHost` reports it. */
export type InitialResource = { resourceUrl: string; resourceUrlPattern: string } | null;

/**
 * Fallback URL -> values mapping: extract URLPattern named groups from the resource's pattern and
 * seed any values whose keys match a group name (e.g. ".../area/:areaId" -> { areaId }). Used when
 * the spec doesn't define `initialValuesFromResourceUrl`. Numeric/wildcard groups (e.g. "0") are
 * ignored.
 */
export const defaultValuesFromResourceUrl = (
  resourceUrl: string,
  resourceUrlPattern: string,
): Record<string, string> | null => {
  if (!resourceUrlPattern || resourceUrlPattern === "https://*") return null;
  if (typeof URLPattern === "undefined") return null;
  try {
    const compiled = new URLPattern(resourceUrlPattern);
    // The host matches tolerantly and the server parses tolerantly, so a strict exec here would
    // seed nothing and leave the caller on the right configurator with an empty field.
    const alternate = resourceUrl.endsWith("/")
      ? resourceUrl.replace(/\/+$/, "")
      : resourceUrl + "/";
    const match = compiled.exec(resourceUrl) ?? compiled.exec(alternate);
    const groups = match?.pathname.groups ?? {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(groups)) {
      if (typeof value === "string" && value.length > 0 && !/^[0-9]+$/.test(key)) {
        out[key] = decodeURIComponent(value);
      }
    }
    return out;
  } catch {
    return null;
  }
};

/** What a pre-filled configurator opens with: its values, and the text its Autocompletes show. */
export type Prefill = { values: ConfiguratorUIValues; queries: Record<string, string> };

/**
 * The spec's initial values with the host's initial resource (e.g. from an AI agent's connection
 * request) applied on top, so the form opens pre-filled and editable. Applied once, before the
 * first render, so nothing the configurator does on a change runs for it.
 */
export const prefill = async <TUI,>(
  spec: ConfiguratorUISpec<TUI>,
  ui: TUI,
  loadInitialResource: () => Promise<InitialResource>,
): Promise<Prefill> => {
  const values: ConfiguratorUIValues = { ...spec.initial };
  const queries: Record<string, string> = {};
  let initialResource: InitialResource;
  try {
    initialResource = await loadInitialResource();
  } catch (error) {
    reportFrontendIssue("configurator.initial-resource-load", error);
    return { values, queries };
  }
  if (!initialResource?.resourceUrl) return { values, queries };

  let seeded: Partial<ConfiguratorUIValues> | null;
  try {
    seeded = spec.initialValuesFromResourceUrl
      ? await spec.initialValuesFromResourceUrl({ ...initialResource, ui })
      : defaultValuesFromResourceUrl(initialResource.resourceUrl, initialResource.resourceUrlPattern);
  } catch (error) {
    reportFrontendIssue("configurator.initial-values-load", error);
    return { values, queries };
  }
  if (!seeded || typeof seeded !== "object") return { values, queries };

  for (const [key, value] of Object.entries(seeded)) {
    if (value === undefined) continue;
    values[key] = value;
    // An Autocomplete shows its typed query rather than its value, and a pre-filled value has no
    // title yet, so it shows the value itself.
    if (typeof value === "string" && value.length > 0) queries[key] = value;
  }
  return { values, queries };
};
