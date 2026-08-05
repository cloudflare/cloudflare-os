import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  type AccountDescription,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import INSTANCE_CONFIGURATOR_HTML from "./generated/instance-configurator-ui.txt";
import AREA_CONFIGURATOR_HTML from "./generated/area-configurator-ui.txt";
import LABEL_CONFIGURATOR_HTML from "./generated/label-configurator-ui.txt";
import DEVICE_CONFIGURATOR_HTML from "./generated/device-configurator-ui.txt";
import ENTITY_CONFIGURATOR_HTML from "./generated/entity-configurator-ui.txt";
import type { HomeAssistantInstanceConfiguratorRpc } from "./configurator/instance-configurator-types";
import type {
  HomeAssistantAreaConfiguratorRpc,
  HomeAssistantDeviceConfiguratorRpc,
  HomeAssistantEntityConfiguratorRpc,
  HomeAssistantLabelConfiguratorRpc,
  HomeAssistantConfiguratorOption,
} from "./configurator/resource-configurator-types";
import {
  HomeAssistantError,
  HomeAssistantRest,
  HomeAssistantWebSocket,
  fetchRegistrySnapshot,
  withWebSocket,
  type HomeAssistantCredentials,
  type RegistrySnapshot,
} from "./homeassistant-api";
import {
  applyRevertForEntity,
  canRevert,
  describeAction,
  executeAction,
  fetchDashboardConfig,
  resolveTargets,
} from "./approvals";
import {
  indexPendingByEntity,
  overlayDashboardConfig,
  overlayEntityState,
  overlayEntityStates,
  type HAStateRecord,
} from "./simulation";
import type {
  Area,
  AreaInfo,
  Dashboard,
  DashboardConfig,
  DashboardInfo,
  Device,
  DeviceInfo,
  Entity,
  EntityFilter,
  EntityHistory,
  EntityState,
  EntitySummary,
  FloorInfo,
  HomeAssistantConfig,
  HomeAssistantSession,
  Label,
  LabelInfo,
  LightTurnOnData,
  LogbookEntry,
  LovelaceResourceInfo,
  ServiceCallTarget,
  ServiceInfo,
} from "./types";
import TYPES_CODE from "./types.txt";

// ---------------------------------------------------------------------------
// Configuration & nonce helpers

type Env = Cloudflare.Env & {
  BASE_URL?: string;
};

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/homeassistant");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// ---------------------------------------------------------------------------
// Resource descriptors

// Home Assistant brand icon, embedded as an inline SVG data URL.
//
// Source: https://github.com/homarr-labs/dashboard-icons (home-assistant.svg).
//
// The logomark fills its native 512x512 viewBox, so it renders at the same visual weight as the
// other vendor logos (which likewise use tight, fill-the-canvas viewBoxes) wherever a gatekeeper
// logo is shown (the connect card, picker, and admin panel all render it at full size).
const HOMEASSISTANT_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\
<path d="M512 473.3c0 17.6-14.4 32-32 32H32c-17.6 0-32-14.4-32-32v-192c0-17.6 10.2-42.2 22.6-54.6L233.4 16c12.4-12.4 32.8-12.4 45.2 0l210.8 210.8c12.4 12.4 22.6 37 22.6 54.6z" fill="#f2f4f9"/>\
<path d="M489.4 226.7 278.6 16c-12.4-12.4-32.8-12.4-45.2 0L22.6 226.7C10.2 239.1 0 263.7 0 281.3v192c0 17.6 14.4 32 32 32h196.8l-86.7-86.7c-4.5 1.5-9.2 2.4-14.2 2.4-24.1 0-43.7-19.6-43.7-43.7s19.6-43.7 43.7-43.7 43.7 19.6 43.7 43.7c0 5-.9 9.7-2.4 14.2l67.5 67.5V211.8c-14.5-7.1-24.5-22-24.5-39.2 0-24.1 19.6-43.7 43.7-43.7s43.7 19.6 43.7 43.7c0 17.2-10 32.1-24.5 39.2v173.4l67.1-67.1c-1.3-4.2-2-8.6-2-13.2 0-24.1 19.6-43.7 43.7-43.7s43.7 19.6 43.7 43.7-19.6 43.7-43.7 43.7c-5.3 0-10.4-1-15.1-2.8l-93.7 93.7v65.9H480c17.6 0 32-14.4 32-32v-192c0-17.6-10.2-42.2-22.6-54.7" fill="#18bcf2"/>\
</svg>`;

const HOMEASSISTANT_LOGO_URL =
  `data:image/svg+xml;utf8,${encodeURIComponent(HOMEASSISTANT_LOGO_SVG)}`;

const HOMEASSISTANT_ICON: AvatarImage = { url: HOMEASSISTANT_LOGO_URL };

// Whole-instance resource: matches the user's HA base URL. We use `https://*` as a catch-all
// pattern so any HA URL the user pastes will match. The Workshop's resource picker recognizes
// `https://*` as a special "any URL" pattern.
const INSTANCE_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Home Assistant",
  description: "Access to a Home Assistant instance: every area, device, entity, and dashboard.",
  icon: HOMEASSISTANT_ICON,
};

// Each finer-grained granularity is selected via its own configurator UI. The URL patterns use
// a unique scheme/host marker so the resource picker doesn't confuse them with the catch-all
// `https://*` whole-instance resource, and so URLPattern.test() routes correctly.
const AREA_RESOURCE: SupportedResource = {
  urlPattern: "https://homeassistant.local/_resource/area/:areaId",
  title: "Home Assistant Area",
  description: "Access to a single Home Assistant area (room): its devices and entities only.",
  icon: HOMEASSISTANT_ICON,
};

const LABEL_RESOURCE: SupportedResource = {
  urlPattern: "https://homeassistant.local/_resource/label/:labelId",
  title: "Home Assistant Label",
  description: "Access to all Home Assistant entities carrying a particular label.",
  icon: HOMEASSISTANT_ICON,
};

const DEVICE_RESOURCE: SupportedResource = {
  urlPattern: "https://homeassistant.local/_resource/device/:deviceId",
  title: "Home Assistant Device",
  description: "Access to a single physical device and the entities it provides.",
  icon: HOMEASSISTANT_ICON,
};

const ENTITY_RESOURCE: SupportedResource = {
  urlPattern: "https://homeassistant.local/_resource/entity/:entityId",
  title: "Home Assistant Entity",
  description: "Access to a single Home Assistant entity (light, sensor, switch, etc).",
  icon: HOMEASSISTANT_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [
  INSTANCE_RESOURCE,
  AREA_RESOURCE,
  LABEL_RESOURCE,
  DEVICE_RESOURCE,
  ENTITY_RESOURCE,
];

// ---------------------------------------------------------------------------
// HTML pages for the connect flow

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Home Assistant</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 540px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: #03a9f4; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, monospace; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: #03a9f4; }
  details ol { padding-left: 1.25rem; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: #03a9f4; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #0288d1; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .hint { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect Home Assistant</h1>
    <p>Provide the URL of your Home Assistant instance and a long-lived access token. Cloudflare OS will use these to read entity states and control devices.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeAttr(params.actionUrl)}">
      <label for="baseUrl">Home Assistant URL</label>
      <input id="baseUrl" name="baseUrl" type="url" required placeholder="https://homeassistant.local:8123" autofocus>
      <div class="hint">Include the protocol (http:// or https://) and port if non-standard. No trailing slash.</div>

      <label for="token">Long-Lived Access Token</label>
      <input id="token" name="token" type="password" required placeholder="eyJhbGc...">
      <div class="hint">Tokens never expire; they grant full account access until revoked in HA.</div>

      <details>
        <summary>How to create a long-lived access token</summary>
        <ol>
          <li>Open your Home Assistant in a browser.</li>
          <li>Click your username in the bottom-left corner.</li>
          <li>Select the <b>Security</b> tab.</li>
          <li>Scroll to the bottom and click <b>Create Token</b> under "Long-lived access tokens".</li>
          <li>Give it a name like "Cloudflare OS", then copy the token and paste it above.</li>
        </ol>
      </details>

      <button type="submit">Connect</button>
    </form>
  </div>
</body>
</html>`;

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Connected</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <script>window.close();</script>
  <h2 style="color: #03a9f4;">Connected!</h2>
  <p>Home Assistant has been linked to Cloudflare OS. You may close this tab.</p>
</body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Link Expired</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <h2 style="color: #d97706;">Authorization Link Expired</h2>
  <p>This connection link is invalid or has expired. Please return to Cloudflare OS and start over.</p>
</body>
</html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ---------------------------------------------------------------------------
// fetch handler: serves the connect form and accepts its POST

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Connect URL: /<doId>/<nonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const doId = path[0];
      const nonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));

      if (req.method === "GET") {
        const valid = await stub.verifyNonceWithoutConsuming(nonce);
        if (!valid) {
          return new Response(INVALID_LINK_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response(CONNECT_FORM_HTML({ actionUrl: req.url }), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "POST") {
        let formData: FormData;
        try {
          formData = await req.formData();
        } catch {
          return new Response("Invalid form submission.", { status: 400 });
        }
        const baseUrlInput = String(formData.get("baseUrl") ?? "").trim();
        const tokenInput = String(formData.get("token") ?? "").trim();
        if (!baseUrlInput || !tokenInput) {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: "Both URL and token are required." }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }

        // Normalize URL
        let normalizedUrl: string;
        try {
          const u = new URL(baseUrlInput);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            throw new Error("URL must use http:// or https://");
          }
          // Strip trailing slash
          normalizedUrl = `${u.protocol}//${u.host}${stripTrailingSlashes(u.pathname)}`;
        } catch (e: any) {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: `Invalid URL: ${e.message}` }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }

        const result = await stub.completeConnection(nonce, normalizedUrl, tokenInput);
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (result.kind === "error") {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: result.message }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }
        return new Response(SELF_CLOSING_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Home Assistant",
      url: "https://www.home-assistant.io/",
      logo: HOMEASSISTANT_ICON,
      tagline: "Control your smart home, read sensor state, and edit Lovelace dashboards.",
      description:
          "Connect your Home Assistant instance so Cloudflare OS can read entity state, call services " +
          "to control devices, edit dashboards, and render templates. Build agents that automate " +
          "your home, alert on sensor changes, or generate custom dashboards.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }


  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores baseUrl + LLAT for a connected account

interface StoredCredentials {
  baseUrl: string;
  token: string;
}

interface StoredNonce {
  value: string;
  expiresAt: number;
}

type CompleteConnectionResult =
  | { kind: "ok" }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  /** Validates the nonce but does not consume it (so the user can resubmit if validation fails). */
  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt) return false;
    return constantTimeEqual(stored.value, nonce);
  }

  async completeConnection(
    nonce: string,
    baseUrl: string,
    token: string,
  ): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return { kind: "invalid_nonce" };
    }

    // Validate that the URL+token can actually talk to HA.
    const creds: HomeAssistantCredentials = { baseUrl, token };
    try {
      const rest = new HomeAssistantRest(creds);
      await rest.ping();
    } catch (e: any) {
      const msg = e instanceof HomeAssistantError
        ? e.message
        : `Unable to reach Home Assistant: ${e?.message ?? e}`;
      return { kind: "error", message: msg };
    }

    // Consume the nonce now that we've validated.
    this.ctx.storage.kv.delete("nonce");

    this.ctx.storage.kv.put<StoredCredentials>("credentials", { baseUrl, token });
    this.ctx.storage.kv.put("expiredNotified", false);

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      // Callback evicted — should not normally happen.
      this.ctx.storage.kv.delete("credentials");
      return { kind: "error", message: "Connection callback expired. Please restart." };
    }

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      try {
        await callback.credentialsRestored();
      } catch (e: any) {
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    } else {
      try {
        const props: HomeAssistantUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.HomeAssistantUserImpl({ props }));
      } catch (e: any) {
        this.ctx.storage.kv.delete("credentials");
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok" };
  }

  getCredentials(): HomeAssistantCredentials {
    const creds = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!creds) {
      throw new Error("Home Assistant credentials are not configured for this account.");
    }
    return creds;
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) {
      await callback.credentialsExpired();
    }
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl

type HomeAssistantUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class HomeAssistantUserImpl
  extends WorkerEntrypoint<Env, HomeAssistantUserImplProps>
  implements GatekeeperUser
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<HomeAssistantCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<AccountDescription> {
    const creds = await this.#getCreds();
    const rest = new HomeAssistantRest(creds);
    let displayName = "Home Assistant";
    let uniqueName = creds.baseUrl;
    try {
      const config = await rest.getConfig();
      if (config?.location_name) displayName = `Home Assistant (${config.location_name})`;
      if (config?.location_name) uniqueName = `${config.location_name} @ ${creds.baseUrl}`;
    } catch (e) {
      if (e instanceof HomeAssistantError && e.isAuthError) {
        await this.#userAccount().noteCredentialsExpired();
      }
      // Ignore other failures; fall back to defaults.
    }
    return {
      displayName,
      uniqueName,
      avatar: HOMEASSISTANT_ICON,
    };
  }

  // This gatekeeper does not provide sign-in.
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const userAccount = this.#userAccount();
    const credsGetter = async () => await userAccount.getCredentials();

    switch (resourceUrlPattern) {
      case INSTANCE_RESOURCE.urlPattern:
        return {
          iframeHtml: INSTANCE_CONFIGURATOR_HTML,
          ui: new RpcStub(new InstanceConfiguratorUI(credsGetter)),
        };
      case AREA_RESOURCE.urlPattern:
        return {
          iframeHtml: AREA_CONFIGURATOR_HTML,
          ui: new RpcStub(new AreaConfiguratorUI(credsGetter)),
        };
      case LABEL_RESOURCE.urlPattern:
        return {
          iframeHtml: LABEL_CONFIGURATOR_HTML,
          ui: new RpcStub(new LabelConfiguratorUI(credsGetter)),
        };
      case DEVICE_RESOURCE.urlPattern:
        return {
          iframeHtml: DEVICE_CONFIGURATOR_HTML,
          ui: new RpcStub(new DeviceConfiguratorUI(credsGetter)),
        };
      case ENTITY_RESOURCE.urlPattern:
        return {
          iframeHtml: ENTITY_CONFIGURATOR_HTML,
          ui: new RpcStub(new EntityConfiguratorUI(credsGetter)),
        };
      default:
        throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e: any) {
      throw new Error(`Invalid Home Assistant URL "${url}": ${e?.message ?? e}`, { cause: e });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported URL scheme for Home Assistant: ${parsed.protocol}`);
    }

    const userObjectId = this.ctx.props.userObjectId;

    // Detect a "fine-grained" resource URL: https://homeassistant.local/_resource/<kind>/<id>
    if (parsed.hostname === "homeassistant.local") {
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments[0] === "_resource" && segments.length >= 3) {
        const kind = segments[1];
        const id = decodeURIComponent(segments.slice(2).join("/"));
        // Build props fresh in each case with `resourceKind` set explicitly, so adding a new
        // granularity later cannot silently fall through into a default value.
        switch (kind) {
          case "area":
            return {
              class: this.ctx.exports.HomeAssistantGatekeeperImpl({
                props: { userObjectId, resourceKind: "area", resourceId: id },
              }),
              resource: AREA_RESOURCE,
            };
          case "label":
            return {
              class: this.ctx.exports.HomeAssistantGatekeeperImpl({
                props: { userObjectId, resourceKind: "label", resourceId: id },
              }),
              resource: LABEL_RESOURCE,
            };
          case "device":
            return {
              class: this.ctx.exports.HomeAssistantGatekeeperImpl({
                props: { userObjectId, resourceKind: "device", resourceId: id },
              }),
              resource: DEVICE_RESOURCE,
            };
          case "entity":
            return {
              class: this.ctx.exports.HomeAssistantGatekeeperImpl({
                props: { userObjectId, resourceKind: "entity", resourceId: id },
              }),
              resource: ENTITY_RESOURCE,
            };
          default:
            throw new Error(`Unsupported Home Assistant resource kind: ${kind}`);
        }
      }
    }

    // Any other http(s) URL is treated as whole-instance access against the connected account.
    return {
      class: this.ctx.exports.HomeAssistantGatekeeperImpl({
        props: { userObjectId, resourceKind: "instance" },
      }),
      resource: INSTANCE_RESOURCE,
    };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  // Mint a verifier representing this account. Home Assistant uses the "low-stakes" observer
  // strategy (see HomeAssistantGatekeeperImpl.addObserver): it is a self-hosted personal system,
  // and its long-lived access token is all-or-nothing (HA exposes no per-user/per-entity ACL we
  // could verify an observer against), so there is nothing meaningful to check. The verifier
  // carries no identity and is never consulted — but the overseer mints one on every open, so it
  // must exist and not throw.
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.HomeAssistantVerifier({});
  }
}

// A trivial verifier since Home Assistant's observer strategy is low-stakes.
@validateRpc()
export class HomeAssistantVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Configurator UI for the whole-instance resource.
//
// The configurator runs in a sandboxed iframe and is treated as untrusted. We expose ONLY a
// narrow set of read-only helper methods; credentials are kept private via a closure (the
// credentials getter is stored in a WeakMap keyed by the RpcTarget instance, not on the
// instance itself).

const instanceConfiguratorGetters = new WeakMap<
  object,
  () => Promise<HomeAssistantCredentials>
>();

@validateRpc()
class InstanceConfiguratorUI extends RpcTarget implements HomeAssistantInstanceConfiguratorRpc {
  constructor(getCredentials: () => Promise<HomeAssistantCredentials>) {
    super();
    instanceConfiguratorGetters.set(this, getCredentials);
  }

  async resourceUrl(): Promise<string> {
    const getter = instanceConfiguratorGetters.get(this);
    if (!getter) throw new Error("Configurator is not initialized.");
    const creds = await getter();
    return creds.baseUrl;
  }

  async describeInstance(): Promise<{ name: string; baseUrl: string }> {
    const getter = instanceConfiguratorGetters.get(this);
    if (!getter) throw new Error("Configurator is not initialized.");
    const creds = await getter();
    let name = "Home Assistant";
    try {
      const config = await new HomeAssistantRest(creds).getConfig();
      if (config?.location_name) name = config.location_name;
    } catch (e) {
      // Ignore; fall back to default name.
    }
    return { name, baseUrl: creds.baseUrl };
  }
}

// ---------------------------------------------------------------------------
// Configurators for fine-grained resources (area, label, device, entity).
//
// Each is given a credentials-getter closure (stored in a WeakMap so it isn't accessible as an
// RPC property). They only expose read-only listing methods.

const resourceConfiguratorGetters = new WeakMap<
  object,
  () => Promise<HomeAssistantCredentials>
>();

async function getResourceConfiguratorCreds(target: object): Promise<HomeAssistantCredentials> {
  const getter = resourceConfiguratorGetters.get(target);
  if (!getter) throw new Error("Configurator is not initialized.");
  return await getter();
}

const AUTOCOMPLETE_LIMIT = 200;

function matchesSearch(haystackParts: (string | undefined | null)[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const corpus = haystackParts.filter(Boolean).join(" ").toLowerCase();
  return q.split(/\s+/).every((term) => corpus.includes(term));
}

function buildAreaUrl(areaId: string): string {
  return `${AREA_RESOURCE.urlPattern.replace(":areaId", encodeURIComponent(areaId))}`;
}
function buildLabelUrl(labelId: string): string {
  return `${LABEL_RESOURCE.urlPattern.replace(":labelId", encodeURIComponent(labelId))}`;
}
function buildDeviceUrl(deviceId: string): string {
  return `${DEVICE_RESOURCE.urlPattern.replace(":deviceId", encodeURIComponent(deviceId))}`;
}
function buildEntityUrl(entityId: string): string {
  return `${ENTITY_RESOURCE.urlPattern.replace(":entityId", encodeURIComponent(entityId))}`;
}

@validateRpc()
class AreaConfiguratorUI extends RpcTarget implements HomeAssistantAreaConfiguratorRpc {
  constructor(getCredentials: () => Promise<HomeAssistantCredentials>) {
    super();
    resourceConfiguratorGetters.set(this, getCredentials);
  }

  async listAreas(query: string): Promise<HomeAssistantConfiguratorOption[]> {
    const creds = await getResourceConfiguratorCreds(this);
    return await withWebSocket(creds, async (ws) => {
      const list = await ws.send<any[]>({ type: "config/area_registry/list" });
      const options: HomeAssistantConfiguratorOption[] = list
        .filter((a: any) => matchesSearch([a.name, a.area_id, ...(a.aliases ?? [])], query))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((a: any) => ({
          value: a.area_id,
          title: a.name ?? a.area_id,
          subtitle: a.floor_id ? `Floor: ${a.floor_id}` : undefined,
        }));
      return options;
    });
  }

  async resourceUrl(areaId: string | null | undefined): Promise<string> {
    if (!areaId) throw new Error("No area selected.");
    return buildAreaUrl(areaId);
  }
}

@validateRpc()
class LabelConfiguratorUI extends RpcTarget implements HomeAssistantLabelConfiguratorRpc {
  constructor(getCredentials: () => Promise<HomeAssistantCredentials>) {
    super();
    resourceConfiguratorGetters.set(this, getCredentials);
  }

  async listLabels(query: string): Promise<HomeAssistantConfiguratorOption[]> {
    const creds = await getResourceConfiguratorCreds(this);
    return await withWebSocket(creds, async (ws) => {
      let list: any[];
      try {
        list = await ws.send<any[]>({ type: "config/label_registry/list" });
      } catch {
        return [];
      }
      return list
        .filter((l: any) => matchesSearch([l.name, l.label_id, l.description], query))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((l: any) => ({
          value: l.label_id,
          title: l.name ?? l.label_id,
          subtitle: l.description ?? undefined,
        }));
    });
  }

  async resourceUrl(labelId: string | null | undefined): Promise<string> {
    if (!labelId) throw new Error("No label selected.");
    return buildLabelUrl(labelId);
  }
}

@validateRpc()
class DeviceConfiguratorUI extends RpcTarget implements HomeAssistantDeviceConfiguratorRpc {
  constructor(getCredentials: () => Promise<HomeAssistantCredentials>) {
    super();
    resourceConfiguratorGetters.set(this, getCredentials);
  }

  async listDevices(query: string): Promise<HomeAssistantConfiguratorOption[]> {
    const creds = await getResourceConfiguratorCreds(this);
    return await withWebSocket(creds, async (ws) => {
      const [devices, areas] = await Promise.all([
        ws.send<any[]>({ type: "config/device_registry/list" }),
        ws.send<any[]>({ type: "config/area_registry/list" }).catch(() => []),
      ]);
      const areaNames = new Map<string, string>(
        (areas as any[]).map((a: any) => [a.area_id, a.name]),
      );
      return (devices as any[])
        .filter((d: any) => !d.disabled_by)
        .map((d: any) => ({
          value: d.id,
          title: d.name_by_user ?? d.name ?? d.id,
          subtitle: [d.manufacturer, d.model].filter(Boolean).join(" "),
          meta: d.area_id ? areaNames.get(d.area_id) : undefined,
        }))
        .filter((opt) => matchesSearch([opt.title, opt.subtitle, opt.meta], query))
        .slice(0, AUTOCOMPLETE_LIMIT);
    });
  }

  async resourceUrl(deviceId: string | null | undefined): Promise<string> {
    if (!deviceId) throw new Error("No device selected.");
    return buildDeviceUrl(deviceId);
  }
}

@validateRpc()
class EntityConfiguratorUI extends RpcTarget implements HomeAssistantEntityConfiguratorRpc {
  constructor(getCredentials: () => Promise<HomeAssistantCredentials>) {
    super();
    resourceConfiguratorGetters.set(this, getCredentials);
  }

  async listEntities(query: string): Promise<HomeAssistantConfiguratorOption[]> {
    const creds = await getResourceConfiguratorCreds(this);
    const snapshot = await fetchRegistrySnapshot(creds);
    const areaNames = new Map<string, string>(
      snapshot.areas.map((a: any) => [a.area_id, a.name]),
    );
    const deviceAreaIds = new Map<string, string | undefined>(
      snapshot.devices.map((d: any) => [d.id, d.area_id]),
    );

    const options: HomeAssistantConfiguratorOption[] = [];
    const seen = new Set<string>();
    for (const reg of snapshot.entities) {
      if (reg.disabled_by || reg.hidden_by) continue;
      const entityId: string = reg.entity_id;
      seen.add(entityId);
      const state = snapshot.states.get(entityId);
      const name =
        reg.name ?? reg.original_name ?? state?.attributes?.friendly_name ?? entityId;
      const areaId = reg.area_id ?? (reg.device_id && deviceAreaIds.get(reg.device_id));
      const areaName = areaId ? areaNames.get(areaId) : undefined;
      options.push({
        value: entityId,
        title: String(name),
        subtitle: entityId,
        meta: areaName,
      });
    }
    // Also include entities present in /api/states but not in the registry.
    for (const [entityId, state] of snapshot.states) {
      if (seen.has(entityId)) continue;
      options.push({
        value: entityId,
        title: state?.attributes?.friendly_name ?? entityId,
        subtitle: entityId,
      });
    }

    return options
      .filter((opt) => matchesSearch([opt.title, opt.subtitle, opt.meta], query))
      .slice(0, AUTOCOMPLETE_LIMIT);
  }

  async resourceUrl(entityId: string | null | undefined): Promise<string> {
    if (!entityId) throw new Error("No entity selected.");
    return buildEntityUrl(entityId);
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl

type HomeAssistantResourceKind = "instance" | "area" | "label" | "device" | "entity";

type HomeAssistantGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: HomeAssistantResourceKind;
  /** For area, label, device, entity: the resource id. */
  resourceId?: string;
};

// HA service-call target as accepted by HA itself (snake_case fields).
export type HATarget = {
  entity_id?: string | string[];
  device_id?: string | string[];
  area_id?: string | string[];
  label_id?: string | string[];
  floor_id?: string | string[];
};

// "Where the write came from" — used to author meaningful action descriptions and (later)
// to drive simulation overlays. The receiving session may be whole-instance or scoped.
export type ActionOrigin =
  | { kind: "session" }
  | { kind: "entity"; entityId: string }
  | { kind: "area"; areaId: string }
  | { kind: "label"; labelId: string }
  | { kind: "device"; deviceId: string }
  | { kind: "dashboard"; urlPath: string };

// All side-effecting actions go through the approval queue as one of these.
export type HomeAssistantAction =
  | {
      id: number;
      type: "callService";
      domain: string;
      service: string;
      data?: Record<string, unknown>;
      target?: HATarget;
      origin: ActionOrigin;
    }
  | {
      id: number;
      type: "fireEvent";
      eventType: string;
      data?: Record<string, unknown>;
      origin: ActionOrigin;
    }
  | {
      id: number;
      type: "saveDashboard";
      /** null = the default "lovelace" dashboard. */
      urlPath: string | null;
      config: unknown;
      origin: ActionOrigin;
    };

// Captured at apply time so we can later restore the prior state via revertAction().
export type HomeAssistantRevertInfo =
  | {
      type: "stateSnapshot";
      previous: Array<{
        entityId: string;
        state: string;
        attributes: Record<string, unknown>;
      }>;
      originalAction: HomeAssistantAction & { type: "callService" };
    }
  | {
      type: "dashboardSnapshot";
      urlPath: string | null;
      previousConfig: unknown;
    }
  | { type: "noRevert" };

// Internal storage row for pending (submitted but not yet applied) actions.
type PendingActionRow = {
  id: number;
  action: HomeAssistantAction;
  submittedAt: number;
};

// Internal storage row for actions that have been applied. Retained so that revertAction() can
// look up the information needed to undo the action. The overseer only passes back the action ID,
// so all revert information lives here in DO storage rather than being round-tripped through the
// overseer.
type AppliedActionRow = {
  id: number;
  action: HomeAssistantAction;
  revertInfo: HomeAssistantRevertInfo;
  appliedAt: number;
};

@validateRpc()
export class HomeAssistantGatekeeperImpl
  extends DurableObject<Env, HomeAssistantGatekeeperImplProps>
  implements Gatekeeper<HomeAssistantSession | Area | Label | Device | Entity>
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<HomeAssistantCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<ResourceDescription> {
    const creds = await this.#getCreds();
    const { resourceKind, resourceId } = this.ctx.props;
    const baseUrl = creds.baseUrl;

    switch (resourceKind) {
      case "instance": {
        let title = "Home Assistant";
        try {
          const config = await new HomeAssistantRest(creds).getConfig();
          if (config?.location_name) title = config.location_name;
        } catch {}
        return {
          url: baseUrl,
          title,
          snippet: `Whole-instance access to ${title} (${baseUrl}).`,
          suggestedBindingName: "HOMEASSISTANT",
          tsType: "HomeAssistantSession",
        };
      }
      case "area": {
        const { areas } = await this.#snapshotMaps();
        const area = areas.get(resourceId!);
        const name = area?.name ?? resourceId!;
        return {
          url: `${baseUrl}/config/areas/area/${encodeURIComponent(resourceId!)}`,
          title: `Area: ${name}`,
          snippet: `Home Assistant area "${name}".`,
          suggestedBindingName: "HOMEASSISTANT_AREA",
          tsType: "Area",
        };
      }
      case "label": {
        const { labels } = await this.#snapshotMaps();
        const label = labels.get(resourceId!);
        const name = label?.name ?? resourceId!;
        return {
          url: `${baseUrl}/config/labels`,
          title: `Label: ${name}`,
          snippet: `All entities carrying the Home Assistant label "${name}".`,
          suggestedBindingName: "HOMEASSISTANT_LABEL",
          tsType: "Label",
        };
      }
      case "device": {
        const { devices } = await this.#snapshotMaps();
        const device = devices.get(resourceId!);
        const name = device?.name_by_user ?? device?.name ?? resourceId!;
        return {
          url: `${baseUrl}/config/devices/device/${encodeURIComponent(resourceId!)}`,
          title: `Device: ${name}`,
          snippet: `Home Assistant device "${name}"${device?.manufacturer ? ` (${device.manufacturer}${device.model ? " " + device.model : ""})` : ""}.`,
          suggestedBindingName: "HOMEASSISTANT_DEVICE",
          tsType: "Device",
        };
      }
      case "entity": {
        const summary = await this.#summarizeEntity(resourceId!).catch(() => undefined);
        const name = summary?.name ?? resourceId!;
        return {
          url: `${baseUrl}/config/entities/entity/${encodeURIComponent(resourceId!)}`,
          title: `Entity: ${name}`,
          snippet: `Home Assistant entity \`${resourceId}\`.`,
          suggestedBindingName: "HOMEASSISTANT_ENTITY",
          tsType: "Entity",
        };
      }
    }
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<HomeAssistantSession | Area | Label | Device | Entity> {
    const ctx = await this.#sessionContext(approvalQueue.dup());
    const { resourceKind, resourceId } = this.ctx.props;
    switch (resourceKind) {
      case "instance":
        return new HomeAssistantSessionImpl(ctx);
      case "area":
        return new AreaImpl(ctx, resourceId!);
      case "label":
        return new LabelImpl(ctx, resourceId!);
      case "device":
        return new DeviceImpl(ctx, resourceId!);
      case "entity":
        return new EntityImpl(ctx, resourceId!);
    }
  }

  async applyAction(actionId: number): Promise<void> {
    // The overseer only knows the numeric action ID; the full action lives in DO storage.
    const pending = this.#getPending(actionId);
    if (!pending) {
      throw new Error(`No queued Home Assistant action exists with id ${actionId}.`);
    }
    const action = pending.action;
    const creds = await this.#getCreds();

    let revertInfo: HomeAssistantRevertInfo;
    try {
      revertInfo = await this.#snapshotForRevert(action, creds);
    } catch {
      // If we can't snapshot, proceed without revert.
      revertInfo = { type: "noRevert" };
    }

    try {
      await executeAction(action, creds);
    } catch (e) {
      if (e instanceof HomeAssistantError && e.isAuthError) {
        await this.#userAccount().noteCredentialsExpired();
      }
      throw e;
    }

    // Action succeeded: move the row from "pending" to "applied", storing the revert info so a
    // later revertAction() can find it (the overseer passes back only the action ID).
    this.#storeApplied(action, revertInfo);
    this.#deletePending(actionId);
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    this.#deletePending(actionId);
    // No simulation state to clean up yet; once Phase 2 (caching/simulation) lands this may
    // need to invalidate overlays. For now, rejection is a no-op apart from clearing storage.
  }

  async revertAction(
    actionId: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    // The overseer passes back only the action ID; we stored everything we need (including the
    // original action, inside `stateSnapshot.originalAction` / `dashboardSnapshot`) under
    // `applied:<id>` when the action was applied.
    const applied = this.#getApplied(actionId);
    if (!applied) {
      throw new Error(`No applied Home Assistant action exists with id ${actionId}.`);
    }
    const revertInfo = applied.revertInfo;
    const creds = await this.#getCreds();
    switch (revertInfo.type) {
      case "noRevert":
        throw new Error("This action cannot be reverted.");
      case "stateSnapshot": {
        // Open one WebSocket for the whole batch.
        const failures: string[] = [];
        await withWebSocket(creds, async (ws) => {
          for (const prev of revertInfo.previous) {
            try {
              await applyRevertForEntity(prev, revertInfo.originalAction, ws);
            } catch (e: any) {
              failures.push(`${prev.entityId}: ${e?.message ?? e}`);
            }
          }
        });
        if (failures.length > 0) {
          return {
            message:
              failures.length === revertInfo.previous.length
                ? `Failed to revert: ${failures.join("; ")}`
                : `Reverted ${revertInfo.previous.length - failures.length} of ${revertInfo.previous.length} entities. Failures: ${failures.join("; ")}`,
            canRetry: failures.length < revertInfo.previous.length,
          };
        }
        return;
      }
      case "dashboardSnapshot": {
        await withWebSocket(creds, async (ws) => {
          await ws.send({
            type: "lovelace/config/save",
            url_path: revertInfo.urlPath,
            config: revertInfo.previousConfig,
          });
        });
        return;
      }
    }
  }

  // Observer tracking: Home Assistant uses the "low-stakes" strategy. It is a self-hosted personal
  // system, and the connection is a long-lived access token that grants the same all-or-nothing
  // access as the HA user who created it — HA has no per-user/per-entity ACL oracle we could verify
  // an observer against. So any collaborator may observe: addObserver/removeObserver are no-ops and
  // we never set excludeObservers on observations.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  // ---------------------------------------------------------------------
  // Internal helpers

  async #sessionContext(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<SessionContext> {
    const creds = await this.#getCreds();
    return this.#buildSessionContext(creds, approvalQueue);
  }

  /** Synchronous helper used by `#sessionContext` and `SessionContext.fork()` to construct a
   * SessionContext given already-resolved credentials and an already-dup'd approvalQueue. */
  #buildSessionContext(
    creds: HomeAssistantCredentials,
    approvalQueue: RpcStub<ApprovalQueue>,
  ): SessionContext {
    const self = this;
    let disposed = false;
    const ctx: SessionContext = {
      creds,
      approvalQueue,
      noteAuthError: () => self.#userAccount().noteCredentialsExpired(),
      dispose() {
        if (disposed) return;
        disposed = true;
        // Release the server-side RpcStub for our dup'd approvalQueue. We cast through
        // `unknown` because RpcStub's TS type doesn't expose Symbol.dispose in workshop-shared's
        // capnweb dependency, but the runtime object does implement it (see gatekeeper-github
        // for the same pattern).
        try {
          (approvalQueue as unknown as { [Symbol.dispose](): void })[Symbol.dispose]();
        } catch {
          // Already-disposed / runtime-missing dispose: ignore.
        }
      },
      async submitWrite(body) {
        // Validate body up front so malformed calls fail immediately with a clear message
        // (rather than ending up in the approval queue or hitting Home Assistant later).
        validateWriteBody(body);

        const id = self.#nextActionId();
        const action = { ...body, id } as HomeAssistantAction;
        const row: PendingActionRow = { id, action, submittedAt: Date.now() };
        self.ctx.storage.kv.put<PendingActionRow>(`pending:${id}`, row);

        let description;
        try {
          const registry = await fetchRegistrySnapshot(creds);
          description = describeAction(action, registry);
        } catch {
          // If registry fetch fails, fall back to a minimal description.
          const emptyRegistry: RegistrySnapshot = {
            areas: [],
            floors: [],
            labels: [],
            devices: [],
            entities: [],
            states: new Map(),
          };
          description = describeAction(action, emptyRegistry);
        }

        try {
          await approvalQueue.submitAction(id, description);
        } catch (e) {
          // The submit failed (e.g., the approval queue stub is gone). Drop the pending row.
          self.#deletePending(id);
          throw e;
        }
      },
      async registrySnapshot() {
        return await fetchRegistrySnapshot(creds);
      },
      listPendingActions() {
        return self.#listPendingActions();
      },
      async registrySnapshotWithOverlay() {
        const snapshot = await fetchRegistrySnapshot(creds);
        const pending = self.#listPendingActions();
        if (pending.length === 0) {
          return { snapshot, appliedCount: 0 };
        }
        const index = indexPendingByEntity(pending, snapshot);
        if (index.size === 0) {
          return { snapshot, appliedCount: 0 };
        }
        // Build a new states map with overlays applied.
        const newStates = new Map<string, any>(snapshot.states);
        let totalApplied = 0;
        const stateRecords: HAStateRecord[] = [];
        const seenIds: string[] = [];
        for (const entityId of index.keys()) {
          const real = snapshot.states.get(entityId);
          if (!real) continue;
          stateRecords.push(real as HAStateRecord);
          seenIds.push(entityId);
        }
        if (stateRecords.length > 0) {
          const { states: overlaid, totalApplied: applied } = overlayEntityStates(
            stateRecords,
            index,
          );
          totalApplied = applied;
          for (let i = 0; i < overlaid.length; i++) {
            newStates.set(seenIds[i], overlaid[i]);
          }
        }
        return {
          snapshot: { ...snapshot, states: newStates },
          appliedCount: totalApplied,
        };
      },
      fork() {
        // Wrap the parent's `approvalQueue` in a fresh `dup()` so the child session can be
        // disposed independently of the parent. Synchronous: reuses `creds` rather than
        // re-running `#getCreds`.
        return self.#buildSessionContext(creds, approvalQueue.dup());
      },
    };
    return ctx;
  }

  /** List currently-pending actions, in chronological order. Reads from DO storage's KV
   * `pending:*` rows. */
  #listPendingActions(): HomeAssistantAction[] {
    const rows = [...this.ctx.storage.kv.list<PendingActionRow>({ prefix: "pending:" })];
    return rows
      .map(([_, row]) => row.action)
      .toSorted((a, b) => a.id - b.id);
  }

  // Action storage (KV layout):
  //   counter:nextActionId  → number
  //   pending:<id>          → PendingActionRow  (submitted, awaiting approval)
  //   applied:<id>          → AppliedActionRow  (approved + applied; retains revert info)

  #nextActionId(): number {
    const v = (this.ctx.storage.kv.get<number>("counter:nextActionId") ?? 0) + 1;
    this.ctx.storage.kv.put("counter:nextActionId", v);
    return v;
  }

  #getPending(id: number): PendingActionRow | undefined {
    return this.ctx.storage.kv.get<PendingActionRow>(`pending:${id}`);
  }

  #deletePending(id: number): void {
    this.ctx.storage.kv.delete(`pending:${id}`);
  }

  /** Record an applied action along with the info needed to revert it later. Keyed by the
   * action's numeric ID so revertAction() can look it up (the overseer passes back only the ID). */
  #storeApplied(action: HomeAssistantAction, revertInfo: HomeAssistantRevertInfo): void {
    const row: AppliedActionRow = {
      id: action.id,
      action,
      revertInfo,
      appliedAt: Date.now(),
    };
    this.ctx.storage.kv.put<AppliedActionRow>(`applied:${action.id}`, row);
  }

  #getApplied(id: number): AppliedActionRow | undefined {
    return this.ctx.storage.kv.get<AppliedActionRow>(`applied:${id}`);
  }

  async #snapshotForRevert(
    action: HomeAssistantAction,
    creds: HomeAssistantCredentials,
  ): Promise<HomeAssistantRevertInfo> {
    if (!canRevert(action)) return { type: "noRevert" };

    if (action.type === "saveDashboard") {
      const previousConfig = await fetchDashboardConfig(action.urlPath, creds);
      return { type: "dashboardSnapshot", urlPath: action.urlPath, previousConfig };
    }

    if (action.type === "callService") {
      // The registry snapshot already includes the current states for every entity (it's
      // built from /api/states + the WS registries), so we can read prior state directly
      // from it instead of issuing one REST round-trip per targeted entity.
      const registry = await fetchRegistrySnapshot(creds);
      const targets = resolveTargets(action.target, registry);
      const previous: Array<{
        entityId: string;
        state: string;
        attributes: Record<string, unknown>;
      }> = [];
      for (const entityId of targets) {
        const state = registry.states.get(entityId);
        if (!state) continue;
        previous.push({
          entityId: state.entity_id,
          state: state.state,
          attributes: state.attributes ?? {},
        });
      }
      return {
        type: "stateSnapshot",
        previous,
        originalAction: action,
      };
    }

    return { type: "noRevert" };
  }

  async #snapshotMaps(): Promise<{
    areas: Map<string, any>;
    labels: Map<string, any>;
    devices: Map<string, any>;
    entities: Map<string, any>;
  }> {
    const creds = await this.#getCreds();
    const snapshot = await fetchRegistrySnapshot(creds);
    return {
      areas: new Map<string, any>(snapshot.areas.map((a: any) => [a.area_id, a])),
      labels: new Map<string, any>(snapshot.labels.map((l: any) => [l.label_id, l])),
      devices: new Map<string, any>(snapshot.devices.map((d: any) => [d.id, d])),
      entities: new Map<string, any>(snapshot.entities.map((e: any) => [e.entity_id, e])),
    };
  }

  async #summarizeEntity(entityId: string): Promise<EntitySummary | undefined> {
    const creds = await this.#getCreds();
    const snapshot = await fetchRegistrySnapshot(creds);
    return summarizeEntity(snapshot, entityId);
  }
}

