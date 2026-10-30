// The contract between the command-table emitter (`generator/emit.ts`) and the `cf-os api` runtime
// beside this file. `pnpm api-schema:generate` renders `packages/api-schema`'s schema of the
// Workshop API, and the schemas of the gatekeeper app UIs, into one `ApiTable`
// (`generated/commands.ts`); the runtime walks argv against it. The table holds the CLI's decisions
// only -- names, argument encodings, what each return does to the chain -- and no logic, so an API
// change is a regenerated table, never a hand edit.
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
 * - `string`: the token, the text of `@<file>` or `-` (stdin), or, for a token that is a JSON
 *   string, the string it quotes; one with {@link ApiArg.choices}, the token itself.
 * - `number`, `boolean` (`true`/`false`), `bigint` (decimal), `date` (ISO 8601): the token,
 *   converted.
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
  /**
   * The named types the declared type is or is made of (itself, a union's branch, an array's
   * element) that have a doc, each with that doc's first sentence, for help: what an enum's or an
   * alias's name means where the argument uses it. Absent when none has.
   */
  typeDocs?: Record<string, string>;
  /** For `json`, the {@link SecretPath}s of the secrets the value may hold. */
  secrets?: SecretPath[];
}

/**
 * Where a secret sits in a JSON argument's (or a callback answer's) value: the property names
 * leading to it, `*` standing for every element of an array, set or tuple and every value of a map
 * or record (and so for every property, should a property be named `*`); `[]` is the whole value.
 * Recorded where api.ts marks an object property, or a named type, `@secret`. `--dry-run` prints
 * the value at each with its every string, number, bigint, boolean, date and byte array replaced by
 * `{"$secret": true}`, keeping its structure: a record's keys, an array's length, a `null`.
 */
export type SecretPath = string[];

/**
 * What a command's result does.
 *
 * - `value`: print it as JSON (`type` is the declared type for help, its named types spelled out as
 *   {@link ApiArg.type}'s are). `capabilities`, when the result is one object (or that or null)
 *   holding capabilities in top-level properties: the chain may go on to one of them by naming it
 *   (`get-gatekeeper-app <id> ui call <method>`), read by pipelining on the result. `nullable`, set
 *   only beside `capabilities`, when the result may be null itself: a null result then stops a chain
 *   going on to one of them, which fails. `bytes`, when the result is a `Uint8Array` (or that or
 *   null): with `--out`, it is written there decoded rather than printed as `{"base64": ...}`.
 * - `stub`: a capability on `node`, where the chain continues with the next segment. `nullable`
 *   when the declared type is `X | null`: a null result stops the chain, which fails.
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
  | { kind: "value"; type: string; nullable?: true; capabilities?: Record<string, ApiCapabilityProperty>; bytes?: true }
  | { kind: "stub"; node: string; nullable: boolean }
  | { kind: "handle" }
  | { kind: "stream" }
  | { kind: "subscription" }
  | { kind: "untyped" };

/**
 * A capability held in a top-level property of a value result, which the chain may continue on, by
 * the property's name in kebab-case, as commands are named.
 */
export interface ApiCapabilityProperty {
  /** Its name in api.ts, read on the result. */
  property: string;
  /**
   * What reading it continues on: a node (`nullable` when the property is optional or `X | null`),
   * or an untyped capability (`RpcStub<any>`), continued with `call <method> [json-args...]`.
   */
  returns: Extract<ApiReturn, { kind: "stub" } | { kind: "untyped" }>;
  /**
   * Its JSDoc in api.ts, normalized, for an untyped one, whose help has nothing else to say what it
   * offers; absent when it has none.
   */
  doc?: string;
  /** For an untyped one, the nodes an argument of the command types it as: {@link ApiByArgument}. */
  byArgument?: ApiByArgument;
}

/**
 * How an untyped capability property is typed by the value of one of the command's positional
 * arguments, from api.ts's `@appApi <property> <param>` on its method: the property is the app UI
 * capability of the gatekeeper whose vendor id the argument is, and a gatekeeper declares that
 * capability's interface as `AppApi` in its `src/app-api.ts`. When the argument, as typed,
 * is a key of `nodes`, the chain continues on that node, whose commands are checked as any node's
 * are, `call <method> [json-args...]` still working beside them; otherwise it stays untyped.
 */
export interface ApiByArgument {
  /** The argument's {@link ApiArg.index}: a positional one. */
  index: number;
  /**
   * The node for each value, sorted: `<vendor>:<interface>`, prefixed so that no gatekeeper's
   * interface can collide with the API's own, nor with another gatekeeper's.
   */
  nodes: Record<string, string>;
}

/** One method of a capability, as a CLI command. */
export interface ApiCommand {
  /** The method the runtime calls. */
  method: string;
  /** The method's JSDoc, normalized; empty when it has none. */
  doc: string;
  /** The exposed parameters, in parameter order. */
  args: ApiArg[];
  returns: ApiReturn;
  /** For a command that creates what the capability it returns is, how to report its id. */
  reportsId?: ApiReportsId;
  /**
   * For a command whose null result stops a chain (a nullable `stub`, or a nullable `value` holding
   * capabilities), when it is null, from api.ts's `@nullWhen <text>` on its method: a clause, in the
   * CLI's words, that may name the next step as a command (`` `am-i-admin` ``). Help says it, and
   * the run prints it when a chain stops at this command's null.
   */
  nullWhen?: string;
}

/**
 * How a command reports the id of what it created, from api.ts's `@reportsId <noun> <method>().<property>`
 * on its method: the runtime pipelines `method()` on the capability the command returns (`stub`),
 * beside the rest of the chain, and once that resolves prints `Created <noun> <its property>.` on
 * stderr, a later call of the chain failing or not, so a one-shot chain that goes on past the
 * capability (`new-workspace set-title X`) does not lose the id of what it made.
 */
export interface ApiReportsId {
  /** What was created, as the message names it (`workspace`). */
  noun: string;
  /** The method of the returned capability that reads it, taking no arguments. */
  method: string;
  /** The property of that method's result holding the id: a string or a number. */
  property: string;
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
   * {@link ApiArg.type}'s are, and `secrets` the secrets it may hold, as {@link ApiArg.secrets}.
   * Absent for a method that returns nothing, whose calls are NDJSON events.
   */
  answer?: { shape: ApiShape; type: string; secrets?: SecretPath[] };
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
  /**
   * The API's nodes, by interface name, and the gatekeeper app UIs' ({@link ApiByArgument}), by
   * `<vendor>:<interface>`.
   */
  nodes: Record<string, ApiNode>;
  /** The callback interfaces `callback` arguments name, a gatekeeper app UI's prefixed as its nodes are. */
  callbacks: Record<string, ApiCallback>;
  /**
   * The named shapes `json` arguments' and callback answers' shapes refer to, by name, a gatekeeper
   * app UI's prefixed as its nodes are (help's type texts, {@link ApiArg.type}, keep its own names).
   */
  shapes: Record<string, ApiShape>;
  constants: ApiConstants;
}
