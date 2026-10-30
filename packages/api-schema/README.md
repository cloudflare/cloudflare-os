# `@gadgets/api-schema`

The schema of the Workshop API, and the generic tools that make and read it. The API is the
[Cap'n Web](https://github.com/cloudflare/capnweb) capability graph declared in
`packages/workshop-shared/src/api.ts`, and Cap'n Web has no schema of its own, so this package
extracts one from the TypeScript: every capability interface reachable from `PublicApi`, with
each method's parameters, awaited result and doc comment, and the named types they use. Everything
that describes the API to a client or an agent is generated from that one JSON file, without
reading TypeScript itself.

This is the interim home of the format, called capnweb-schema. The proposal for where it goes
next is [`plans/capnweb-api-schema.md`](../../plans/capnweb-api-schema.md).

## The format

`src/schema.ts` is the specification: a `Schema` starts with its `format`, `"capnweb-schema/1"`,
so a reader can refuse a format it does not know, names its `entry` interface, records its byte
`constants`, and holds `services` (each capability interface, server- and client-implemented
alike, with its methods and properties) and `shapes` (named object and union types, which other
shapes refer to by name, so a recursive type stays finite). Shapes follow capnweb-validate's own
classification of types, and a capability is a `stub` naming the service it continues on.
Services, shapes, methods, properties and union branches are sorted, so the same declarations
always serialize to the same bytes; method and function parameters and tuple elements keep their
declared order, which is what positional arguments mean.

Docs are kept wherever the TypeScript has them: on each service, method, property and parameter
(a parameter's is its `@param` text), on each named shape (its declaration's JSDoc, as `doc`
beside its `kind`), and on an object shape's properties (`propertyDocs`, by property name, for
the properties that have any). A doc is normalized JSDoc, its tags included.

Beyond names, types and docs, the schema records:

- each service's `direction`: `"server"` for a capability the caller receives, `"client"` for one
  it implements and passes (a subscriber, a callback), `"both"` for one reached each way;
- a service's `properties`, its non-method members, which a stub reads by pipelining
  (`stub.foo.bar()`);
- a stream's `element`, what a `ReadableStream<T>` or `WritableStream<T>` carries;
- `deprecated`, from a `@deprecated` tag, on a service, method or property, a named shape or an
  object shape's property, and `mutates: true` on a method whose doc has a `@mutates` tag, so a
  Gatekeeper can route it through approval;