// ---------------------------------------------------------------------------
// Session context shared by all session/capability objects

interface SessionContext {
  creds: HomeAssistantCredentials;
  approvalQueue: RpcStub<ApprovalQueue>;
  noteAuthError: () => Promise<void>;

  /** Dispose the dup'd approvalQueue RpcStub held in this context. Idempotent: safe to call
   * more than once. The corresponding Session/capability calls this from its `[Symbol.dispose]`
   * to release the server-side stub when the session is no longer needed. */
  dispose(): void;

  /** Create a fork of this context with its own freshly-`dup()`'d approvalQueue, suitable for
   * passing to a child Session/capability (e.g. the EntityImpl returned by AreaImpl.getEntity).
   * The fork's `dispose()` is independent: disposing the child does NOT dispose the parent.
   * Use this whenever a parent capability hands out a sub-capability that lives independently. */
  fork(): SessionContext;

  /** Submit a side-effecting action to the approval queue. Stores a pending row in DO storage
   * and awaits the approval queue. The action body is enriched with a fresh `id`. */
  submitWrite(body: SubmitWriteBody): Promise<void>;

  /** Fetch a fresh registry snapshot (no caching yet). Used both to enrich action descriptions
   * and to power simulation overlays. */
  registrySnapshot(): Promise<RegistrySnapshot>;

