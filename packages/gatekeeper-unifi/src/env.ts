/** Environment, vendor identity, and logging shared across the Worker. */

import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";
import { createLogger } from "@gadgets/observability/logger";

/** The vendor id, from the `GATEKEEPER_UNIFI` binding the Workshop discovers this Worker by. */
export const VENDOR_ID = "unifi";

/** This Worker's environment. `BASE_URL` is injected by the dev server and the release manifest. */
export type UnifiEnv = Cloudflare.Env & { BASE_URL?: string };

/** The public URL this gatekeeper's connect pages are served under. */
export function getBaseUrl(env: UnifiEnv): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/unifi");
}

/** The path part of `getBaseUrl`, or "" at the root. */
export function getBasePath(env: UnifiEnv): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : stripTrailingSlashes(path);
}

/** Fields this package logs. Never an API key, a request body, or a provider message. */
export type UnifiLogFields = {
  vendorId: string;
  mode: "cloud" | "direct";
  kind: string;
  status: number;
  resourceKind: string;
  action: number;
  actionKind: string;
};

/** The package logger. */
export const logger = createLogger<UnifiLogFields>({ component: "gatekeeper.unifi", vendorId: VENDOR_ID });
