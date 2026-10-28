/// <reference types="vite/client" />

// Stub declarations for the Cloudflare Workers types the shared package mentions. The app compiles
// @gadgets/workshop-shared from source, which includes server-side types it never uses.
declare module 'cloudflare:workers' {
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {}
  export class DurableObject<Env = unknown, Props = unknown> {}
  export class RpcTarget {}
  export type RpcStub<T> = T
}

declare type Fetcher<T = unknown> = import('capnweb').RpcStub<T>
declare interface DurableObjectClass<T = unknown> {}