- `tags`, on each of those, the other JSDoc tags it declares, by tag name (`{"secret": ""}` for
  a bare `@secret`, a repeated tag's texts joined by a newline), so the declarations can tell a
  consumer more about a member without the format knowing each tag. Left out are the tags with
  fields of their own (`@deprecated`, `@mutates`) and those that document a signature's parts or
  illustrate it, whose text stays in the doc: `@param` (a parameter's own `doc`), `@returns`,
  `@throws`, `@template`, `@example` and `@see`, in their JSDoc and TSDoc spellings
  (`EXCLUDED_TAGS` in `src/schema.ts`). `cf-os api` reads four of them: `@secret`, on an object
  property or a named type, as holding a secret, which its dry runs print redacted;
  `@nullWhen <text>`, on a method whose null result stops a chain (a capability, or a value holding
  one, that may be null), as saying when it is null, a clause that may name the next step as a
  method (`getAdminApi`'s `@nullWhen the caller is not a deployment admin; amIAdmin() says whether
  it is`), which it prints, the methods written as its commands, when a chain stops there
  ([packages/api-cli](../api-cli/README.md#finding-and-chaining-commands));
  `@reportsId <noun> <method>().<property>`, on a method returning a capability to what it
  creates (`newWorkspace`'s `@reportsId workspace getMetadata().id`), as naming the method of that
  capability, taking no arguments, whose result's string or number `property` is the new thing's
  id, which it prints on stderr ([packages/api-cli](../api-cli/README.md#finding-and-chaining-commands));
  and `@appApi <property> <param>`, on a method whose result holds a gatekeeper's untyped app UI
  capability (`getGatekeeperApp`'s `@appApi ui id`), as typing that property by the vendor id its
  required string parameter `param` names, with the gatekeeper app UIs' schemas below
  ([Gatekeeper app UIs](#gatekeeper-app-uis)).

Each of these but `direction` is omitted when absent, and none changes what an existing field
means, so a reader that predates them can ignore them. So are a named shape's `doc` and an object
shape's `propertyDocs`, and `tags`, which `capnweb-schema/1` added to `/0`: a reader written for
`/0` that ignores the fields it does not know reads `/1` as it did `/0`.

## Generated files

`generated/` is committed. Nothing in it is edited by hand.

The last column is who each is for. `pnpm cf-os api` renders its command table from the schema
and copies the agent declarations; nothing else reads these files yet.

| File | What it is | Meant for |
| --- | --- | --- |
| `workshop-api.schema.json` | The capnweb-schema of everything reachable from `PublicApi`. | `pnpm cf-os api` ([`packages/api-cli`](../api-cli/README.md)), whose command table, `packages/api-cli/generated/commands.ts`, `pnpm api-schema:generate` renders from it in the same step, reading its services' methods, not their properties. [cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter)'s `cf-os api` is to run that CLI from its submodule, in place of its own copy. |
| `workshop-api.agent.d.ts` | One self-contained declaration file of what a holder of an `AuthenticatedApi` stub can call, without the credential methods (`authenticate`, `login`, `changePassword`, ...). | Gatekeepers and code-mode agents, to write code against. The agent's `describeBinding` still writes its own description. It is also copied into `packages/api-cli/generated/agent-types.ts`, for `cf-os api types`. |
| `workshop-api.fragments.json` | The same declarations split per service, each fragment readable on its own, other services referred to by name. | Agents that fetch one service at a time instead of the whole surface. Shaped like the answer a live introspection method would give ([capnweb#177](https://github.com/cloudflare/capnweb/issues/177)), but rendered from `AuthenticatedApi`'s point of view, so a shape's name or position can differ from what one stub alone would report, and without the credential methods, which such a method would list unless it left them out too. It is also copied into `packages/api-cli/generated/agent-types.ts`, for `cf-os api types <service>`. |
| `gatekeeper-apps/<vendor>.schema.json` | The capnweb-schema of one gatekeeper's app UI: the interface its package.json names, as the entry ([Gatekeeper app UIs](#gatekeeper-app-uis)). | `pnpm cf-os api`, whose command table holds it, prefixed `<vendor>:`, as the nodes `get-gatekeeper-app <vendor> ui` goes on to. |
| `gatekeeper-apps/<vendor>.d.ts` | That interface as declarations, with what it reaches. | Agents writing code against the app UI. It is also copied into `packages/api-cli/generated/agent-types.ts`, for `cf-os api types <vendor>`. |
| `workshop-api.tools.json` | **Experimental.** One tool per method callable from `AuthenticatedApi`, each with a JSON Schema for its arguments and result, `continuesOn` where the result is a capability, and the method's `deprecated` and `mutates` where it has them. A parameter's, a named type's and an object property's doc is its schema's `description`, `deprecated: true` beside it when it is deprecated. | A base for MCP and tool search; its shape may change. |

The declarations use the web platform's globals (`ReadableStream`), as a Worker has them, and
`Symbol.dispose` (TypeScript's `esnext.disposable` lib): every stub the agent holds can be disposed,
which is how it cancels a subscription. A call returning a capability returns it as
`Pipelined<Service>`, which can be called on before it resolves (`api.openWorkspace(id).listChats()`).
A value parameter is `Awaitable<T>`, the value or a promise of it, so one call's result is passed
to the next without awaiting it (`gadget.setTitle(other.getTitle())`), and a subscriber's methods
return `Awaitable<T>`, so an implementation may return its result as is or be `async`. A
service's property is a `readonly` member, which a holder reads as it would a method's result.
Every doc the schema keeps is a JSDoc block on what it documents, a named type's on its
`export type` and an object property's on the property, and its tags (`@deprecated`, `@mutates`
and those in `tags`) appear in the JSDoc.

## Gatekeeper app UIs

A gatekeeper's management app (`getGatekeeperApp(<vendor>)`) is a frame whose `ui` the API types
as `RpcStub<RpcTarget>`: each gatekeeper's is its own, and the Workshop API depends on no
gatekeeper. A gatekeeper whose `ui` has a declared interface names it in its package.json,

```json
"cloudflareOs": { "appApi": "src/context-types.ts#ContextApi" }
```

the file relative to the package, and `pnpm api-schema:generate` extracts that interface's schema,
with the same extractor, under the package's own tsconfig, so the file and what it imports must
type-check there and should be light (types and `capnweb` only, as `context-types.ts` and the
scheduler's `management-types.ts` are). Its vendor id is the backend's: the suffix of its
`GATEKEEPER_<NAME>` binding, lowercased, which `scripts/run-dev-server.ts` names after the package
directory (`gatekeeper-context` is `context`). Today `context` (`ContextApi`) and `scheduler`
(`ScheduleManagementApi`) declare one. A configurator's `ui` (`startResourceConfigurator`) has
none: its methods are its vendor's `*ConfiguratorUI` class in `packages/gatekeeper-<vendor>/src/`.

## Regenerating

After changing `packages/workshop-shared/src/api.ts`, run:

```sh
pnpm api-schema:generate
```

and commit the regenerated files with the change, and likewise after changing a gatekeeper app UI's
interface or its package.json's `appApi`. It also rewrites `packages/api-cli/generated/`,
`pnpm cf-os api`'s command table and its copy of the agent declarations, and removes the
`gatekeeper-apps/` files of a gatekeeper that no longer declares an app UI. `pnpm api-schema:check`,
part of `pnpm lint` and CI, writes and removes nothing and fails naming any file that is out of
date or left over, those included. Both print `{"files": [...]}` on stdout, the files written or
stale; everything else goes to stderr.

## What is generic, and what is not

`src/` knows nothing about this repository, so it can move unchanged:

- `src/schema.ts` and `src/extract.ts` (the format and the extractor) are meant for capnweb, next
  to capnweb-validate, whose type rules the extractor follows. The extractor imports only
  `typescript6` (TypeScript 7 ships no JavaScript compiler API) and `node:path`, and takes the
  entry file, its tsconfig, the entry interface and the constants as options. It recognises Cap'n
  Web's and the Workers runtime's own declarations by install path, or by an `isRuntimeFile`
  option for a linked or vendored copy.
- `src/emit/dts.ts` and `src/emit/tools.ts` are pure functions of a `Schema` and their options (a
  root service, the methods to omit): no `node:` imports, file system, clock, randomness or
  environment, and deterministic output. That is the core of a
  [forge](https://github.com/cloudflare/forge) plugin, which is where they are meant to go. The
  port still has to name the files (done in `scripts/generate.ts` today), supply the options,
  which a forge plugin has no input for yet, and hand them a `Schema`: a forge plugin reads
  forge's IR, not capnweb-schema, so either an adapter rebuilds the schema from the IR or forge
  passes the document through to plugins (the RFC's §6).

`scripts/generate.ts` is the only product-specific file: it names `api.ts` and its tsconfig, the
entry `PublicApi`, the constant `SERVICE_SALT`, the agent root `AuthenticatedApi` and the
credential methods an agent never calls, and finds the gatekeeper app UIs by their package.json.
It also renders the CLI's files, through `packages/api-cli/generator/emit.ts`, and it is still the
only part that writes to disk.