  /** Return the current set of pending (submitted-but-not-yet-applied) actions for this
   * gatekeeper, in chronological (submit) order. Used by reads to overlay simulated state on
   * top of real HA state. Synchronous: pending rows live in DO storage's KV. */
  listPendingActions(): HomeAssistantAction[];

  /** Fetch a registry snapshot AND apply pending-action overlays to its `states` map. Returns
   * the per-entity count of pending changes applied (the sum across all entities). Used by
   * read methods that derive from the states map (listEntities, describe, etc.) so simulation
   * is consistent regardless of which path the read takes. */
  registrySnapshotWithOverlay(): Promise<{ snapshot: RegistrySnapshot; appliedCount: number }>;
}

// The fields of a HomeAssistantAction that the caller fills in (everything except `id`, which
// the gatekeeper assigns).
type SubmitWriteBody =
  | Omit<HomeAssistantAction & { type: "callService" }, "id">
  | Omit<HomeAssistantAction & { type: "fireEvent" }, "id">
  | Omit<HomeAssistantAction & { type: "saveDashboard" }, "id">;

// Defensive runtime validation of action bodies. Catches the common mistake of passing a
// single options object where positional arguments were expected, and produces an error
// message that includes a corrected positional call when possible.
function validateWriteBody(body: SubmitWriteBody): void {
  if (!body || typeof body !== "object") {
    throw new TypeError(
      `Internal error: gatekeeper received a non-object action body (got ${typeof body}).`,
    );
  }
  switch (body.type) {
    case "callService": {
      if (typeof body.domain !== "string" || !body.domain) {
        throw new TypeError(buildCallServiceError(body));
      }
      if (typeof body.service !== "string" || !body.service) {
        throw new TypeError(buildCallServiceError(body));
      }
      return;
    }
    case "fireEvent": {
      if (typeof body.eventType !== "string" || !body.eventType) {
        throw new TypeError(
          `fireEvent(eventType, data?): the first argument must be a non-empty event-type ` +
            `string, but got ${describeBadArg(body.eventType)}.\n\n` +
            `Correct usage (positional, not an options object):\n` +
            `    await session.fireEvent("my_event_type", { foo: "bar" });`,
        );
      }
      return;
    }
    case "saveDashboard": {
      if (body.config == null || typeof body.config !== "object") {
        throw new TypeError(
          `saveConfig(config): config must be a Lovelace dashboard configuration object, ` +
            `but got ${describeBadArg(body.config)}.\n\n` +
            `Correct usage: read with getConfig(), modify the JSON, then write back:\n` +
            `    const config = await dashboard.getConfig();\n` +
            `    config.views.push({ title: "New", cards: [] });\n` +
            `    await dashboard.saveConfig(config);`,
        );
      }
      return;
    }
  }
}

// Produce a rich error message for a malformed callService body. Inspects the actual values
// passed and, when the agent appears to have used an options-object form, constructs the
// equivalent correct positional call so the agent can fix it on the next attempt.
function buildCallServiceError(
  body: Omit<HomeAssistantAction & { type: "callService" }, "id">,
): string {
  const { domain, service, data, target, origin } = body;
  const isEntityOrigin = origin?.kind === "entity";

  // Detect options-object form: domain is an object with a "domain" or "service" key inside.
  let suggested: string | undefined;
  if (
    domain &&
    typeof domain === "object" &&
    !Array.isArray(domain) &&
    ("domain" in (domain as object) || "service" in (domain as object))
  ) {
    const opts = domain as Record<string, unknown>;
    const innerDomain = typeof opts.domain === "string" ? opts.domain : undefined;
    const innerService = typeof opts.service === "string" ? opts.service : undefined;
    // Common renames seen in the wild:
    const innerData =
      (opts.data as Record<string, unknown> | undefined) ??
      (opts.serviceData as Record<string, unknown> | undefined) ??
      (opts.service_data as Record<string, unknown> | undefined);
    const innerTargetRaw =
      (opts.target as Record<string, unknown> | undefined) ??
      (opts.targets as Record<string, unknown> | undefined);
    const innerTarget = innerTargetRaw ? normalizeBadTarget(innerTargetRaw) : undefined;

    if (innerDomain || innerService) {
      suggested = renderCallExample({
        domain: innerDomain ?? "<domain>",
        service: innerService ?? "<service>",
        data: innerData,
        target: innerTarget,
        isEntityOrigin,
      });
    }
  }

  const correctExample = renderCallExample({
    domain: typeof domain === "string" && domain ? domain : "light",
    service: typeof service === "string" && service ? service : "turn_on",
    data: typeof data === "object" && data ? data : { brightness: 200 },
    target:
      target && Object.keys(target).length > 0
        ? target
        : isEntityOrigin
          ? undefined
          : { entity_id: "light.kitchen" },
    isEntityOrigin,
  });

  const lines: string[] = [];
  lines.push(
    `Invalid callService arguments. This method takes POSITIONAL arguments (domain, ` +
      `service, data?, target?), NOT a single options object.`,
  );
  lines.push("");
  lines.push(`What you passed:`);
  lines.push(`    domain  = ${describeBadArg(domain)}`);
  lines.push(`    service = ${describeBadArg(service)}`);
  if (data !== undefined) lines.push(`    data    = ${describeBadArg(data)}`);
  if (target !== undefined) lines.push(`    target  = ${describeBadArg(target)}`);
  lines.push("");
  if (suggested) {
    lines.push(`It looks like you wanted to write:`);
    lines.push(`    ${suggested}`);
    lines.push("");
  }
  lines.push(`Correct positional form, for example:`);
  lines.push(`    ${correctExample}`);
  lines.push("");
  lines.push(
    `Tip: prefer typed helpers when available — e.g. ` +
      `\`(await session.getEntity("light.kitchen")).turnOn({ brightness: 200 })\` ` +
      `— they have stronger types and are harder to misuse.`,
  );
  return lines.join("\n");
}

