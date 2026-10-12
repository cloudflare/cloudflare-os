/**
 * Vendors the parts of Ubiquiti's published OpenAPI documents this gatekeeper relies on, for the
 * contract tests in __tests__/openapi-contract.test.ts: every operation the gatekeeper calls, and
 * every schema those operations reference, transitively. Everything else is dropped, so the copies
 * stay small enough to review.
 *
 *   node packages/gatekeeper-unifi/scripts/vendor-openapi.ts            # fetch from developer.ui.com
 *   node packages/gatekeeper-unifi/scripts/vendor-openapi.ts --from DIR # read DIR/<name>.json
 *
 * Bump the versions below to the ones you want to target, run this, and see what the contract
 * tests make of the difference.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type Spec = { openapi: string; info: unknown; servers?: unknown; paths: Record<string, Record<string, unknown>>; components?: { schemas?: Record<string, unknown> } };

const SPECS: { name: string; url: string; operations: [method: string, path: string][] }[] = [
  {
    name: "network",
    url: "https://developer.ui.com/network/v10.6.106/openapi.json",
    operations: [
      ["get", "/v1/info"],
      ["get", "/v1/sites"],
      ["get", "/v1/sites/{siteId}/devices"],
      ["get", "/v1/sites/{siteId}/devices/{deviceId}"],
      ["get", "/v1/sites/{siteId}/devices/{deviceId}/statistics/latest"],
      ["post", "/v1/sites/{siteId}/devices/{deviceId}/actions"],
      ["post", "/v1/sites/{siteId}/devices/{deviceId}/interfaces/ports/{portIdx}/actions"],
      ["get", "/v1/sites/{siteId}/clients"],
      ["get", "/v1/sites/{siteId}/clients/{clientId}"],
      ["post", "/v1/sites/{siteId}/clients/{clientId}/actions"],
      ["get", "/v1/sites/{siteId}/networks"],
      ["get", "/v1/sites/{siteId}/wifi/broadcasts"],
      ["get", "/v1/sites/{siteId}/wifi/broadcasts/{wifiBroadcastId}"],
      ["put", "/v1/sites/{siteId}/wifi/broadcasts/{wifiBroadcastId}"],
      ["get", "/v1/sites/{siteId}/hotspot/vouchers"],
      ["post", "/v1/sites/{siteId}/hotspot/vouchers"],
      ["delete", "/v1/sites/{siteId}/hotspot/vouchers/{voucherId}"],
    ],
  },
  {
    name: "protect",
    url: "https://developer.ui.com/protect/v7.3.70/openapi.json",
    operations: [
      ["get", "/v1/meta/info"],
      ["get", "/v1/nvrs"],
      ["get", "/v1/cameras"],
      ["get", "/v1/cameras/{id}"],
      ["patch", "/v1/cameras/{id}"],
      ["get", "/v1/cameras/{id}/snapshot"],
      ["post", "/v1/cameras/{id}/ptz/goto/{slot}"],
      ["post", "/v1/cameras/{id}/ptz/patrol/start/{slot}"],
      ["post", "/v1/cameras/{id}/ptz/patrol/stop"],
      ["get", "/v1/sensors"],
      ["get", "/v1/sensors/{id}"],
      ["get", "/v1/lights"],
      ["get", "/v1/lights/{id}"],
      ["patch", "/v1/lights/{id}"],
    ],
  },
  {
    name: "site-manager",
    url: "https://developer.ui.com/site-manager/v1.0.0/openapi.json",
    operations: [
      ["get", "/v1/hosts"],
    ],
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "__tests__", "openapi");
const fromIndex = process.argv.indexOf("--from");
const fromDir = fromIndex === -1 ? undefined : process.argv[fromIndex + 1];

function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if ((key === "$ref" || key === "mapping") && typeof value === "string" && value.startsWith("#/components/schemas/")) {
        into.add(value.slice("#/components/schemas/".length));
      } else if (key === "mapping" && value && typeof value === "object") {
        for (const ref of Object.values(value)) {
          if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) into.add(ref.slice("#/components/schemas/".length));
        }
      } else {
        collectRefs(value, into);
      }
    }
  }
}

for (const { name, url, operations } of SPECS) {
  const spec = JSON.parse(fromDir
    ? await readFile(join(fromDir, `${name}.json`), "utf8")
    : await (await fetch(url)).text()) as Spec;
  const paths: Spec["paths"] = {};
  for (const [method, path] of operations) {
    const operation = spec.paths[path]?.[method];
    if (!operation) throw new Error(`${name}: ${method.toUpperCase()} ${path} is not in ${url}`);
    (paths[path] ??= {})[method] = operation;
  }
  const schemas = spec.components?.schemas ?? {};
  const wanted = new Set<string>();
  collectRefs(paths, wanted);
  // Iterating a Set visits what is added during the iteration, so one pass reaches every schema
  // the operations depend on, however indirectly.
  for (const ref of wanted) collectRefs(schemas[ref], wanted);
  const kept = Object.fromEntries([...wanted].toSorted().map(ref => [ref, schemas[ref]]));
  const subset = { openapi: spec.openapi, info: spec.info, source: url, paths, components: { schemas: kept } };
  await writeFile(join(outDir, `${name}.json`), `${JSON.stringify(subset, null, 1)}\n`);
  console.log(`${name}: ${operations.length} operations, ${wanted.size} schemas`);
}
