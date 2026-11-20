// The operations the gatekeeper calls, as the kit's typed client takes them: Acme Service's, from
// its OpenAPI description, and for now the ones the scaffold invented.

import type { Schema } from "@gadgets/gatekeeper-kit/http";
import type { WireItem, WireUser } from "./acme-api";
import type { Api as Described } from "./openapi";

// STOP(api): `Invented` is what the scaffold's own calls use, and no call of the provider's. The
// provider's operations are `Described`, generated into src/openapi/ from openapi.json for the
// operations openapi-operations.jsonl lists. Move each call onto one of them, adding its line to
// the list (`pnpm exec gatekeeper-openapi-schema openapi.json --list` prints them all) and running
// `pnpm generate:openapi`. Where the provider has an invented call's own method and path, such as
// `GET /me`, delete the invented one first: a call cannot tell two operations of one path apart.
// Then delete this file and import `Api` from "./openapi".
/** The operations the scaffold's own calls use. */
type Invented = {
  get: [
    { path: "/me"; response: WireUser },
    { path: "/items/{id}"; response: WireItem },
  ];
  patch: [{ path: "/items/{id}"; body: { title: string }; response: WireItem }];
};

/** The operations of method `M` in schema `S`. */
type OperationsOf<S extends Schema, M> = M extends keyof S ? (S[M] extends readonly (infer O)[] ? O : never) : never;

/** Schemas `A` and `B` as one. */
type Both<A extends Schema, B extends Schema> = {
  readonly [M in keyof A | keyof B]: readonly (OperationsOf<A, M> | OperationsOf<B, M>)[];
};

/** The operations the gatekeeper calls. */
export type Api = Both<Described, Invented>;
