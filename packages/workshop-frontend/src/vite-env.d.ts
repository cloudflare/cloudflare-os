/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Override the local backend host used by Vite dev, e.g. "localhost:9000".
  readonly VITE_BACKEND_HOST?: string;

  // Set to "true" to enable Cloudflare Access authentication mode.
  // In this mode, password-based login/signup is disabled and the app authenticates
  // via the CF Access JWT that Access injects into requests before they reach the server.
  readonly VITE_CF_ACCESS_MODE?: string;

  // The build's id, which VERSION_PATH answers as `assets` (scripts/assets-build-id.ts);
  // undefined outside a build.
  readonly ASSETS_BUILD_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Stub declarations for Cloudflare Workers types used by the shared package.
// The frontend compiles @gadgets/workshop-shared source via path aliases, so it needs
// minimal type stubs for server-side types that appear in the shared interfaces.

declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {}
  export class DurableObject<Env = unknown, Props = unknown> {}
  export class RpcTarget {}
  export type RpcStub<T> = T;
}

declare type Fetcher<T = unknown> = import('capnweb').RpcStub<T>;
declare interface DurableObjectClass<T = unknown> {}
