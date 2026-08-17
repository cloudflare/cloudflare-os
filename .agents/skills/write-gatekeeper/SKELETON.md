# Gatekeeper Implementation Skeleton

Replace all `My`/`my`/`MY` prefixes with the service name.

## Main implementation (`src/<name>.ts`)

```typescript
import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import {
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  Gatekeeper,
  HookController,        // Remove if no hooks
  HookInitiator,         // Remove if no hooks
  HookTargetMetadata,    // Remove if no hooks
  ResourceDescription,
  ApprovalQueue,
  ObservationDescription,
  VendorDescription,
  GatekeeperConnectCallback,
  AccountDescription,
  SupportedResource,
  ResourceConfiguratorFrame,
} from '@gadgets/workshop-shared/gatekeeper';
import { MySession, MyHook as MyHookIface } from "./types";  // Remove MyHook if no hooks
import TYPES_CODE from "./types.txt";
import MY_CONFIGURATOR_HTML from "./generated/my-configurator-ui.txt";

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;  // 10 minutes

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  let encoder = new TextEncoder();
  let bufA = encoder.encode(a);
  let bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

type Env = Cloudflare.Env & {
  BASE_URL?: string,
};

function getBaseUrl(env: Env) {
  return (env.BASE_URL || "http://localhost:8787/gatekeeper/<name>").replace(/\/+$/, "");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to the Gadgets Workshop.
  </body>
</html>`;

const MY_RESOURCE: SupportedResource = {
  urlPattern: "https://example.com/*",
  title: "My Resource",
  description: "Access a specific resource.",
};

// ---------------------------------------------------------------------------
// HTTP handler — serves the browser-based auth flow.
// For a complete OAuth example, see gatekeeper-google/src/google.ts.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      // Auth initiation: the user has visited the connect URL.
      let doId = path[0];
      let nonce = path[1];
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      if (!await stub.verifyNonce(nonce)) {
        // Show a friendly error page for expired/replayed links.
        return new Response("TODO: error HTML", {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // TODO: Redirect to external auth provider, or present an auth form.
      // For OAuth, generate a second nonce for the `state` parameter here —
      // see gatekeeper-google for the full pattern.
      throw new Error("TODO: implement auth initiation");
    } else {
      return new Response("Not Found", {status: 404});
    }
  }
};

// ---------------------------------------------------------------------------
// Vendor — top-level API exposed to the Workshop

