# RFC: A Cap'n Web frontend for forge

## Summary

[Cap'n Web](https://github.com/cloudflare/capnweb) APIs are declared in TypeScript and have no
schema, so every surface built on one (a CLI, the declarations a code-mode agent writes against,
tool definitions, docs) has to read the TypeScript itself or be written by hand.
[forge](https://github.com/cloudflare/forge) already solves this problem for OpenAPI: a frontend
reads the document into a language-neutral IR, and plugins, each a pure `generate` from that IR to
files, write the surfaces.

This RFC proposes:

1. **capnweb-schema**, a JSON description of a Cap'n Web capability graph, produced from the
   TypeScript by an extractor that lives with capnweb;
2. the forge IR and WIT changes that let forge take capnweb-schema as a second input next to
   OpenAPI: services, RPC methods, and capability, function and stream types;
3. plugins on top of it, three of which already exist as pure functions of the schema: a CLI
   command table, an agent `.d.ts` with per-service fragments, and a tool catalog.

A working reference implementation is in Cloudflare OS: `packages/api-schema`
([github.com/cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os)) extracts the
Workshop API and generates the declarations and tool catalog from it, and the starter's
`cf-os api` ([cloudflare-os-starter#19](https://github.com/cloudflare/cloudflare-os-starter/pull/19))
generates a whole CLI from the same schema. This document is meant to stand on its own; paths are
relative to the repository each section names.

## 1. Motivation

One API needs several surfaces for agents:

- a **CLI**, so an agent with a shell can drive a running instance (`cf-os api open-gadget <id>
  list-chats`);
- **code-mode declarations**, a `.d.ts` an agent writes code against when it holds a stub;
- **tools**, one per method, with JSON Schema arguments, for MCP and function calling;
- **docs**.

Writing each by hand means each drifts from the API on its own schedule. Generating each from the
TypeScript means each reimplements the same type walk. Cap'n Web has no schema to generate from:
the interfaces are the only description, and capnweb-validate, which turns them into runtime
validators, keeps its type model internal to its build transform.

Cloudflare OS feels this today. Its agent describes a binding to the model as TypeScript types
(`describeBinding`, in `packages/workshop-backend/src/agent.ts`), and returns the whole
description unbounded, because, as the code says, "the agent can't write code against a partial
API description, and there is no way yet to query it progressively."

The Workshop API (`packages/workshop-shared/src/api.ts`) is the case in point. Its schema, as
extracted at the time of writing:

| Measure | Value |
| --- | --- |
| Services (capability interfaces reachable from `PublicApi`) | 16 |
| Methods | 219 |
| Named shapes | 123 |
| `workshop-api.schema.json` | 361,408 bytes |
| `workshop-api.agent.d.ts` (rooted at `AuthenticatedApi`) | 123,408 bytes, 3,089 lines, ~30.9k tokens |
| Largest per-service fragment (`Overseer`) | 55,927 bytes, ~14.0k tokens |
| Tools callable from `AuthenticatedApi` | 187, across 5 services |

Token counts are estimated at four bytes per token.

We already have a working extractor and CLI. The extractor reads `api.ts` with the TypeScript
compiler; the starter's `cf-os api` is generated from its output: every method a client can call
becomes a command, chained on one line where a method returns a capability, with nothing
per-method written by hand.
The question this RFC asks is where those pieces should live so that the next Cap'n Web API, and
cf, get them for free.

## 2. Prior art

- **forge** (github.com/cloudflare/forge). The OpenAPI frontend links a document into a `Forge`
  (`src/link.rs`, which reads the document's objects through `src/link/openapi.rs`, follows
  `$ref`s and builds the method types and models): groups, methods, models and types
  (`src/types.rs`). A capnweb-schema frontend mirrors that linking step. Plugins are WebAssembly components
  of the `plugin` world in `packages/forge/plugin/forge.wit` (`forge:plugin@0.3.0`), exporting
  `generate` and `generate-group`, which return files; they read the IR through host functions and
  have no file system, network or clock. `@cloudflare/forge/plugin` (`packages/forge/src/index.ts`)
  wraps that for TypeScript as `definePlugin({ generate(forge), generateGroup(group) })`.
- **capnweb-validate** (github.com/cloudflare/capnweb,
  `packages/capnweb-validate/src/transform/type-introspector.ts`). Lowers resolved TypeScript
  service types to `ServiceShape`/`TypeShape`: pass-by-value primitives, containers (array, map,
  set, tuple, object, union), built-ins (date, bytes, typed arrays, error, blob, streams, url,
  headers, request, response), and pass-by-reference functions and stubs. It is the authority on
  what Cap'n Web can carry. It is not exported, keeps no doc comments, identifies named shapes by
  numeric id, and does not keep a function's signature: it needs none of that to validate.
- **capnweb#177** ([schema introspection queries](https://github.com/cloudflare/capnweb/issues/177)).
  Proposes a built-in way to ask a Cap'n Web object for its interface, as TypeScript declarations,
  for code-mode agents: per stub, not fully resolved (the top level first, with a way to dig
  deeper), keeping aliases and comments, and de-duplicating types across objects. On prior art,
  the issue's discussion finds nothing in Cap'n Proto to align to, but asks that the design
  consider [capnweb#179](https://github.com/cloudflare/capnweb/issues/179), and names
  [GraphQL introspection](https://graphql.org/learn/introspection) as a reference, with the
  caution to fit Cap'n Web's use case rather than GraphQL's.
- **capnweb#179** ([Cap'n Proto bridge](https://github.com/cloudflare/capnweb/issues/179)). An
  interface defined by a `.capnp` file, with TypeScript types generated from it and a proxy
  between the two protocols, for servers written in languages that prefer an IDL to TypeScript.
  It is a second source for the interface description this RFC's format captures.
- **GraphQL introspection**. A GraphQL endpoint answers `__schema` and `__type` queries with its
  types as data: each named, with its fields and descriptions, and referring to other types by
  name, so a client fetches the types it needs one at a time.
- **Cloudflare OS** already hands agents per-capability declarations: each Gatekeeper implements
  `getTypeScriptTypes(): Promise<string>` (`packages/workshop-shared/src/gatekeeper.ts`), and
  `packages/mcp-shared/src/schema-to-ts.ts` renders an MCP server's tool schemas into the `.d.ts`
  a Gadget's coding agent sees for it.
- **cf** (github.com/cloudflare/cf). Its CLI is a forge plugin (`packages/cli/generator/plugin`)
  that writes a yargs command per operation, with metadata files beside them. On those it builds
  the agent surfaces: `cf cli search "<task>"` (five compact JSON matches over the commands),
  `cf schema <command>` (the request an operation sends), and a hidden `cf tools` (MCP tool
  definitions from the command metadata). The starter's `cf-os api search` follows the first.

## 3. The format: `capnweb-schema/0`

capnweb-schema is JSON. The format today is the `Schema` type in `packages/api-schema/src/schema.ts`:

```ts
interface Schema {
  entry: string;                              // the entry interface: a key of `services`
  constants: Record<string, number[]>;        // exported byte constants, by name
  services: Record<string, {                  // every capability interface reached
    doc: string;
    methods: { name: string; doc: string; params: { name; type; optional; doc }[]; returns }[];
  }>;
  shapes: Record<string, ApiShape>;           // named object and union types
}
```

`ApiShape` is capnweb-validate's `TypeShape` with three differences: named object and union types
are hoisted into `shapes` and referred to as `{kind: "ref", name}`, so a recursive type stays
finite; a `stub` names its service instead of inlining it; and a `function` keeps its parameters
and result. Everything is sorted (services, shapes, methods, properties, union branches), so the
same declarations serialize to the same bytes, and a committed schema moves only when the API
does. One method of the Workshop API, as the schema has it:

```json
{
  "name": "openGadget",
  "doc": "Open an existing gadget. ...",
  "params": [
    { "name": "id", "type": { "kind": "string" }, "optional": false, "doc": "" },
    { "name": "shareKey", "type": { "kind": "string" }, "optional": true, "doc": "" },
    { "name": "configureObservers", "type": { "kind": "stub", "service": "ObserverConfigCallback" }, "optional": true, "doc": "" }
  ],
  "returns": { "kind": "stub", "service": "Overseer" }
}
```

It takes a callback the client implements and returns a capability to pipeline on: the two things
an HTTP API cannot say.

Proposed additions for the first versioned release:

| Addition | Why |
| --- | --- |
| A top-level `format: "capnweb-schema/0"` | So a reader can refuse a format it does not know. |
| Per service, `direction: "server" \| "client"` | A subscriber or callback (`ObserverConfigCallback`) is implemented by the client; today a consumer infers that from where the service appears. |
| Stream element types | `ReadableStream<T>` and `WritableStream<T>` carry `T`; today a stream is only its direction. |
| `deprecated` and availability, from `@deprecated` and a tag | As forge's methods have them (`deprecated`, `availability`). |
| Property members | Cap'n Web pipelines property access (`stub.foo.bar()`), and capnweb-validate already models getters (`isGetter`); today only methods are recorded. |
| Handle disposal semantics | Every stub must be disposed; the schema should say which results are stubs the caller owns and must dispose. |
| A `@mutates` tag | Which methods change state, so a Gatekeeper can route those through user approval and let reads through. It plays the part of MCP's `readOnlyHint` and forge's `x-forge-require-confirmation`. |

At this commit none of the additions is implemented; they land next, in this package, before the
format is proposed to capnweb.

A frontend emits this JSON, and forge reads it. forge never needs a TypeScript compiler, just as
OpenAPI JSON is its input today.

## 4. The frontend

The reference implementation is `packages/api-schema/src/extract.ts` in Cloudflare OS. It loads
the entry file under its tsconfig with the TypeScript compiler API, refuses a program that does not
type-check (an unresolved type silently becomes `any`, turning capabilities into values), walks the
capability graph from the entry interface with capnweb-validate's classification rules, and keeps
names and JSDoc. It imports nothing but the compiler and `node:path`, and takes its inputs as
options:

```ts
extractSchema({ entry, tsconfig, entryName: "PublicApi", constants: ["SERVICE_SALT"] }): Schema
```

It tells capnweb's own types (`RpcTarget`, a Workers `WorkerEntrypoint`, the global
`DurableObject`) from the API's by the file that declares them: by default, by install path
(`node_modules/capnweb/`, `node_modules/@cloudflare/workers-types/`), and through an
`isRuntimeFile` option for a linked or vendored copy, or inside capnweb's own repository. An
extractor that lives in capnweb would know its own declarations directly, which is one more reason
to adopt it there.

Two type walks of the same TypeScript can drift: one could say a parameter is a capability and the
other a value. So we ask capnweb to export a named, doc-preserving extractor from
capnweb-validate (for example `capnweb-validate/schema`) that shares its introspector. Validation
and schema then cannot disagree, and ours becomes a thin adapter, or nothing.

## 5. forge IR and WIT changes

Relative to `forge:plugin@0.3.0`, the next version of the WIT would need:

- **A service part.** `service-info { name, description, direction, methods }`, with
  `direction: server | client`, and the forge's list of services next to its groups.
- **A transport on methods.** `method-info` has `http-method` and `path` as mandatory fields
  today, with `request`, `headers`, `body`, `responses` and `errors` beside them. They move into
  `transport: variant { http(http-info), rpc(rpc-info) }`, where `rpc-info { service, params,
  returns }` names the method's service, its parameters in order, and its result type.
- **New types.** `type-info` gains `capability(option<service-id>)` (none for an untyped stub),
  `function { params, returns }` and `stream { element, direction }`. A map today is an object
  with no fields and an `extra` type, which allows only string keys, and there is no set or tuple
  (a `prefixItems` tuple is `unknown`), so the IR gains `map { key, value }`, `set` and `tuple`.
  `scalar` gains the values Cap'n Web passes by value and the IR has no scalar for: `bigint`,
  `error`, `url`, `headers`, `request`, `response`, `regexp`, `blob`, `array-buffer`, `data-view`
  and `typed-array(name)` (`Float64Array`, say). Existing types cover `Date` (`date-time`),
  `Uint8Array` (`binary`: raw bytes, as `binary` already means), a literal (a one-value `enum`) and
  `any` (`unknown`).
- **No result, and `undefined`.** The IR has neither `void` nor `undefined`, and Cap'n Web keeps
  `undefined` apart from `null`. In the Workshop API's schema, 100 method results are `void`, and
  so is the result of one callback a method takes; 302 union branches are `undefined`, 300 of them
  the schema's spelling of an optional property (`T | undefined`) and 2 in results that may be
  absent; and 3 object properties are `undefined` as a whole, the `indefinite?: never` that keeps
  one branch of a discriminated union from carrying the other's key. `rpc-info.returns`, and a
  `function`'s `returns`, become `option<type-id>`, none for one that returns nothing. A property
  with an `undefined` branch lowers to `field-info.required = false` and the rest of its type, as
  an optional property does from OpenAPI; one that is only `undefined` to `required = false` and
  the type `scalar.undefined`, a key that must be absent. `scalar` gains `undefined` for that, and
  for an `undefined` branch in any other place (a result, a parameter, an array element).
- **Unsupported values.** A type the extractor cannot describe (`never`, the `object` keyword) is
  `unsupported` with a reason. It lowers to `unknown` with the reason as its description, as the
  `.d.ts` emitter renders it.
- **Entry and opaque constants.** `forge-info` gains the entry service and the schema's constants,
  kept as values forge does not read, as it keeps extensions as `json` today.
- **Pipelining semantics.** A method whose result is a `capability` continues the chain on that
  service. The IR states only that; each plugin derives its own chain syntax from it:
  `open-gadget <id> list-chats` for a CLI, `api.openGadget(id).listChats()` for TypeScript,
  `continuesOn` for a tool catalog.

**Rejected: tunnelling Cap'n Web through OpenAPI `x-capnweb-*` extensions.** A frontend could write
each method as a synthetic `POST /<Service>/<method>` with its schema in extensions, and forge
would carry it unchanged, since it keeps an operation's unknown extensions. But the IR keeps
extensions only on methods, not on the types of parameters and results, so a callback or a
capability inside an argument becomes an untyped value, and a plugin can no longer tell a
subscriber from an object. Services, direction and pipelining would live in strings every plugin
re-parses. It would work for the simplest methods and fail for the ones that make Cap'n Web worth
using.

**Proposed anyway: a one-day spike of it.** Generate that OpenAPI from the Workshop API's schema,
port the CLI command-table emitter to a forge TypeScript plugin that reads the extensions, and
compare its output with the generated table. It shows the plugin side working with no forge
changes, and measures exactly what the tunnel loses.

## 6. Plugins

Each is a pure function of the schema and a few options: no file system, clock, randomness or
environment, and the same input always yields the same output. That is the heart of a forge
plugin's contract, but only the CLI table already has the plugin's shape, `generate(schema) ->
File[]`. The `.d.ts` emitter returns `{ full, fragments }` and the tool catalog a `ToolCatalog`,
each given a root service and the methods to omit, and `scripts/generate.ts` names their files.
Porting either means wrapping it in a `generate` that names its files, and either building its
options into the plugin (cf's plugin "reads nothing but the document, so what else it needs is
built into it") or forge giving plugins options (§8). It also means giving it a capnweb-schema
`Schema` to read, which a forge plugin does not have: it reads forge's IR (§5), where a service is
a part with ids, a method's parameters and result sit in `rpc-info`, and an optional property is
`field-info.required = false` instead of a `T | undefined` union. So a port needs one of three
things: an adapter that rebuilds a `Schema` from the IR, written once and shared by every such
plugin; forge keeping the frontend's own document and handing it to plugins beside the IR (§8),
as it keeps extensions as `json` today; or the emitter rewritten against the IR, the costliest.

1. **The `cf-os api` command table** (the starter's `packages/cf-os/generator/emit.ts`, in
   cloudflare-os-starter#19). Every decision the CLI makes about a method (its command name, which
   parameters are positional, how each is encoded, what its result does to the chain) is made here
   and written into a table; the runtime holds no per-method knowledge.
2. **An agent `.d.ts`** (`packages/api-schema/src/emit/dts.ts`). Rooted at a chosen service, with
   methods to omit (the agent's surface leaves out the credential methods), it writes one
   self-contained declaration file and, for progressive disclosure, a fragment per service: its
   interface and the named shapes it reaches without crossing into another service, which it
   names only. That is the output #177 asks for. Every stub the caller holds declares
   `[Symbol.dispose]()`, so `using` releases it, and a call returning a capability returns a
   `Pipelined` promise that can be called on before it resolves. A value parameter is
   `Awaitable<T>`, taking a promise of the value too, which Cap'n Web resolves before delivering
   the call. A service the caller implements reads the other way round, its methods returning
   `Awaitable<T>`, so a synchronous implementation type-checks as written.
3. **A tool catalog** (`packages/api-schema/src/emit/tools.ts`, experimental). One tool per method
   reachable from the root by calling, each with a self-contained JSON Schema (draft 2020-12) for
   its arguments and result, values JSON cannot carry marked with `x-capnweb-*` annotations, and
   `continuesOn` naming the service a capability result continues on. MCP servers and tool search
   can build on it, as cf's `cf tools` and `cf cli search` build on its command metadata.
4. **Docs.** Not written yet: a page per service from the same schema.

## 7. Alignment with capnweb#177

#177 asks for a runtime method that tells an agent holding an unknown stub what it can call. The
build-time schema and that method should be the same data:

- The runtime method returns the same JSON, one service at a time, or the `.d.ts` rendered from
  it: the fragment from §6.2 for that service rendered with the stub's own service as the root and
  without `omit`. A fragment rendered from another root can differ from that answer, because
  declaration names (the suffix of a rewritten one) and positions (whether a shape is one the
  caller receives, supplies or both) come from the walk of the whole graph from the root, which
  keeps the fragments of one root consistent with one another and with the full `.d.ts`. An agent
  that starts from such fragments and later asks a stub gets the same services, methods and shapes,
  not always the same text. The fragments committed here are rendered from `AuthenticatedApi` and
  leave out the credential methods (`changePassword` among them, which the stub still has), a
  product's choice of what to show an agent, so a runtime answer matches them only if the method
  applies the same omission.
- Build-time output is for codegen: a CLI, an SDK, docs. The runtime method is for an agent holding
  a stub it was handed, whose type nobody generated code for.
- It describes only what the caller holds: the service of that stub, and the services reachable
  from it, by name, each fetched with its own stub. Describing a capability grants nothing.
- Like GraphQL introspection, the answer is the type system as data, with named types referred to
  by name, so an agent digs deeper one name at a time and a type two objects share is described
  once. Unlike it, there is no endpoint-wide schema to query: the answer is scoped to the stub,
  which is what a capability system needs and GraphQL, with one schema per endpoint, does not.
  And the agent-facing answer is TypeScript, as #177 asks, with the JSON as its structure.
- Why a new JSON format, not a `.capnp` schema (#179): a TypeScript-first API's types are
  TypeScript's. Untagged unions, literal types, optional properties, `undefined` apart from
  `null`, `Map`s with any key, `Date`, `Request` and streams are what Cap'n Web passes, and a
  `.capnp` schema could carry them only by convention. The two meet in the other direction
  instead: the #179 bridge's code generator, which reads a `.capnp` file to write TypeScript,
  could write capnweb-schema too (interfaces as services, structs as object shapes), and every
  plugin of §6 would then serve a Cap'n Proto-defined interface unchanged.

## 8. Open questions

For forge:

- A new service part, or groups generalised to carry a direction and a transport?
- Naming: do plugins get Cap'n Web's names as written (`openGadget`) and spell them for their
  language, as forge's `Name` does for OpenAPI, or does the IR fix a casing?
- Should a plugin be able to read the frontend's own document beside the IR, as forge already
  keeps extensions as `json`? This package's emitters take capnweb-schema, not the IR, so without
  that each one ported needs an adapter from the IR back to a `Schema` (§6).
- Should frontends run out of process? The extractor needs a TypeScript compiler, which forge's
  Rust process does not have; emitting JSON for forge to read is the out-of-process answer.
- Plugin options. The `.d.ts` and tool-catalog emitters take a root service and methods to omit,
  which differ per product (Cloudflare OS omits its credential methods). `generate` takes no
  arguments today: does a plugin read options from forge's configuration, or does each product
  build its own plugin with them built in?

For capnweb:

- Will capnweb-validate export the extractor, and under what name?
- Does #177 return JSON, `.d.ts`, or both?
- Should the #179 bridge write capnweb-schema from a `.capnp` file, as a second frontend beside
  the TypeScript extractor, and what does a `.capnp` construct with no TypeScript spelling (a
  named union, a generic interface) become in it?
- How are generics and `any` tails reported? The extractor names a second instantiation of a
  generic by its printed form (`Foo<Bar>`), and records an `any` as `any`.

Security:

- A published schema includes admin-only surfaces (`AdminApi`). They are already public in
  `api.ts`; capability security, not obscurity, is what keeps a caller from reaching them.

## 9. Rollout

1. **This package**: the format, the extractor, the committed schema of the Workshop API, and the
   generic `.d.ts` and tool-catalog emitters. The starter's `cf-os api` reads
   `workshop-api.schema.json` from the pin instead of extracting it itself.
2. **An audited Admin API**: the additions of §3 implemented, `@mutates` on every Admin API method.
3. **An admin Gatekeeper**: an agent's access to the Admin API, proxied, with mutating calls routed
   through approval.
4. **forge IR**: the changes of §5.
5. **The emitters ported to forge TypeScript plugins**, reading the schema through an adapter
   from the IR or as the document forge passes through (§6).
6. **cf and cf-os share plugin code**: one search, one tool catalog, one way to spell a chain.

Long-term homes:

| What | Home |
| --- | --- |
| The format specification and the extractor | capnweb |
| The IR and the generic plugins (`.d.ts`, tool catalog and MCP, docs) | forge |
| Product plugins and runtime (the `cf-os api` table, auth, the admin Gatekeeper proxy) | The product |
| The API and its committed schema | cloudflare-os |

`packages/api-schema` is the interim home of the first two rows. Its `src/schema.ts` and
`src/extract.ts` move to capnweb unchanged, and `src/emit/dts.ts` and `src/emit/tools.ts` to
forge, inside a plugin wrapper that names the files, supplies the options and hands them a
`Schema`, rebuilt from the IR or passed through as the frontend's document (§6): none of them
imports anything from Cloudflare OS or names its API. `scripts/generate.ts`, the one
file that names `api.ts`, `PublicApi`, `SERVICE_SALT` and `AuthenticatedApi`, stays, with the
committed `generated/` files it writes.