// Map common bad target field names (e.g. entityIds, entity_ids) to the canonical
// ServiceCallTarget field names (entityId, deviceId, etc.) so the suggested call is correct.
function normalizeBadTarget(target: Record<string, unknown>): Record<string, unknown> {
  const renames: Record<string, string> = {
    entity_id: "entityId",
    entity_ids: "entityId",
    entityIds: "entityId",
    device_id: "deviceId",
    device_ids: "deviceId",
    deviceIds: "deviceId",
    area_id: "areaId",
    area_ids: "areaId",
    areaIds: "areaId",
    label_id: "labelId",
    label_ids: "labelId",
    labelIds: "labelId",
    floor_id: "floorId",
    floor_ids: "floorId",
    floorIds: "floorId",
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(target)) {
    const key = renames[k] ?? k;
    // If the source was a singular id but value is an array, keep it; ServiceCallTarget allows
    // string | string[].
    out[key] = v;
  }
  return out;
}

function renderCallExample(opts: {
  domain: string;
  service: string;
  data?: Record<string, unknown>;
  target?: Record<string, unknown>;
  isEntityOrigin: boolean;
}): string {
  const { domain, service, data, target, isEntityOrigin } = opts;
  const args: string[] = [];
  if (isEntityOrigin) {
    args.push(JSON.stringify(service));
    if (data !== undefined) args.push(JSON.stringify(data));
  } else {
    args.push(JSON.stringify(domain));
    args.push(JSON.stringify(service));
    if (data !== undefined || target !== undefined) args.push(JSON.stringify(data ?? {}));
    if (target !== undefined) args.push(JSON.stringify(target));
  }
  const receiver = isEntityOrigin ? "entity" : "session";
  return `await ${receiver}.callService(${args.join(", ")});`;
}

function describeBadArg(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number" || typeof value === "boolean") return `${typeof value} ${value}`;
  if (Array.isArray(value)) {
    try {
      return `array ${JSON.stringify(value)}`;
    } catch {
      return "array";
    }
  }
  if (typeof value === "object") {
    try {
      return `object ${JSON.stringify(value)}`;
    } catch {
      return "object";
    }
  }
  return typeof value;
}

async function callApi<T>(ctx: SessionContext, fn: (rest: HomeAssistantRest) => Promise<T>): Promise<T> {
  const rest = new HomeAssistantRest(ctx.creds);
  try {
    return await fn(rest);
  } catch (e) {
    if (e instanceof HomeAssistantError && e.isAuthError) {
      await ctx.noteAuthError();
    }
    throw e;
  }
}