export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "My Service",
      url: "https://example.com",
      logo: { url: "TODO: data URL or hosted image URL" },
      color: "#f0f4ff",
      tagline: "Short summary of what this connector enables",
      description:
          "Explain what Gadgets can do with this connector in plain language.",
    };
  }

  // This skeleton has no independently grantable resources, so it ignores
  // `options.resourceUrlPatterns` and stores an empty requested-resource list. Gatekeepers with
  // grantable resources should follow gatekeeper-google.
  async connectAccount(
      callback: Fetcher<GatekeeperConnectCallback>,
      _options?: {resourceUrlPatterns?: string[]}): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce, []);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [MY_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores per-user credentials (tokens, API keys, etc.).
// For a full OAuth implementation with two-phase nonces and reconnect support,
// see gatekeeper-google.
export class UserAccount extends DurableObject<Env> {
  async setCallback(
      callback: Fetcher<GatekeeperConnectCallback>,
      nonce: string,
      requestedResourceUrlPatterns: string[]) {
    // Self-destruct if the connect flow is never completed.
    if (!this.ctx.storage.kv.get<string>("credentials")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
    this.ctx.storage.kv.put("requestedResourceUrlPatterns", requestedResourceUrlPatterns);
  }

  // Verify and consume the nonce from the initiation URL. Prevents replay.
  // Returns false if the nonce is invalid or expired.
  async verifyNonce(nonce: string): Promise<boolean> {
    let stored = this.ctx.storage.kv.get<{value: string, expiresAt: number}>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");
    return true;
  }

  // Called when the user completes authorization. Store credentials and notify the workshop.
  async completeConnection(/* auth result params */) {
    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Authorization timed out. Please try again.");
    }

    // TODO: Store credentials obtained from the auth flow
    this.ctx.storage.kv.put<string>("credentials", "TODO");

    let props: MyUserImplProps = { userObjectId: this.ctx.id.toString() };
    try {
      await callback.complete(this.ctx.exports.MyUserImpl({ props }));
    } catch (err) {
      this.ctx.storage.kv.delete("credentials");
      throw err;
    }
  }

  async getAccessToken(): Promise<string> {
    // TODO: Return a cached short-lived token, refreshing credentials if needed.
    let token = this.ctx.storage.kv.get<string>("credentials");
    if (!token) throw new Error("No credentials set.");
    return token;
  }

  async alarm() {
    if (!this.ctx.storage.kv.get<string>("credentials")) {
      this.ctx.storage.deleteAll();
    }
  }

  async revoke() {
    // TODO: Revoke credentials with the external service
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl — maps resource URLs to gatekeeper DO classes

type MyUserImplProps = {
  userObjectId: string;
};

export class MyUserImpl extends WorkerEntrypoint<Env, MyUserImplProps>
                         implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    // TODO: Fetch account info from external service using stored credentials
    return {
      displayName: "TODO",
      avatar: { url: "" },
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [MY_RESOURCE];
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== MY_RESOURCE.urlPattern) {
      throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let userAccount = this.ctx.exports.UserAccount.get(id);
    let ui = new MyConfiguratorUI(async () => {
      // TODO: Return a short-lived token or construct a read-only API client.
      // Keep this helper private; do not expose it as an RPC method.
      return await userAccount.getAccessToken();
    });
    return {
      iframeHtml: MY_CONFIGURATOR_HTML,
      ui: new RpcStub(ui),
    };
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    // Parse URL to determine resource type and extract identifiers.
    // Return a DO class with props baked in via ctx.exports.<ClassName>({props}).
    // The Overseer will instantiate this class as a facet.
    let props: MyGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      // TODO: resource-specific fields extracted from URL
    };
    return {
      class: this.ctx.exports.MyGatekeeperImpl({ props }),
      resource: MY_RESOURCE,
    };
  }

  async revoke(): Promise<void> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    await this.ctx.exports.UserAccount.get(id).revoke();
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  // Mint a verifier representing this account (see Observers in SKILL.md). The overseer only ever
  // hands it back to a gatekeeper of THIS vendor, so MyGatekeeperImpl.addObserver may trust it.
  // For a strategy-D (low-stakes) gatekeeper, MyVerifier has no methods and this still works.
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    let props: MyVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.MyVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier — answers "can this observer access X?" against the OBSERVER's own credentials.
// For strategy D, replace this with a no-op public method; an empty WorkerEntrypoint is not registered
// in ctx.exports. Keep/extend it for strategy B (single-unit ACL) or C (data-set tracking). See SKILL.md.

type MyVerifierProps = {
  userObjectId: string;
};

// A vendor-specific interface adding non-standard methods to the opaque GatekeeperUserVerifier.
// addObserver casts the Fetcher back to this; the overseer's same-vendor guarantee makes that safe.
export interface MyVerifierApi extends GatekeeperUserVerifier {
  hasResourceAccess(resourceId: string): Promise<boolean>;
}

export class MyVerifier extends WorkerEntrypoint<Env, MyVerifierProps>
    implements MyVerifierApi {
  async hasResourceAccess(resourceId: string): Promise<boolean> {
    let account = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    void account; void resourceId;
    // TODO: query the service with the observer's own token. Return true on success; return false
    // for access errors (e.g. 401/403/404); rethrow anything else so the open fails loudly rather
    // than silently denying.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Resource configurator — narrow iframe helper API

const configuratorTokenGetters = new WeakMap<object, () => Promise<string>>();

class MyConfiguratorUI extends RpcTarget {
  constructor(getToken: () => Promise<string>) {
    super();
    configuratorTokenGetters.set(this, getToken);
  }

  async listResources(query: string): Promise<{ value: string; title: string }[]> {
    let getToken = configuratorTokenGetters.get(this);
    if (!getToken) throw new Error("Configurator is not initialized.");
    let token = await getToken();
    void token;
    // TODO: Call read-only external APIs and return bounded search results.
    return [{ value: query || "example", title: query || "Example" }];
  }

}

// ---------------------------------------------------------------------------
// Hook type — remove this section (and the HookController/HookInitiator/HookTargetMetadata
// imports, the `subscribe` method, the `hookTsType` field, and MyHookControllerImpl) if the
// gatekeeper doesn't push events.
//
// The hook interface from types.d.ts is implemented by the Gadget as an RpcTarget. Intersect it
// with RpcTarget so it satisfies the HookController/HookInitiator generic constraints (Hook
// extends RpcTarget).
//
// Note that you can also use a plain function as a hook type, e.g. `RpcStub<() => Promise<void>>`.
// In that case you would not need to merge the type with `RpcTarget`.

type MyHook = RpcTarget & MyHookIface;

// ---------------------------------------------------------------------------
// GatekeeperImpl DO — per-resource instance, runs as a facet of the Overseer

type MyGatekeeperImplProps = {
  userObjectId: string;
  // ... resource-specific fields (e.g., documentId, repoOwner)
};

export class MyGatekeeperImpl extends DurableObject<Env, MyGatekeeperImplProps>
    implements Gatekeeper<MySession> {

  async describe(): Promise<ResourceDescription> {
    return {
      url: "TODO: canonical resource URL",
      title: "TODO",
      snippet: "TODO",
      suggestedBindingName: "MY_RESOURCE",  // Based on type, not instance
      tsType: "MySession",
      hookTsType: "MyHook",  // Remove if hooks are not supported
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<MySession> {
    return new MySessionImpl(
      approvalQueue.dup(),  // Always dup() before storing
      this.ctx,
      // ... API client, props, etc.
    );
  }

  async applyAction(actionId: number): Promise<void> {
    // Look up the action by ID from this gatekeeper's own storage, then perform it
    // against the external service.
    // TODO: Implement action lookup and execution.
    throw new Error(`Unknown action: ${actionId}`);
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    // Clean up simulation state for this action.
    // Return { restart: true } if the session can't recover from rejection.
  }

  revertAction(actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    // TODO: Undo the action (look up what was done from own storage)
    throw new Error("Revert not implemented");
  }

  // Observers (see SKILL.md "Observer verification"). This skeleton shows strategy B — ACL check on
  // a single atomic resource. The overseer calls addObserver on EVERY open by every observer, so it
  // re-verifies live access; throw to deny.
  //   - Strategy A (private-only): `async addObserver() { throw new Error("...not shareable..."); }`
  //   - Strategy D (low-stakes):   make both methods no-ops.
  //   - Strategy C (data-set tracking): record observed sets + store verifiers, and route every read
  //     through an authorizeSetObservation helper that sets `excludeObservers` (see SKILL.md).
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<MyVerifierApi>;
    if (!(await verifier.hasResourceAccess(/* this.ctx.props.resourceId */ "TODO"))) {
      throw new Error(
        "This collaborator does not have access to the bound resource, so they cannot observe " +
        "data the Gadget read from it.");
    }
  }

  // Idempotent: ignore unknown ids. A no-op for strategy A/B (nothing is tracked).
  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// HookController — remove if the gatekeeper doesn't push events.
//
// A WorkerEntrypoint the overseer uses to enable/disable the hook after the user approves it.
// It is constructed with `props` carrying the specifics of that particular registration, so it
// needs no other state. If your gatekeeper offers several kinds of hooks, give each its own
// controller class.

// Bind-time details for a single hook registration, baked into the controller's props.
type MyHookProps = {
  // TODO: e.g. an event kind, a filter, a sub-resource id, etc. — whatever the registration
  // method received and the controller/event source will need later.
  filter?: string;
};

type MyHookControllerImplProps = MyGatekeeperImplProps & MyHookProps;

export class MyHookControllerImpl extends WorkerEntrypoint<Env, MyHookControllerImplProps>
    implements HookController<MyHook> {
  // Called when the user enables the hook. Store `initiator` somewhere it can be reached when an
  // event arrives — typically an event-source DO. Don't store other state until now; everything
  // else is already in `this.ctx.props`. If already enabled, replace the previous initiator.
  //
  // `target` identifies where the hook delivers (workspace, and gadget when pinned to one). Store
  // it too if you display or link to the target; otherwise ignore it, but keep the parameter
  // declared — RPC argument validation rejects arguments the receiver doesn't declare.
  async enable(initiator: Fetcher<HookInitiator<MyHook>>, target: HookTargetMetadata): Promise<void> {
    // TODO: persist `initiator` (e.g. forward it to an event-source DO keyed by props).
  }

  // Called when the hook is disabled or deleted. Forget the stored initiator and clean up all
  // related state. May never be called again, though the overseer may later call enable() afresh.
  async disable(): Promise<void> {
    // TODO: forget the stored initiator.
  }
}

// Event delivery (sketch). When the external event arrives — e.g. in the event-source DO that
// holds the `initiator` — invoke the hook like so:
//
//   async onEvent(initiator: Fetcher<HookInitiator<MyHook>>, event: MyEvent) {
//     // startHook() begins a fresh session and returns the callback (re-bound to it) plus an
//     // ApprovalQueue. `using` disposes the result (and its stubs) at end of scope.
//     using result = initiator.startHook();
//
//     // A hook event is almost always an observation. (Register actions too if invoking the
//     // callback can cause side effects.) Pipeline through the not-yet-resolved promise.
//     await result.approvalQueue.authorizeObservation({
//       title: "TODO: short event summary",
//       description: "TODO: details about the event being delivered",
//     });
//
//     // Deliver the event to the Gadget's callback.
//     await result.callback.onMyEvent(event);
//   }

// ---------------------------------------------------------------------------
// SessionImpl — the RPC interface exposed to the Gadget

class MySessionImpl extends RpcTarget implements MySession {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #ctx: DurableObjectState<MyGatekeeperImplProps>;

  constructor(
      approvalQueue: RpcStub<ApprovalQueue>,
      ctx: DurableObjectState<MyGatekeeperImplProps>) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#ctx = ctx;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  // Example: observation (read). Fetch data, then authorize before returning.
  async getData(): Promise<string> {
    let result = "TODO: fetch from service or cache";

    await this.#approvalQueue.authorizeObservation({
      title: "Read data",
      description: "Fetched data from the service.",
    });

    return result;
  }

  // Example: action (side effect). Submit for approval; do NOT perform here.
  // Assign a sequential action ID, store the action details in the gatekeeper's
  // own storage, then submit the ID to the approval queue.
  async updateData(newValue: string): Promise<void> {
    let actionId = /* assign next sequential ID and store action details */ 0;

    await this.#approvalQueue.submitAction(actionId, {
      title: "Update data",
      description: `Update value to: ${newValue}`,
      implementsRevert: true,
    });

    // TODO: Update cache/simulation state so subsequent reads reflect this
  }

  // Example: hook registration — remove if the gatekeeper doesn't push events.
  // `callback` is a persistent stub the Gadget created with ctx.restore(). Construct a controller
  // whose props capture the specifics of THIS registration (e.g. `filter`), then hand it, the
  // callback, and a user-facing description to the overseer via bindHook(). For multiple hook
  // kinds, pick the appropriate controller class here. Do NOT store the callback yourself — it is
  // bound to this session and would be revoked when the session ends.
  async subscribe(callback: RpcStub<MyHook>, filter?: string): Promise<void> {
    let controller = this.#ctx.exports.MyHookControllerImpl({
      props: { ...this.#ctx.props, filter },
    });
    await this.#approvalQueue.bindHook(controller, callback, {
      title: "TODO: short hook title",
      description: `TODO: what events this hook delivers${filter ? ` (filter: ${filter})` : ""}`,
    });
  }
}
```

## `wrangler.jsonc`

```jsonc
{
  "name": "gatekeeper-<name>",
  "main": "src/<name>.ts",
  "compatibility_date": "2026-02-02",
  "compatibility_flags": ["allow_irrevocable_stub_storage"],
  "migrations": [
    {
      "tag": "v0",
      "new_sqlite_classes": ["UserAccount", "MyGatekeeperImpl"]
    }
  ]
}
```

Only Durable Object classes go in `new_sqlite_classes`. `MyVerifier` and `MyHookControllerImpl` are `WorkerEntrypoint`s, so they need no migration entry — but, like all entrypoints, they must be `export`ed from the worker's main module (so `ctx.exports.MyVerifier(...)` resolves). If your hook uses a dedicated event-source DO to hold the `initiator`, add that DO here too.

## Creating the `types.txt` symlink

```bash
cd packages/gatekeeper-<name>/src
ln -s types.d.ts types.txt
```

## Resource configurator files

Add per-resource configurator types and UI modules:

```
src/configurator/my-configurator-types.d.ts
src/configurator/my-configurator-types.txt -> my-configurator-types.d.ts
src/configurator/my-configurator-ui.tsx
```

`my-configurator-types.d.ts` should describe the iframe helper API. The UI module's own `resourceUrl()` hook returns the resource URL to Workshop.

```typescript
export interface MyConfiguratorUI {
  listResources(query: string): Promise<{ value: string; title: string }[]>;
}
```

Add package scripts:

```json
{
  "scripts": {
    "deploy": "vp run --no-cache build:configurator && wrangler deploy"
  },
  "dependencies": {
    "@gadgets/configurator-ui": "workspace:*"
  }
}
```

No `build` script: `build` is one of the shared Vite+ tasks below, and vp forbids a task and a
script sharing a name. Build this one package with `pnpm exec vp run -F <package-name> build` —
`pnpm --filter` cannot see a task, so `pnpm --filter <package-name> build` reports nothing to run;
the workspace-wide `pnpm build` picks it up as usual. `deploy` goes through the task rather than
calling
`build-gatekeeper-configurator.ts` itself, so the codegen command lives in one place and cannot
drift from the task that declares its env — `wrangler deploy` stays outside vp, since it has side
effects and needs real credentials.

Also add a `vite.config.ts` re-exporting the shared `build` and `build:configurator` Vite+ tasks —
the latter is what the `pnpm dev-server` pre-flight builds (`vp run -r --cache build:configurator
--dev`). Both are tasks rather than package.json scripts so `VITE_FRONTEND_ERROR_REPORTING` is
passed through and cache-fingerprinted; a `build` script running the builder with `&&` would bypass
that and silently bake the wrong value into the shipped HTML (do not add either script back):

```typescript
// Vite+ per-package settings. The build:configurator task definition is shared by all gatekeepers
// with a configurator UI and lives beside the builder it runs.
export { default } from '../../scripts/gatekeeper-configurator-vite-config.js'

// ...or, if the gatekeeper has tests, `withTests` instead: the same settings plus the shared vitest
// `test` task. Add a `"test:run": "vitest run"` script too, for iterating without the cache.
export { withTests as default } from '../../scripts/gatekeeper-configurator-vite-config.js'
```

Keep tokens and broad API clients out of public `RpcTarget` properties; use closures, `#private`, or `WeakMap` state and expose only narrow read-only helper methods.
