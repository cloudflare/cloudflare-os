// The subset of a schema that a holder of one service's stub reaches: what a host that serves only
// that service (a Gatekeeper that hands an agent one capability) bundles instead of the whole API,
// to render its declarations from and check its calls against.
//
// It walks the graph itself rather than sharing `emit/dts.ts`'s walk, which also tracks the
// positions its renderer needs. The two agree because they follow the same edges: a method's
// parameters and result, a property's type, and inside a shape every element, member, branch,
// stream element, function signature and named shape it refers to. So the declarations of a subset
// are those of the whole schema with the same root and omissions:
// `emitDeclarations(subsetSchema(schema, { root, omit }), { root })` equals
// `emitDeclarations(schema, { root, omit })`, in `full` and in `fragments`.
//
// Pure, as the emitters are: no `node:` imports, no file system, clock, randomness or environment,
// and keys sorted, so the same schema always yields the same subset.

import { type ApiShape, FORMAT, type Schema, type SchemaService, type SchemaShape } from "./schema.ts";

/** What subsetSchema() keeps. */
export interface SubsetOptions {
  /** The service whose holder's reach the subset is: its `entry`. */
  root: string;
  /**
   * Methods to leave out, with whatever is reachable only through them: `"method"` on every
   * service, or `"Service.method"` on one, as emitDeclarations() takes them.
   */
  omit?: string[];
}

/**
 * The schema of what a holder of a `root` stub reaches: `root` as its `entry`; every service and
 * named shape reachable from it through methods' parameters and results and through properties;
 * each service's methods less `omit`; and no constants. Everything kept is kept whole: a service
 * with its doc, properties, tags and `direction`, a method, a property and a named shape with
 * their docs and tags.
 *
 * `direction` is the source's, so it says which side implements a service as the source's entry
 * reaches it, with nothing omitted. A root the client implements is refused: the subset is of what
 * a caller holds, and the server is that service's only holder.
 *
 * Throws on a root, service or shape the schema does not have.
 */
export function subsetSchema(schema: Schema, options: SubsetOptions): Schema {
  const omitted = new Set(options.omit ?? []);
  if (serviceOf(schema, options.root).direction === "client") {
    throw new Error(`${options.root} is implemented by the client, so it is not a capability a caller holds`);
  }

  const services = new Map<string, SchemaService>();
  const shapes = new Map<string, SchemaShape>();
  const pending: SchemaService[] = [];
  const visitService = (name: string) => {
    if (services.has(name)) return;
    const service = serviceOf(schema, name);
    const kept: SchemaService = {
      ...service,
      methods: service.methods.filter((method) => !omitted.has(method.name) && !omitted.has(`${name}.${method.name}`)),
    };
    services.set(name, kept);
    pending.push(kept);
  };
  const visit = (shape: ApiShape): void => {
    switch (shape.kind) {
      case "array":
      case "set":
        return visit(shape.element);
      case "map":
        return [shape.key, shape.value].forEach(visit);
      case "tuple":
        return [...shape.elements, ...shape.rest ? [shape.rest] : []].forEach(visit);
      case "object":
        return [...Object.values(shape.properties), ...shape.index ? [shape.index] : []].forEach(visit);
      case "union":
        return shape.branches.forEach(visit);
      case "readableStream":
      case "writableStream":
        if (shape.element) visit(shape.element);
        return;
      case "ref": {
        if (shapes.has(shape.name)) return;
        const named = shapeOf(schema, shape.name);
        shapes.set(shape.name, named);
        return visit(named);
      }
      case "function":
        shape.params.forEach((param) => visit(param.type));
        return visit(shape.returns);
      case "stub":
        if (shape.service !== undefined) visitService(shape.service);
        return;
    }
  };

  visitService(options.root);
  for (let service = pending.pop(); service !== undefined; service = pending.pop()) {
    for (const method of service.methods) {
      method.params.forEach((param) => visit(param.type));
      visit(method.returns);
    }
    for (const property of service.properties ?? []) visit(property.type);
  }
  return { format: FORMAT, entry: options.root, constants: {}, services: sorted(services), shapes: sorted(shapes) };
}

function serviceOf(schema: Schema, name: string): SchemaService {
  const service = Object.hasOwn(schema.services, name) ? schema.services[name] : undefined;
  if (!service) throw new Error(`no service ${name} in the schema`);
  return service;
}

function shapeOf(schema: Schema, name: string): SchemaShape {
  const shape = Object.hasOwn(schema.shapes, name) ? schema.shapes[name] : undefined;
  if (!shape) throw new Error(`no shape ${name} in the schema`);
  return shape;
}

/** By code unit, as the extractor sorts a schema's keys. */
function sorted<T>(map: Map<string, T>): Record<string, T> {
  return Object.fromEntries([...map].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