async function callWs<T>(ctx: SessionContext, fn: (ws: HomeAssistantWebSocket) => Promise<T>): Promise<T> {
  try {
    return await withWebSocket(ctx.creds, fn);
  } catch (e) {
    if (e instanceof HomeAssistantError && e.isAuthError) {
      await ctx.noteAuthError();
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers

function normalizeArea(a: any): AreaInfo {
  return {
    id: a.area_id,
    name: a.name,
    aliases: a.aliases ?? [],
    floorId: a.floor_id ?? undefined,
    icon: a.icon ?? undefined,
    picture: a.picture ?? undefined,
  };
}

function normalizeFloor(f: any): FloorInfo {
  return {
    id: f.floor_id,
    name: f.name,
    level: f.level ?? undefined,
    icon: f.icon ?? undefined,
    aliases: f.aliases ?? [],
  };
}

function normalizeLabel(l: any): LabelInfo {
  return {
    id: l.label_id,
    name: l.name,
    color: l.color ?? undefined,
    icon: l.icon ?? undefined,
    description: l.description ?? undefined,
  };
}

function normalizeDevice(d: any): DeviceInfo {
  return {
    id: d.id,
    name: d.name_by_user ?? d.name ?? d.id,
    manufacturer: d.manufacturer ?? undefined,
    model: d.model ?? undefined,
    hwVersion: d.hw_version ?? undefined,
    swVersion: d.sw_version ?? undefined,
    configEntries: d.config_entries ?? [],
    areaId: d.area_id ?? undefined,
    disabled: d.disabled_by != null,
    labels: d.labels ?? [],
  };
}

function summarizeEntity(
  snapshot: { entities: any[]; devices: any[]; states: Map<string, any> } | Awaited<ReturnType<typeof fetchRegistrySnapshot>>,
  entityId: string,
): EntitySummary | undefined {
  const registryEntity = (snapshot.entities as any[]).find((e: any) => e.entity_id === entityId);
  const state = snapshot.states.get(entityId);
  if (!registryEntity && !state) return undefined;
  return buildSummary(registryEntity, state, snapshot.devices as any[]);
}

function buildSummary(registryEntity: any | undefined, state: any | undefined, devices: any[]): EntitySummary {
  const entityId = registryEntity?.entity_id ?? state?.entity_id;
  const domain = String(entityId).split(".")[0];
  const device = registryEntity?.device_id
    ? devices.find((d: any) => d.id === registryEntity.device_id)
    : undefined;
  const areaId =
    registryEntity?.area_id ??
    device?.area_id ??
    undefined;
  const name =
    registryEntity?.name ??
    registryEntity?.original_name ??
    state?.attributes?.friendly_name ??
    entityId;

  const lastChanged = state?.last_changed ? Date.parse(state.last_changed) : undefined;
  const lastUpdated = state?.last_updated ? Date.parse(state.last_updated) : undefined;

  let entityCategory: "config" | "diagnostic" | undefined;
  if (registryEntity?.entity_category === "config") entityCategory = "config";
  else if (registryEntity?.entity_category === "diagnostic") entityCategory = "diagnostic";

  return {
    entityId,
    domain,
    name,
    state: state?.state ?? "unknown",
    icon: registryEntity?.icon ?? state?.attributes?.icon ?? undefined,
    deviceId: registryEntity?.device_id ?? undefined,
    areaId,
    labels: registryEntity?.labels ?? [],
    entityCategory,
    disabled: registryEntity?.disabled_by != null,
    hidden: registryEntity?.hidden_by != null,
    lastChanged: lastChanged && !Number.isNaN(lastChanged) ? lastChanged : undefined,
    lastUpdated: lastUpdated && !Number.isNaN(lastUpdated) ? lastUpdated : undefined,
  };
}

function normalizeState(raw: any): EntityState {
  return {
    entityId: raw.entity_id,
    state: raw.state,
    attributes: raw.attributes ?? {},
    lastChanged: raw.last_changed,
    lastUpdated: raw.last_updated,
    context: raw.context
      ? {
          id: raw.context.id,
          userId: raw.context.user_id ?? null,
          parentId: raw.context.parent_id ?? null,
        }
      : undefined,
  };
}

function normalizeConfig(raw: any): HomeAssistantConfig {
  return {
    locationName: raw.location_name,
    version: raw.version,
    timeZone: raw.time_zone,
    unitSystem: raw.unit_system ?? {},
    allowlistExternalUrls: raw.allowlist_external_urls ?? undefined,
    latitude: raw.latitude ?? undefined,
    longitude: raw.longitude ?? undefined,
    elevation: raw.elevation ?? undefined,
    currency: raw.currency ?? undefined,
    language: raw.language ?? undefined,
  };
}

function normalizeHistoryBundle(bundle: any[]): EntityHistory[] {
  // HA returns an array of arrays, one per entity, oldest-first.
  const out: EntityHistory[] = [];
  for (const series of bundle) {
    if (!Array.isArray(series) || series.length === 0) continue;
    const entityId = series[0].entity_id ?? series[0].entityId;
    out.push({
      entityId,
      states: series.map((s: any) => ({
        state: s.state,
        attributes: s.attributes ?? {},
        lastChanged: s.last_changed ?? s.lastChanged,
        lastUpdated: s.last_updated ?? s.lastUpdated,
      })),
    });
  }
  return out;
}

function normalizeLogbook(items: any[]): LogbookEntry[] {
  return items.map((i: any) => ({
    when: i.when,
    name: i.name,
    message: i.message,
    entityId: i.entity_id ?? undefined,
    state: i.state ?? undefined,
    domain: i.domain ?? undefined,
    contextUserId: i.context_user_id ?? undefined,
  }));
}

function normalizeServices(raw: any[]): ServiceInfo[] {
  const out: ServiceInfo[] = [];
  for (const domainEntry of raw) {
    const domain = domainEntry.domain;
    const services = domainEntry.services ?? {};
    for (const [serviceName, info] of Object.entries<any>(services)) {
      out.push({
        domain,
        service: serviceName,
        name: info?.name ?? undefined,
        description: info?.description ?? undefined,
        fields: info?.fields ?? undefined,
        target: info?.target ?? undefined,
      });
    }
  }
  return out;
}

function applyEntityFilter(
  summaries: EntitySummary[],
  filter?: EntityFilter,
): EntitySummary[] {
  const f = filter ?? {};
  const domains = f.domain == null ? undefined : Array.isArray(f.domain) ? f.domain : [f.domain];
  const search = f.search ? f.search.toLowerCase() : undefined;

  return summaries.filter((s) => {
    if (!f.includeDisabled && s.disabled) return false;
    if (!f.includeHidden && s.hidden) return false;
    if (!f.includeAuxiliary && s.entityCategory) return false;
    if (domains && !domains.includes(s.domain)) return false;
    if (f.areaId && s.areaId !== f.areaId) return false;
    if (f.labelId && !s.labels.includes(f.labelId)) return false;
    if (f.deviceId && s.deviceId !== f.deviceId) return false;
    if (search) {
      const hay = `${s.entityId}\n${s.name}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function coerceDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Render a parenthetical suffix noting how many pending changes were folded into the result.
 * Used in ObservationDescription text. Returns the empty string if no overlay was applied. */
function pendingSuffix(appliedCount: number): string {
  if (appliedCount <= 0) return "";
  return ` (includes ${appliedCount} pending change${appliedCount === 1 ? "" : "s"})`;
}

function buildTarget(target?: ServiceCallTarget): HATarget | undefined {
  if (!target) return undefined;
  const out: HATarget = {};
  if (target.entityId != null) out.entity_id = target.entityId;
  if (target.deviceId != null) out.device_id = target.deviceId;
  if (target.areaId != null) out.area_id = target.areaId;
  if (target.labelId != null) out.label_id = target.labelId;
  if (target.floorId != null) out.floor_id = target.floorId;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Whole-instance Session

@validateRpc()
class HomeAssistantSessionImpl extends RpcTarget implements HomeAssistantSession {
  #ctx: SessionContext;

  constructor(ctx: SessionContext) {
    super();
    this.#ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  async getConfig(): Promise<HomeAssistantConfig> {
    const config = normalizeConfig(await callApi(this.#ctx, (r) => r.getConfig()));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Home Assistant configuration",
      description:
        `Fetched the HA instance configuration ` +
        `(location: "${config.locationName}", version ${config.version}, ` +
        `timezone ${config.timeZone}).`,
    });
    return config;
  }

  async listAreas(): Promise<AreaInfo[]> {
    const list = await callWs(this.#ctx, async (ws) =>
      ws.send<any[]>({ type: "config/area_registry/list" }),
    );
    const result = list.map(normalizeArea);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant areas",
      description: `Listed ${result.length} area${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listFloors(): Promise<FloorInfo[]> {
    const list = await callWs(this.#ctx, async (ws) => {
      try {
        return await ws.send<any[]>({ type: "config/floor_registry/list" });
      } catch {
        return [];
      }
    });
    const result = list.map(normalizeFloor);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant floors",
      description: `Listed ${result.length} floor${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listLabels(): Promise<LabelInfo[]> {
    const list = await callWs(this.#ctx, async (ws) => {
      try {
        return await ws.send<any[]>({ type: "config/label_registry/list" });
      } catch {
        return [];
      }
    });
    const result = list.map(normalizeLabel);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant labels",
      description: `Listed ${result.length} label${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const list = await callWs(this.#ctx, async (ws) =>
      ws.send<any[]>({ type: "config/device_registry/list" }),
    );
    const result = list.map(normalizeDevice);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant devices",
      description: `Listed ${result.length} device${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listEntities(filter?: EntityFilter): Promise<EntitySummary[]> {
    const { snapshot, appliedCount } = await this.#ctx.registrySnapshotWithOverlay();
    const summaries: EntitySummary[] = [];
    const seen = new Set<string>();
    for (const reg of snapshot.entities) {
      const summary = buildSummary(reg, snapshot.states.get(reg.entity_id), snapshot.devices);
      summaries.push(summary);
      seen.add(reg.entity_id);
    }
    for (const [entityId, state] of snapshot.states) {
      if (seen.has(entityId)) continue;
      summaries.push(buildSummary(undefined, state, snapshot.devices));
    }
    const filtered = applyEntityFilter(summaries, filter);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant entities",
      description:
        `Listed ${filtered.length} entit${filtered.length === 1 ? "y" : "ies"}` +
        (filter ? ` (filter: ${JSON.stringify(filter)})` : "") +
        pendingSuffix(appliedCount) +
        ".",
    });
    return filtered;
  }

  async listDomains(): Promise<string[]> {
    const states = await callApi(this.#ctx, (r) => r.getStates());
    const set = new Set<string>();
    for (const s of states) {
      const id: string = s.entity_id;
      const idx = id.indexOf(".");
      if (idx > 0) set.add(id.slice(0, idx));
    }
    const result = [...set].toSorted();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant integration domains",
      description: `Listed ${result.length} domain${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listServices(domain?: string): Promise<ServiceInfo[]> {
    const raw = await callApi(this.#ctx, (r) => r.getServices());
    let services = normalizeServices(raw);
    if (domain) services = services.filter((s) => s.domain === domain);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant services",
      description:
        `Listed ${services.length} service${services.length === 1 ? "" : "s"}` +
        (domain ? ` in domain \`${domain}\`` : "") +
        ".",
    });
    return services;
  }

  async getArea(id: string): Promise<Area> {
    const snapshot = await this.#ctx.registrySnapshot();
    const area = snapshot.areas.find((a: any) => a.area_id === id);
    if (!area) throw new Error(`Area not found: ${id}`);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open area capability`,
      description: `Opened a capability for area "${area.name}" (\`${id}\`).`,
    });
    // Fork the context: the returned AreaImpl is a separate stub with its own approvalQueue
    // dup, so disposing it doesn't release ours.
    return new AreaImpl(this.#ctx.fork(), id);
  }

  async getLabel(id: string): Promise<Label> {
    const snapshot = await this.#ctx.registrySnapshot();
    const label = snapshot.labels.find((l: any) => l.label_id === id);
    if (!label) throw new Error(`Label not found: ${id}`);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open label capability`,
      description: `Opened a capability for label "${label.name}" (\`${id}\`).`,
    });
    return new LabelImpl(this.#ctx.fork(), id);
  }

  async getDevice(id: string): Promise<Device> {
    const snapshot = await this.#ctx.registrySnapshot();
    const device = snapshot.devices.find((d: any) => d.id === id);
    if (!device) throw new Error(`Device not found: ${id}`);
    const name = device.name_by_user ?? device.name ?? id;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open device capability`,
      description: `Opened a capability for device "${name}" (\`${id}\`).`,
    });
    return new DeviceImpl(this.#ctx.fork(), id);
  }

  async getEntity(entityId: string): Promise<Entity> {
    const state = await callApi(this.#ctx, (r) => r.getState(entityId));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open entity capability`,
      description: `Opened a capability for entity \`${entityId}\` (current state: ${state.state}).`,
    });
    return new EntityImpl(this.#ctx.fork(), entityId);
  }

  async getDashboard(urlPath: string): Promise<Dashboard> {
    // We don't make a round-trip to HA here, but for consistency with the other `get*`
    // capability accessors (`getArea`, `getEntity`, etc.) we still record the act of obtaining
    // the capability in the approval queue. Actual dashboard reads (describe / getConfig) and
    // writes (saveConfig) authorize / submit themselves separately.
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open dashboard capability`,
      description: `Opened a capability for Lovelace dashboard \`${urlPath}\`.`,
    });
    return new DashboardImpl(this.#ctx.fork(), urlPath);
  }

  async callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: ServiceCallTarget,
  ): Promise<void> {
    await this.#ctx.submitWrite({
      type: "callService",
      domain,
      service,
      data,
      target: buildTarget(target),
      origin: { kind: "session" },
    });
  }

  async fireEvent(eventType: string, data?: Record<string, unknown>): Promise<void> {
    await this.#ctx.submitWrite({
      type: "fireEvent",
      eventType,
      data,
      origin: { kind: "session" },
    });
  }

  async renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string> {
    const result = await callApi(this.#ctx, (r) => r.renderTemplate(template, variables));
    const preview = template.length > 80 ? template.slice(0, 77) + "..." : template;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Render Jinja template",
      description:
        `Rendered template \`${preview}\`. Templates can read every entity in the instance, ` +
        `so the result may incorporate state from anywhere in Home Assistant.`,
    });
    return result;
  }

  async getHistory(
    entityIds: string[],
    start: string | Date,
    end?: string | Date,
  ): Promise<EntityHistory[]> {
    const bundle = await callApi(this.#ctx, (r) =>
      r.getHistory(entityIds, coerceDate(start), end ? coerceDate(end) : undefined, false),
    );
    const histories = normalizeHistoryBundle(bundle);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read entity history",
      description:
        `Read state history for ${entityIds.length} entit${entityIds.length === 1 ? "y" : "ies"} ` +
        `from ${coerceDate(start).toISOString()}${end ? ` to ${coerceDate(end).toISOString()}` : ""}.`,
    });
    return histories;
  }

  async getLogbook(
    start: string | Date,
    end?: string | Date,
    entityId?: string,
  ): Promise<LogbookEntry[]> {
    const items = await callApi(this.#ctx, (r) =>
      r.getLogbook(coerceDate(start), end ? coerceDate(end) : undefined, entityId),
    );
    const result = normalizeLogbook(items);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Home Assistant logbook",
      description:
        `Read ${result.length} logbook entr${result.length === 1 ? "y" : "ies"} ` +
        `from ${coerceDate(start).toISOString()}${end ? ` to ${coerceDate(end).toISOString()}` : ""}` +
        (entityId ? ` for entity \`${entityId}\`` : "") +
        ".",
    });
    return result;
  }

  async listDashboards(): Promise<DashboardInfo[]> {
    const list = await callWs(this.#ctx, async (ws) =>
      ws.send<any[]>({ type: "lovelace/dashboards/list" }),
    );
    const result = list.map((d: any) => ({
      urlPath: d.url_path,
      title: d.title,
      icon: d.icon ?? undefined,
      mode: (d.mode ?? "storage") as "storage" | "yaml",
      showInSidebar: d.show_in_sidebar ?? true,
      requireAdmin: d.require_admin ?? false,
    }));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Lovelace dashboards",
      description: `Listed ${result.length} dashboard${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listLovelaceResources(): Promise<LovelaceResourceInfo[]> {
    const list = await callWs(this.#ctx, async (ws) =>
      ws.send<any[]>({ type: "lovelace/resources" }),
    );
    const result = list.map((r: any) => ({ id: r.id, url: r.url, type: r.type }));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Lovelace resources",
      description: `Listed ${result.length} custom Lovelace resource${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Area session/capability

@validateRpc()
class AreaImpl extends RpcTarget implements Area {
  #ctx: SessionContext;
  #areaId: string;

  constructor(ctx: SessionContext, areaId: string) {
    super();
    this.#ctx = ctx;
    this.#areaId = areaId;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  // Internal: fetch without authorize (used to build descriptions for child reads).
  async #snapshot() {
    return await this.#ctx.registrySnapshot();
  }

  async describe(): Promise<AreaInfo> {
    const snap = await this.#snapshot();
    const area = snap.areas.find((a: any) => a.area_id === this.#areaId);
    if (!area) throw new Error(`Area not found: ${this.#areaId}`);
    const info = normalizeArea(area);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Describe area: ${info.name}`,
      description: `Read metadata for area "${info.name}" (\`${info.id}\`).`,
    });
    return info;
  }

  async getFloor(): Promise<FloorInfo | null> {
    const snap = await this.#snapshot();
    const area = snap.areas.find((a: any) => a.area_id === this.#areaId);
    if (!area?.floor_id) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read area floor`,
        description: `Area \`${this.#areaId}\` is not assigned to a floor.`,
      });
      return null;
    }
    const floor = snap.floors.find((f: any) => f.floor_id === area.floor_id);
    const info = floor ? normalizeFloor(floor) : null;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read area floor`,
      description: `Area \`${this.#areaId}\` is on floor "${info?.name ?? area.floor_id}".`,
    });
    return info;
  }

  async listEntities(filter?: Omit<EntityFilter, "areaId">): Promise<EntitySummary[]> {
    const { snapshot: snap, appliedCount } = await this.#ctx.registrySnapshotWithOverlay();
    // `buildSummary()` already resolves an entity's area via its device, so a single pass
    // through `applyEntityFilter` with `areaId: this.#areaId` is sufficient.
    const summaries: EntitySummary[] = snap.entities.map((reg: any) =>
      buildSummary(reg, snap.states.get(reg.entity_id), snap.devices),
    );
    const filtered = applyEntityFilter(summaries, { ...filter, areaId: this.#areaId });
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List entities in area`,
      description:
        `Listed ${filtered.length} entit${filtered.length === 1 ? "y" : "ies"} ` +
        `in area \`${this.#areaId}\`` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return filtered;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const snap = await this.#snapshot();
    const result = snap.devices.filter((d: any) => d.area_id === this.#areaId).map(normalizeDevice);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List devices in area`,
      description:
        `Listed ${result.length} device${result.length === 1 ? "" : "s"} ` +
        `in area \`${this.#areaId}\`.`,
    });
    return result;
  }

  async getEntity(entityId: string): Promise<Entity> {
    const snap = await this.#snapshot();
    const deviceIdsInArea = new Set(
      snap.devices.filter((d: any) => d.area_id === this.#areaId).map((d: any) => d.id),
    );
    const reg = snap.entities.find((e: any) => e.entity_id === entityId);
    const state = snap.states.get(entityId);
    if (!reg && !state) {
      throw new Error(`Entity ${entityId} not found.`);
    }
    const summary = buildSummary(reg, state, snap.devices);
    const inArea =
      summary.areaId === this.#areaId ||
      (summary.deviceId && deviceIdsInArea.has(summary.deviceId));
    if (!inArea) {
      throw new Error(`Entity ${entityId} is not part of area ${this.#areaId}.`);
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open entity capability (in area)`,
      description: `Opened capability for entity \`${entityId}\` within area \`${this.#areaId}\`.`,
    });
    return new EntityImpl(this.#ctx.fork(), entityId);
  }

  async getDevice(deviceId: string): Promise<Device> {
    const snap = await this.#snapshot();
    const device = snap.devices.find((d: any) => d.id === deviceId && d.area_id === this.#areaId);
    if (!device) {
      throw new Error(`Device ${deviceId} is not part of area ${this.#areaId}.`);
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open device capability (in area)`,
      description: `Opened capability for device \`${deviceId}\` within area \`${this.#areaId}\`.`,
    });
    return new DeviceImpl(this.#ctx.fork(), deviceId);
  }

  async callService(domain: string, service: string, data?: Record<string, unknown>): Promise<void> {
    await this.#ctx.submitWrite({
      type: "callService",
      domain,
      service,
      data,
      target: { area_id: this.#areaId },
      origin: { kind: "area", areaId: this.#areaId },
    });
  }

  async getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]> {
    const snap = await this.#snapshot();
    const deviceIdsInArea = new Set(
      snap.devices.filter((d: any) => d.area_id === this.#areaId).map((d: any) => d.id),
    );
    const entityIds: string[] = [];
    for (const reg of snap.entities) {
      const inArea =
        reg.area_id === this.#areaId || (reg.device_id && deviceIdsInArea.has(reg.device_id));
      if (inArea) entityIds.push(reg.entity_id);
    }
    if (entityIds.length === 0) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read area history`,
        description: `Area \`${this.#areaId}\` has no entities to fetch history for.`,
      });
      return [];
    }
    const bundle = await callApi(this.#ctx, (r) =>
      r.getHistory(entityIds, coerceDate(start), end ? coerceDate(end) : undefined, false),
    );
    const histories = normalizeHistoryBundle(bundle);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read area history`,
      description:
        `Read history for ${entityIds.length} entit${entityIds.length === 1 ? "y" : "ies"} ` +
        `in area \`${this.#areaId}\` from ${coerceDate(start).toISOString()}` +
        (end ? ` to ${coerceDate(end).toISOString()}` : "") +
        ".",
    });
    return histories;
  }
}

