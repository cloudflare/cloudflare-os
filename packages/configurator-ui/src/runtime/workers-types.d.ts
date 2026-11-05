// The runtime implements the frame side of `@gadgets/workshop-shared/gatekeeper`, whose source also
// names server-side Workers types. These stubs stand in for them, as the Workshop frontend's do
// (`workshop-frontend/src/vite-env.d.ts`); nothing in the runtime uses them.

declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {}
  export class DurableObject<Env = unknown, Props = unknown> {}
  export class RpcTarget {}
  export type RpcStub<T> = T;
}

declare type Fetcher<T = unknown> = import("capnweb").RpcStub<T>;
declare interface DurableObjectClass<T = unknown> {}
