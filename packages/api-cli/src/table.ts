// The contract between the command-table emitter (`generator/emit.ts`) and the `cf-os api` runtime
// beside this file. `pnpm api-schema:generate` renders `packages/api-schema`'s schema of the
// Workshop API into one `ApiTable` (`generated/commands.ts`); the runtime walks argv against it. The
// table holds the CLI's decisions only -- names, argument encodings, what each return does to the
// chain -- and no logic, so an API change is a regenerated table, never a hand edit.
//
// Shapes are the schema's own (`@gadgets/api-schema`'s `ApiShape`, which mirrors capnweb-validate's
// `TypeShape`), with named object and union types hoisted into `ApiTable.shapes` and referenced by
// name. The import is type-only, erased when Node runs this file, so the runtime still loads nothing
// from `@gadgets/*`.

import type { ApiShape, ApiShapeParam } from "@gadgets/api-schema/schema";

export type { ApiShape, ApiShapeParam };

/**
 * How the runtime turns argv tokens into one parameter's value.
 *
 * - `string`, `number`, `boolean` (`true`/`false`), `bigint` (decimal), `date` (ISO 8601): the
 *   token, converted.
 * - `bytes`: `@<file>`, `-` for stdin, or JSON `{"base64": "..."}`.
 * - `json`: inline JSON, `@<file>` or `-`, revived against {@link ApiArg.shape} so the `Date`s,
 *   `Uint8Array`s and `bigint`s nested inside it arrive as such.
 * - `stream`: a file path, or `-` for stdin, sent as a `ReadableStream<Uint8Array>`.
 * - `callback`: consumes no token. A client-implemented interface ({@link ApiArg.callback}) the
 *   runtime builds as an `RpcTarget`: a call of a method that returns nothing prints an NDJSON
 *   event, and a method that returns a value is answered from `--answer`
 *   ({@link ApiCallbackMethod.answer}).
 * - `function`: consumes no token. A bare function printing each call as an NDJSON event named
 *   after the parameter.
 */
export type ApiEncoding =
  | "string" | "number" | "boolean" | "bigint" | "date" | "bytes" | "json" | "stream" | "callback"
  | "function";

/** One exposed parameter of a command. */
export interface ApiArg {
  /** The parameter's name in api.ts. Also the event name of a `function` argument. */
  name: string;
  /**
   * Where the decoded value goes in the call's argument list. Parameters the table does not list
   * (optional callbacks whose methods all return nothing, and optional functions) and optional ones
   * not given are passed as `undefined`; the runtime trims trailing `undefined`s.
   */
  index: number;
  /**
   * The flag an optional parameter is given by, without the leading `--`: the kebab-case of its
   * name, or `arg-<name>` when that would collide with a runtime flag. Absent for a required
   * parameter, which is positional, taking the next token in parameter order (`callback` and
   * `function` arguments take none).
   */
  flag?: string;
  encoding: ApiEncoding;
  /** The declared type is `T | null`: the bare token `null` passes `null`. */
  nullable?: true;
  /** For a string-literal union, the values it accepts, sorted. */
  choices?: string[];
  /** For `json`, the declared type, to revive against. */
  shape?: ApiShape;
  /** For `callback`, the interface to implement: a key of {@link ApiTable.callbacks}. */
  callback?: string;
  /** For `function`, the function's parameter names, for help. */
  params?: string[];
  /**
   * The declared type, rendered TypeScript-like, for help. For `json`, each named object or union it
   * is made of is spelled out after it, unless that would run long: `Name = {...}`, or
   * `X[], where X = {...}`.
   */
  type: string;
  /** The parameter's JSDoc (`@param`), normalized; empty when it has none. */
  doc: string;
}

/**
 * What a command's result does.
 *
 * - `value`: print it as JSON (`type` is the declared type for help, its named types spelled out as
 *   {@link ApiArg.type}'s are).
 * - `stub`: a capability on `node`, where the chain continues with the next segment. `nullable`
 *   when the declared type is `X | null`: a null result ends the chain and prints `null`.
 * - `handle`: an empty capability (`RpcStub<{}>`): dispose it and print `null`.
 * - `stream`: a `ReadableStream<Uint8Array>`, written to `--out` (or stdout when it is not a
 *   terminal).
 * - `subscription`: the command takes a `function` argument, or a `callback` one whose interface
 *   has a method returning nothing (or no methods at all). The runtime prints its events as NDJSON
 *   until `--timeout` or SIGINT, then disposes the result (the subscription's handle).
 * - `untyped`: a capability over `any` (`RpcStub<any>`). Only a `call <method> [json-args...]`
 *   segment continues it, unchecked.
 */
export type ApiReturn =
  | { kind: "value"; type: string }
  | { kind: "stub"; node: string; nullable: boolean }
  | { kind: "handle" }
  | { kind: "stream" }
  | { kind: "subscription" }
  | { kind: "untyped" };

/** One method of a capability, as a CLI command. */
export interface ApiCommand {
  /** The method the runtime calls. */
  method: string;
  /** The method's JSDoc, normalized; empty when it has none. */
  doc: string;
  /** The exposed parameters, in parameter order. */
  args: ApiArg[];
  returns: ApiReturn;
}

/** One capability interface the chain can reach. */
export interface ApiNode {
  /** The interface's JSDoc, normalized; empty when it has none. */
  doc: string;
  /** Its methods, by command name (the method name in kebab-case), sorted. */
  commands: Record<string, ApiCommand>;
}

/** One method of a client-implemented callback interface. */
export interface ApiCallbackMethod {
  name: string;
  /** Its parameter names, in order: the positions of an event's `args`. */
  params: string[];
  doc: string;
  /**
   * Present when the method returns a value rather than nothing: the server waits for it, and the
   * CLI answers with `--answer <Callback>.<method>=<json|@file|->`, checked and revived against
   * `shape`. `type` is the declared type for help, its named types spelled out as
   * {@link ApiArg.type}'s are. Absent for a method that returns nothing, whose calls are NDJSON
   * events.
   */
  answer?: { shape: ApiShape; type: string };
}

/**
 * A client-implemented callback interface. The runtime's `RpcTarget` needs a prototype method for
 * every entry of `methods`: a call the server makes to a missing one throws, ending the
 * subscription.
 */
export interface ApiCallback {
  doc: string;
  /** Every method the server may call, events and answers alike, sorted by name. */
  methods: ApiCallbackMethod[];
}

/** Constants api.ts exports that the session needs. */
export interface ApiConstants {
  /** The password-hash salt prefix (`SERVICE_SALT`): argon2id's salt is these bytes ++ utf8(username). */
  SERVICE_SALT: number[];
}

/** The whole `cf-os api` command table. */
export interface ApiTable {
  /** The node bare `cf-os api <command>` starts on: what `PublicApi.authenticate()` returns. */
  root: string;
  /**
   * The node a leading `public` segment selects, without authenticating: `PublicApi`, less the
   * credential methods the session performs itself.
   */
  public: string;
  nodes: Record<string, ApiNode>;
  /** The callback interfaces `callback` arguments name. */
  callbacks: Record<string, ApiCallback>;
  /** The named shapes `json` arguments' and callback answers' shapes refer to, by name. */
  shapes: Record<string, ApiShape>;
  constants: ApiConstants;
}