// ---------------------------------------------------------------------------
// Label session/capability

@validateRpc()
class LabelImpl extends RpcTarget implements Label {
  #ctx: SessionContext;
  #labelId: string;

  constructor(ctx: SessionContext, labelId: string) {
    super();
    this.#ctx = ctx;
    this.#labelId = labelId;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  async #snapshot() {
    return await this.#ctx.registrySnapshot();
  }

  async describe(): Promise<LabelInfo> {
    const snap = await this.#snapshot();
    const label = snap.labels.find((l: any) => l.label_id === this.#labelId);
    if (!label) throw new Error(`Label not found: ${this.#labelId}`);
    const info = normalizeLabel(label);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Describe label: ${info.name}`,
      description: `Read metadata for label "${info.name}" (\`${info.id}\`).`,
    });
    return info;
  }

  async listEntities(filter?: Omit<EntityFilter, "labelId">): Promise<EntitySummary[]> {
    const { snapshot: snap, appliedCount } = await this.#ctx.registrySnapshotWithOverlay();
    const summaries: EntitySummary[] = [];
    for (const reg of snap.entities) {
      const labels: string[] = reg.labels ?? [];
      if (!labels.includes(this.#labelId)) continue;
      summaries.push(buildSummary(reg, snap.states.get(reg.entity_id), snap.devices));
    }
    const filtered = applyEntityFilter(summaries, { ...filter, labelId: this.#labelId });
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List entities with label`,
      description:
        `Listed ${filtered.length} entit${filtered.length === 1 ? "y" : "ies"} ` +
        `carrying label \`${this.#labelId}\`` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return filtered;
  }

  async getEntity(entityId: string): Promise<Entity> {
    const snap = await this.#snapshot();
    const reg = snap.entities.find((e: any) => e.entity_id === entityId);
    const labels: string[] = reg?.labels ?? [];
    if (!labels.includes(this.#labelId)) {
      throw new Error(`Entity ${entityId} does not carry label ${this.#labelId}.`);
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open entity capability (by label)`,
      description: `Opened capability for entity \`${entityId}\` carrying label \`${this.#labelId}\`.`,
    });
    return new EntityImpl(this.#ctx.fork(), entityId);
  }

  async callService(domain: string, service: string, data?: Record<string, unknown>): Promise<void> {
    await this.#ctx.submitWrite({
      type: "callService",
      domain,
      service,
      data,
      target: { label_id: this.#labelId },
      origin: { kind: "label", labelId: this.#labelId },
    });
  }

  async getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]> {
    const snap = await this.#snapshot();
    const entityIds: string[] = [];
    for (const reg of snap.entities) {
      const labels: string[] = reg.labels ?? [];
      if (labels.includes(this.#labelId)) entityIds.push(reg.entity_id);
    }
    if (entityIds.length === 0) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read label history`,
        description: `Label \`${this.#labelId}\` has no entities.`,
      });
      return [];
    }
    const bundle = await callApi(this.#ctx, (r) =>
      r.getHistory(entityIds, coerceDate(start), end ? coerceDate(end) : undefined, false),
    );
    const histories = normalizeHistoryBundle(bundle);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read label history`,
      description:
        `Read history for ${entityIds.length} entit${entityIds.length === 1 ? "y" : "ies"} ` +
        `carrying label \`${this.#labelId}\`.`,
    });
    return histories;
  }
}

// ---------------------------------------------------------------------------
// Device session/capability

@validateRpc()
class DeviceImpl extends RpcTarget implements Device {
  #ctx: SessionContext;
  #deviceId: string;

  constructor(ctx: SessionContext, deviceId: string) {
    super();
    this.#ctx = ctx;
    this.#deviceId = deviceId;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  async #snapshot() {
    return await this.#ctx.registrySnapshot();
  }

  async describe(): Promise<DeviceInfo> {
    const snap = await this.#snapshot();
    const device = snap.devices.find((d: any) => d.id === this.#deviceId);
    if (!device) throw new Error(`Device not found: ${this.#deviceId}`);
    const info = normalizeDevice(device);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Describe device: ${info.name}`,
      description: `Read metadata for device "${info.name}" (\`${this.#deviceId}\`).`,
    });
    return info;
  }

  async getArea(): Promise<AreaInfo | null> {
    const snap = await this.#snapshot();
    const device = snap.devices.find((d: any) => d.id === this.#deviceId);
    if (!device?.area_id) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read device area`,
        description: `Device \`${this.#deviceId}\` is not assigned to an area.`,
      });
      return null;
    }
    const area = snap.areas.find((a: any) => a.area_id === device.area_id);
    const info = area ? normalizeArea(area) : null;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read device area`,
      description: `Device \`${this.#deviceId}\` is in area "${info?.name ?? device.area_id}".`,
    });
    return info;
  }

  async listEntities(filter?: Omit<EntityFilter, "deviceId">): Promise<EntitySummary[]> {
    const { snapshot: snap, appliedCount } = await this.#ctx.registrySnapshotWithOverlay();
    const summaries: EntitySummary[] = [];
    for (const reg of snap.entities) {
      if (reg.device_id !== this.#deviceId) continue;
      summaries.push(buildSummary(reg, snap.states.get(reg.entity_id), snap.devices));
    }
    const filtered = applyEntityFilter(summaries, { ...filter, deviceId: this.#deviceId });
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List entities for device`,
      description:
        `Listed ${filtered.length} entit${filtered.length === 1 ? "y" : "ies"} ` +
        `provided by device \`${this.#deviceId}\`` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return filtered;
  }

  async getEntity(entityId: string): Promise<Entity> {
    const snap = await this.#snapshot();
    const reg = snap.entities.find((e: any) => e.entity_id === entityId);
    if (!reg || reg.device_id !== this.#deviceId) {
      throw new Error(`Entity ${entityId} does not belong to device ${this.#deviceId}.`);
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open entity capability (on device)`,
      description: `Opened capability for entity \`${entityId}\` on device \`${this.#deviceId}\`.`,
    });
    return new EntityImpl(this.#ctx.fork(), entityId);
  }

  async callService(domain: string, service: string, data?: Record<string, unknown>): Promise<void> {
    await this.#ctx.submitWrite({
      type: "callService",
      domain,
      service,
      data,
      target: { device_id: this.#deviceId },
      origin: { kind: "device", deviceId: this.#deviceId },
    });
  }

  async getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]> {
    const snap = await this.#snapshot();
    const entityIds: string[] = [];
    for (const reg of snap.entities) {
      if (reg.device_id === this.#deviceId) entityIds.push(reg.entity_id);
    }
    if (entityIds.length === 0) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read device history`,
        description: `Device \`${this.#deviceId}\` has no entities.`,
      });
      return [];
    }
    const bundle = await callApi(this.#ctx, (r) =>
      r.getHistory(entityIds, coerceDate(start), end ? coerceDate(end) : undefined, false),
    );
    const histories = normalizeHistoryBundle(bundle);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read device history`,
      description:
        `Read history for ${entityIds.length} entit${entityIds.length === 1 ? "y" : "ies"} ` +
        `on device \`${this.#deviceId}\`.`,
    });
    return histories;
  }
}

// ---------------------------------------------------------------------------
// Entity session/capability

@validateRpc()
class EntityImpl extends RpcTarget implements Entity {
  #ctx: SessionContext;
  #entityId: string;

  constructor(ctx: SessionContext, entityId: string) {
    super();
    this.#ctx = ctx;
    this.#entityId = entityId;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  get #domain(): string {
    return this.#entityId.split(".")[0];
  }

  async describe(): Promise<EntitySummary> {
    const { snapshot, appliedCount } = await this.#ctx.registrySnapshotWithOverlay();
    const summary = summarizeEntity(snapshot, this.#entityId);
    if (!summary) throw new Error(`Entity not found: ${this.#entityId}`);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Describe entity: ${summary.name}`,
      description:
        `Read metadata for entity \`${this.#entityId}\` (state: ${summary.state})` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return summary;
  }

  async getState(): Promise<EntityState> {
    // Short-circuit: if no pending actions are queued, we don't need the full registry
    // snapshot just to resolve overlay targets — a single REST round-trip suffices. When
    // there ARE pending actions, fetch state + registry in parallel.
    const pending = this.#ctx.listPendingActions();
    let raw: HAStateRecord;
    let appliedCount = 0;
    if (pending.length === 0) {
      raw = (await callApi(this.#ctx, (r) => r.getState(this.#entityId))) as HAStateRecord;
    } else {
      const [rawState, registry] = await Promise.all([
        callApi(this.#ctx, (r) => r.getState(this.#entityId)),
        this.#ctx.registrySnapshot(),
      ]);
      const result = overlayEntityState(rawState as HAStateRecord, pending, registry);
      raw = result.state;
      appliedCount = result.appliedCount;
    }
    const state = normalizeState(raw);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity state`,
      description:
        `Read state of \`${this.#entityId}\` (current: ${state.state})` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return state;
  }

  async getDevice(): Promise<DeviceInfo | null> {
    const snap = await this.#ctx.registrySnapshot();
    const reg = snap.entities.find((e: any) => e.entity_id === this.#entityId);
    if (!reg?.device_id) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read entity device`,
        description: `Entity \`${this.#entityId}\` is not provided by a device.`,
      });
      return null;
    }
    const device = snap.devices.find((d: any) => d.id === reg.device_id);
    const info = device ? normalizeDevice(device) : null;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity device`,
      description: `Entity \`${this.#entityId}\` is provided by device "${info?.name ?? reg.device_id}".`,
    });
    return info;
  }

