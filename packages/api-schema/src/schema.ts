// The schema of a Cap'n Web API: the capability graph reachable from one entry interface, read
// from the API's TypeScript declarations by `extract.ts`. It records every capability interface
// the graph reaches (`services`), server- and client-implemented alike, each marked with the side
// that implements it, with its methods' parameters and awaited results and its properties' types,
// and hoists named object and union types into `shapes`, which shapes elsewhere refer to by name,
// so a recursive type stays finite. Names and JSDoc are kept.
//
// The schema is deterministic: services, shapes, methods, properties and union branches are
// sorted, so the same declarations always serialize to the same bytes, and a committed schema
// moves only when the API does. Consumers (a declaration file, a tool catalog, a command-line
// client) are generated from it without reading TypeScript themselves.
//
// Shapes mirror capnweb-validate's `TypeShape` (its `transform/type-introspector.ts`), with named
// object and union types hoisted and referenced by name.
//
// Fields marked optional are omitted when absent, never written as `null`, so a reader that does
// not know one can ignore it.

/** The format's name and version: a schema's first field, so a reader can refuse one it does not know. */
export const FORMAT = "capnweb-schema/0";

/** The capability graph reachable from the entry interface. */
export interface Schema {
  /** {@link FORMAT}. */
  format: typeof FORMAT;
  /** The entry interface's name: a key of `services`. */
  entry: string;
  /** Exported byte constants, by name. */
  constants: Record<string, number[]>;
  /** Every capability interface reached, server- and client-implemented alike, by name. */
  services: Record<string, SchemaService>;
  /** Named object and union types, by name, which `ref` shapes refer to. */
  shapes: Record<string, ApiShape>;
}

/** One capability interface. */
export interface SchemaService {
  doc: string;
  /**
   * Which side implements it: `"server"` for a capability the caller receives, `"client"` for one
   * the caller implements and passes, `"both"` for one reached each way.
   *
   * The entry is the server's. The side implementing a service supplies its methods' results and
   * its properties' values, and the other side their parameters: so a capability in a server
   * service's result (or anywhere inside it) is the server's, one in a parameter the client's, and
   * across a client service's methods the sides swap (its parameters are the server's, its results
   * the client's). A function swaps the same way, as the service of the side that passes it would,
   * and so does a `writableStream`'s element, which the stream's holder writes. A service reached
   * each way is walked as each side's, so what it reaches can be `"both"` too.
   */
  direction: "server" | "client" | "both";
  /** Its methods, inherited ones included, sorted by name. */
  methods: SchemaMethod[];
  /**
   * Its other members, inherited ones included, sorted by name, which a stub reads by pipelining
   * (`stub.foo.bar()`). Omitted when it has none.
   */
  properties?: SchemaProperty[];
  /** The `@deprecated` tag's text (`""` when bare), when it has one; `doc` keeps the tag too. */
  deprecated?: string;
}

/** One method. */
export interface SchemaMethod {
  name: string;
  doc: string;
  params: SchemaParam[];
  /** The awaited result: a value's shape, or a `stub` naming the service it continues on. */
  returns: ApiShape;
  /** The `@deprecated` tag's text (`""` when bare), when it has one; `doc` keeps the tag too. */
  deprecated?: string;
  /**
   * `true` when its doc has a `@mutates` tag: it changes state, so a Gatekeeper can route it
   * through approval. Absent means not declared, not read-only.
   */
  mutates?: true;
}

/** One non-method member of a capability interface. */
export interface SchemaProperty {
  name: string;
  doc: string;
  /** Its type, `undefined` removed when `optional`. */
  type: ApiShape;
  optional: boolean;
  /** The `@deprecated` tag's text (`""` when bare), when it has one; `doc` keeps the tag too. */
  deprecated?: string;
}

/** One method parameter. */
export interface SchemaParam {
  name: string;
  /** Its type, `undefined` removed when `optional`. */
  type: ApiShape;
  optional: boolean;
  doc: string;
}

/**
 * A value's type, as the extractor resolved it. Named object and union types appear as `ref`s into
 * {@link Schema.shapes}, so a recursive type stays finite.
 */
export type ApiShape =
  | { kind: "string" | "number" | "boolean" | "bigint" | "null" | "undefined" | "void" | "any" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; element: ApiShape }
  | { kind: "set"; element: ApiShape }
  | { kind: "map"; key: ApiShape; value: ApiShape }
  | {
    kind: "tuple";
    elements: ApiShape[];
    /** Required leading elements, when fewer than `elements` (`[a, b?]` is 1). */
    minLength?: number;
    /** The element type of a variadic tail (`[a, ...b[]]`). */
    rest?: ApiShape;
  }
  | {
    kind: "object";
    /** Every property, by name. An optional property's shape is a union with `undefined`. */
    properties: Record<string, ApiShape>;
    /** The value type of a string or number index signature (a `Record`). */
    index?: ApiShape;
  }
  | { kind: "union"; branches: ApiShape[] }
  | { kind: "ref"; name: string }
  | {
    kind:
      | "date" | "bytes" | "error" | "arrayBuffer" | "dataView" | "regexp" | "blob" | "url" | "headers"
      | "request" | "response";
  }
  | {
    kind: "readableStream" | "writableStream";
    /** The type of what it carries (`ReadableStream<Uint8Array>`), when declared and not `any`. */
    element?: ApiShape;
  }
  | { kind: "typedArray"; name: string }
  /**
   * A capability passed by reference: an `RpcStub<X>`/`RpcPromise<X>`, an interface extending
   * `RpcTarget`, or a method-only interface. `service` names it in the schema's `services`; absent
   * when it is untyped (`RpcStub<any>`).
   */
  | { kind: "stub"; service?: string }
  /** A function passed by reference, with its signature. */
  | { kind: "function"; params: ApiShapeParam[]; returns: ApiShape }
  /** A type the extractor cannot represent, with why. */
  | { kind: "unsupported"; reason: string };

/** One parameter of a {@link ApiShape} function. */
export interface ApiShapeParam {
  name: string;
  type: ApiShape;
  optional: boolean;
}