  async getArea(): Promise<AreaInfo | null> {
    const snap = await this.#ctx.registrySnapshot();
    const summary = summarizeEntity(snap, this.#entityId);
    if (!summary?.areaId) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read entity area`,
        description: `Entity \`${this.#entityId}\` is not assigned to an area.`,
      });
      return null;
    }
    const area = snap.areas.find((a: any) => a.area_id === summary.areaId);
    const info = area ? normalizeArea(area) : null;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity area`,
      description: `Entity \`${this.#entityId}\` is in area "${info?.name ?? summary.areaId}".`,
    });
    return info;
  }

  async getLabels(): Promise<LabelInfo[]> {
    const snap = await this.#ctx.registrySnapshot();
    const reg = snap.entities.find((e: any) => e.entity_id === this.#entityId);
    const labelIds: string[] = reg?.labels ?? [];
    const result = snap.labels
      .filter((l: any) => labelIds.includes(l.label_id))
      .map(normalizeLabel);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity labels`,
      description: `Entity \`${this.#entityId}\` carries ${result.length} label${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]> {
    const bundle = await callApi(this.#ctx, (r) =>
      r.getHistory([this.#entityId], coerceDate(start), end ? coerceDate(end) : undefined, false),
    );
    const histories = normalizeHistoryBundle(bundle);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity history`,
      description:
        `Read history for \`${this.#entityId}\` from ${coerceDate(start).toISOString()}` +
        (end ? ` to ${coerceDate(end).toISOString()}` : "") +
        ".",
    });
    return histories;
  }

  async getLogbook(start: string | Date, end?: string | Date): Promise<LogbookEntry[]> {
    const items = await callApi(this.#ctx, (r) =>
      r.getLogbook(coerceDate(start), end ? coerceDate(end) : undefined, this.#entityId),
    );
    const result = normalizeLogbook(items);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity logbook`,
      description: `Read ${result.length} logbook entr${result.length === 1 ? "y" : "ies"} for \`${this.#entityId}\`.`,
    });
    return result;
  }

  // ---- Writes ---------------------------------------------------------

  #submitServiceCall(service: string, data?: Record<string, unknown>): Promise<void> {
    return this.#ctx.submitWrite({
      type: "callService",
      domain: this.#domain,
      service,
      data,
      target: { entity_id: this.#entityId },
      origin: { kind: "entity", entityId: this.#entityId },
    });
  }

  async callService(service: string, data?: Record<string, unknown>): Promise<void> {
    await this.#submitServiceCall(service, data);
  }

  // ---- Typed helpers --------------------------------------------------

  async turnOn(data?: LightTurnOnData | Record<string, unknown>): Promise<void> {
    const mapped = mapLightTurnOnData(data);
    // Pre-validation for light-specific numeric ranges.
    if (mapped) {
      if (typeof mapped.brightness === "number" && (mapped.brightness < 0 || mapped.brightness > 255)) {
        throw new Error("brightness must be between 0 and 255.");
      }
      if (typeof mapped.brightness_pct === "number" && (mapped.brightness_pct < 0 || mapped.brightness_pct > 100)) {
        throw new Error("brightnessPct must be between 0 and 100.");
      }
    }
    await this.#submitServiceCall("turn_on", mapped);
  }

  async turnOff(data?: { transition?: number } | Record<string, unknown>): Promise<void> {
    await this.#submitServiceCall("turn_off", data as Record<string, unknown> | undefined);
  }

  async toggle(data?: Record<string, unknown>): Promise<void> {
    await this.#submitServiceCall("toggle", data);
  }

  async open(): Promise<void> {
    await this.#submitServiceCall("open_cover");
  }

  async close(): Promise<void> {
    await this.#submitServiceCall("close_cover");
  }

  async stop(): Promise<void> {
    const d = this.#domain;
    if (d === "cover") await this.#submitServiceCall("stop_cover");
    else if (d === "vacuum") await this.#submitServiceCall("stop");
    else if (d === "media_player") await this.#submitServiceCall("media_stop");
    else await this.#submitServiceCall("stop");
  }

  async setPosition(position: number): Promise<void> {
    if (position < 0 || position > 100) {
      throw new Error("position must be between 0 and 100.");
    }
    await this.#submitServiceCall("set_cover_position", { position });
  }

  async setTemperature(temperature: number, options?: { hvacMode?: string }): Promise<void> {
    const data: Record<string, unknown> = { temperature };
    if (options?.hvacMode != null) data.hvac_mode = options.hvacMode;
    await this.#submitServiceCall("set_temperature", data);
  }

  async setHvacMode(mode: string): Promise<void> {
    await this.#submitServiceCall("set_hvac_mode", { hvac_mode: mode });
  }

  async setFanMode(mode: string): Promise<void> {
    await this.#submitServiceCall("set_fan_mode", { fan_mode: mode });
  }

  async lock(code?: string): Promise<void> {
    const data: Record<string, unknown> = {};
    if (code != null) data.code = code;
    await this.#submitServiceCall("lock", data);
  }

  async unlock(code?: string): Promise<void> {
    const data: Record<string, unknown> = {};
    if (code != null) data.code = code;
    await this.#submitServiceCall("unlock", data);
  }

  async play(): Promise<void> {
    await this.#submitServiceCall("media_play");
  }

  async pause(): Promise<void> {
    await this.#submitServiceCall("media_pause");
  }

  async next(): Promise<void> {
    await this.#submitServiceCall("media_next_track");
  }

  async previous(): Promise<void> {
    await this.#submitServiceCall("media_previous_track");
  }

  async setVolume(volume: number): Promise<void> {
    if (volume < 0 || volume > 1) {
      throw new Error("volume must be between 0 and 1.");
    }
    await this.#submitServiceCall("volume_set", { volume_level: volume });
  }

  async mute(muted: boolean = true): Promise<void> {
    await this.#submitServiceCall("volume_mute", { is_volume_muted: muted });
  }

  async playMedia(mediaContentId: string, mediaContentType: string): Promise<void> {
    await this.#submitServiceCall("play_media", {
      media_content_id: mediaContentId,
      media_content_type: mediaContentType,
    });
  }

  async setSpeed(percentage: number): Promise<void> {
    if (percentage < 0 || percentage > 100) {
      throw new Error("percentage must be between 0 and 100.");
    }
    await this.#submitServiceCall("set_percentage", { percentage });
  }

  async start(): Promise<void> {
    await this.#submitServiceCall("start");
  }

  async returnToBase(): Promise<void> {
    await this.#submitServiceCall("return_to_base");
  }

  async locate(): Promise<void> {
    await this.#submitServiceCall("locate");
  }

  async activate(): Promise<void> {
    await this.#submitServiceCall("turn_on");
  }

  async run(variables?: Record<string, unknown>): Promise<void> {
    await this.#submitServiceCall("turn_on", variables ? { variables } : undefined);
  }

  async press(): Promise<void> {
    await this.#submitServiceCall("press");
  }

  async setValue(value: number): Promise<void> {
    await this.#submitServiceCall("set_value", { value });
  }

  async setText(value: string): Promise<void> {
    await this.#submitServiceCall("set_value", { value });
  }

  async selectOption(option: string): Promise<void> {
    await this.#submitServiceCall("select_option", { option });
  }

  async setDateTime(value: { date?: string; time?: string; datetime?: string }): Promise<void> {
    const data: Record<string, unknown> = {};
    if (value.date != null) data.date = value.date;
    if (value.time != null) data.time = value.time;
    if (value.datetime != null) data.datetime = value.datetime;
    await this.#submitServiceCall("set_datetime", data);
  }

  async trigger(): Promise<void> {
    await this.#submitServiceCall("trigger");
  }

  async reload(): Promise<void> {
    await this.#submitServiceCall("reload");
  }

  async notify(message: string, title?: string, data?: Record<string, unknown>): Promise<void> {
    const payload: Record<string, unknown> = { message };
    if (title != null) payload.title = title;
    if (data != null) payload.data = data;
    await this.#submitServiceCall("send_message", payload);
  }
}

function mapLightTurnOnData(data?: LightTurnOnData | Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  // If this looks like a LightTurnOnData (has any of the known keys), map to HA's snake_case
  // naming. Otherwise pass through as-is.
  const known = [
    "brightness",
    "brightnessPct",
    "colorTemp",
    "colorTempKelvin",
    "rgbColor",
    "xyColor",
    "hsColor",
    "colorName",
    "transition",
    "effect",
    "flash",
  ];
  const looksTyped = known.some((k) => k in data);
  if (!looksTyped) return data as Record<string, unknown>;

  const d = data as LightTurnOnData;
  const out: Record<string, unknown> = {};
  if (d.brightness != null) out.brightness = d.brightness;
  if (d.brightnessPct != null) out.brightness_pct = d.brightnessPct;
  if (d.colorTemp != null) out.color_temp = d.colorTemp;
  if (d.colorTempKelvin != null) out.color_temp_kelvin = d.colorTempKelvin;
  if (d.rgbColor != null) out.rgb_color = d.rgbColor;
  if (d.xyColor != null) out.xy_color = d.xyColor;
  if (d.hsColor != null) out.hs_color = d.hsColor;
  if (d.colorName != null) out.color_name = d.colorName;
  if (d.transition != null) out.transition = d.transition;
  if (d.effect != null) out.effect = d.effect;
  if (d.flash != null) out.flash = d.flash;
  return out;
}

// ---------------------------------------------------------------------------
// Dashboard

@validateRpc()
class DashboardImpl extends RpcTarget implements Dashboard {
  #ctx: SessionContext;
  #urlPath: string;

  constructor(ctx: SessionContext, urlPath: string) {
    super();
    this.#ctx = ctx;
    this.#urlPath = urlPath;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  // Internal helper (no authorize) used by saveConfig() to look up the mode.
  async #describeRaw(): Promise<DashboardInfo> {
    return await callWs(this.#ctx, async (ws) => {
      const list = await ws.send<any[]>({ type: "lovelace/dashboards/list" });
      const found = list.find((d: any) => d.url_path === this.#urlPath);
      if (!found) {
        if (this.#urlPath === "lovelace") {
          return {
            urlPath: "lovelace",
            title: "Overview",
            mode: "storage",
            showInSidebar: true,
            requireAdmin: false,
          };
        }
        throw new Error(`Dashboard not found: ${this.#urlPath}`);
      }
      return {
        urlPath: found.url_path,
        title: found.title,
        icon: found.icon ?? undefined,
        mode: (found.mode ?? "storage") as "storage" | "yaml",
        showInSidebar: found.show_in_sidebar ?? true,
        requireAdmin: found.require_admin ?? false,
      };
    });
  }

  async describe(): Promise<DashboardInfo> {
    const info = await this.#describeRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Describe dashboard: ${info.title}`,
      description: `Read metadata for dashboard \`${this.#urlPath}\` (mode: ${info.mode}).`,
    });
    return info;
  }

  async getConfig(): Promise<DashboardConfig> {
    const real = await callWs(this.#ctx, async (ws) =>
      ws.send<DashboardConfig>({
        type: "lovelace/config",
        url_path: this.#urlPath === "lovelace" ? null : this.#urlPath,
      }),
    );
    // Overlay any pending saveDashboard actions for this dashboard so the reader sees a
    // simulated post-write configuration.
    const pending = this.#ctx.listPendingActions();
    const urlPathArg = this.#urlPath === "lovelace" ? null : this.#urlPath;
    const { config: overlaid, appliedCount } = overlayDashboardConfig(real, urlPathArg, pending);
    const config = overlaid as DashboardConfig;
    const viewCount = Array.isArray(config?.views) ? config.views.length : 0;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read dashboard config: ${this.#urlPath}`,
      description:
        `Read Lovelace configuration for dashboard \`${this.#urlPath}\` ` +
        `(${viewCount} view${viewCount === 1 ? "" : "s"})` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return config;
  }

  async saveConfig(config: DashboardConfig): Promise<void> {
    // We don't preflight-check YAML-mode dashboards here — doing so would require opening a
    // WebSocket connection at submit time just to read the dashboard list. Instead, executeAction
    // performs the check at apply time, where a WebSocket is already open for the save itself,
    // and HA itself returns an error for YAML-mode dashboards (which propagates as an action
    // failure that the user sees in the approval queue).
    await this.#ctx.submitWrite({
      type: "saveDashboard",
      urlPath: this.#urlPath === "lovelace" ? null : this.#urlPath,
      config: config as unknown,
      origin: { kind: "dashboard", urlPath: this.#urlPath },
    });
  }
}
