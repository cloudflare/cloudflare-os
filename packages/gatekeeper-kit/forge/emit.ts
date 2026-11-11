/**
 * Renders a Forge document as type-only schemas for `@gadgets/gatekeeper-kit/http`: one `.d.ts`
 * file per group, holding the models placed in that group and an `Api` schema of its operations.
 *
 * Pure, as a Forge plugin must be: it reads only the forge and returns files.
 */

import type {
  Field, Forge, Group, Method, Model, ObjectType, Type,
} from "@cloudflare/forge/plugin";
import { file, module, type File, type Ident, type Part } from "@cloudflare/forge/ts";

/** The methods `@gadgets/gatekeeper-kit/http` can call, in the order a schema lists them. */
const METHODS = ["get", "post", "put", "patch", "delete"] as const;
type ClientMethod = (typeof METHODS)[number];

/**
 * Where a type is used. A request leaves out `readOnly` fields, which the server sets, and takes
 * readonly arrays; a response has every field.
 */
type Mode = "request" | "response";

/** Lines of parts. A block's first line continues the line it starts on. */
type Block = Part[][];

/** An operation the client cannot call, and why. */
type Skipped = { method: Method; reason: string };

/** The file a group's types are declared in: `index.d.ts` for the root, else its path. */
export function groupFile(group: Pick<Group, "path">): string {
  if (group.path.length === 0) return "index.d.ts";
  return `${group.path.map(name => name.camel()).join("/")}.d.ts`;
}

/** Renders every group of `forge` as a file. */
export function emit(forge: Forge): File[] {
  const names = new ModelNames(forge);
  return forge.groups.map(group => emitGroup(group, names));
}

function emitGroup(group: Group, names: ModelNames): File {
  const f = file(groupFile(group));
  const printer = new Printer(names);

  const operations = new Map<ClientMethod, Block[]>();
  const skipped: Skipped[] = [];
  for (const method of group.methods.toSorted(byPath)) {
    const verb = method.httpMethod.toLowerCase();
    if (!isClientMethod(verb)) {
      skipped.push({ method, reason: `${method.httpMethod} is not a method the client sends` });
      continue;
    }
    const result = printer.operation(method);
    if ("reason" in result) {
      skipped.push({ method, reason: result.reason });
      continue;
    }
    operations.set(verb, [...operations.get(verb) ?? [], result.block]);
  }

  if (skipped.length > 0) {
    f("/*");
    f(" * Operations left out, which the client cannot call:");
    for (const { method, reason } of skipped) {
      f(` * - ${method.httpMethod} ${method.path}${operationId(method)}: ${reason}.`);
    }
    f(" */");
    f();
  }

  for (const model of group.models) {
    docComment(f, "", model.description, model.deprecated);
    printBlock(f, "", [["export type ", names.name(model, "response"), " = "]],
      printer.type(model.type, "response"), ";");
    if (names.needsRequestType(model)) {
      f(`/** {@link ${names.name(model, "response")}} as a request sends it, without its \`readOnly\` fields. */`);
      printBlock(f, "", [["export type ", names.name(model, "request"), " = "]],
        printer.type(model.type, "request"), ";");
    }
    f();
  }

  if (operations.size > 0) {
    f.doc(
      `The ${group.path.length === 0 ? "ungrouped" : `\`${group.path.join(".")}\``} operations, ` +
      "as a schema for `createOpenAPIClient` from `@gadgets/gatekeeper-kit/http`.");
    f("export type ", names.apiName(group), " = {");
    for (const verb of METHODS) {
      const blocks = operations.get(verb);
      if (!blocks) continue;
      f(`  ${verb}: [`);
      for (const block of blocks) printBlock(f, "    ", [[]], block, ",");
      f("  ];");
    }
    f("};");
  }
  return f;
}

function isClientMethod(verb: string): verb is ClientMethod {
  return (METHODS as readonly string[]).includes(verb);
}

function byPath(a: Method, b: Method): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.httpMethod < b.httpMethod ? -1 : 1;
}

/** ` (operationId)`, from the `x-operation-id` the bin copies `operationId` into, or nothing. */
function operationId(method: Method): string {
  const id = method.extension("x-operation-id");
  return typeof id === "string" ? ` (${id})` : "";
}

/**
 * Names models and group schemas uniquely within each group file. A model gets its PascalCase
 * name; one with `readOnly` fields, anywhere inside it, also gets a request type named with
 * `Input`.
 */
class ModelNames {
  #names = new Map<Model, { response: string; request?: string }>();
  #apiNames = new Map<Group, string>();

  constructor(forge: Forge) {
    const needsRequest = modelsWithReadOnlyFields(forge);
    for (const group of forge.groups) {
      const taken = new Set<string>();
      const claim = (wanted: string) => {
        let name = wanted;
        for (let n = 2; taken.has(name); n++) name = `${wanted}${n}`;
        taken.add(name);
        return name;
      };
      for (const model of group.models) taken.add(pascal(model));
      for (const model of group.models) {
        const response = pascal(model);
        this.#names.set(model, needsRequest.has(model)
          ? { response, request: claim(`${response}Input`) }
          : { response });
      }
      if (group.methods.length > 0) {
        this.#apiNames.set(group, claim(`${group.path.map(name => name.pascal()).join("")}Api`));
      }
    }
  }

  needsRequestType(model: Model): boolean {
    return this.#names.get(model)?.request !== undefined;
  }

  name(model: Model, mode: Mode): string {
    const names = this.#names.get(model)!;
    return (mode === "request" ? names.request : undefined) ?? names.response;
  }

  /** The identifier, which the file declaring the model leaves unimported. */
  ref(model: Model, mode: Mode): Ident {
    return module(groupFile(model.group)).ident(this.name(model, mode)).ty();
  }

  apiName(group: Group): string {
    return this.#apiNames.get(group)!;
  }
}

function pascal(model: Model): string {
  const name = model.name.pascal();
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/**
 * The models whose request type differs from their response type: those with a `readOnly` field,
 * and those that refer to one, directly or through other models.
 */
function modelsWithReadOnlyFields(forge: Forge): Set<Model> {
  const models = forge.groups.flatMap(group => group.models);
  const refs = new Map<Model, Set<Model>>();
  const result = new Set<Model>();
  for (const model of models) {
    const found = new Set<Model>();
    if (scan(model.type, found)) result.add(model);
    refs.set(model, found);
  }
  // A fixed point, since models refer to each other in cycles.
  for (let changed = true; changed;) {
    changed = false;
    for (const model of models) {
      if (result.has(model)) continue;
      if ([...refs.get(model)!].some(ref => result.has(ref))) {
        result.add(model);
        changed = true;
      }
    }
  }
  return result;
}

/** Whether `type` has a `readOnly` field of its own, collecting the models it refers to. */
function scan(type: Type, refs: Set<Model>): boolean {
  switch (type.kind) {
    case "scalar":
    case "enum":
      return false;
    case "array":
      return scan(type.elem, refs);
    case "object": {
      let readOnly = false;
      for (const field of type.fields) {
        if (field.readOnly) readOnly = true;
        if (scan(field.type, refs)) readOnly = true;
      }
      if (type.extra && scan(type.extra, refs)) readOnly = true;
      return readOnly;
    }
    case "union":
    case "intersection":
      return type.members.map(member => scan(member, refs)).some(Boolean);
    case "model":
      refs.add(type.model);
      return false;
  }
}

class Printer {
  #names: ModelNames;

  constructor(names: ModelNames) {
    this.#names = names;
  }

  operation(method: Method): { block: Block } | { reason: string } {
    const lines: Block = [["{"]];
    const id = method.extension("x-operation-id");
    const tag = typeof id === "string" ? `\`${id}\`` : "";
    const doc = method.summary && tag ? `${method.summary} (${tag})` : method.summary || tag;
    if (doc || method.deprecated) {
      lines.unshift(...docLines(doc, method.deprecated));
    }
    lines.push([`  path: ${JSON.stringify(method.path)};`]);

    const query: Field[] = [];
    for (const field of parameters(method)) {
      if (method.location(field)?.in === "query") query.push(field);
    }
    if (query.length > 0) {
      const fields: Block = [];
      for (const field of query) {
        const location = method.location(field);
        const value = this.#queryValue(field.wireName, field.type,
          location?.in === "query" && location.exploded);
        if (value === undefined) {
          return { reason: `query parameter \`${field.wireName}\` is not a scalar or an array of scalars` };
        }
        fields.push(...this.#field(field, value));
      }
      lines.push(...wrapObject("  query: ", fields, ";"));
    }

    const headers = method.headers?.fields ?? [];
    if (headers.length > 0) {
      const fields: Block = [];
      for (const field of headers) {
        const value = field.type.kind === "enum" && field.type.values.every(v => typeof v === "string")
          ? this.type(field.type, "request")
          : [["string"]];
        fields.push(...this.#field(field, value));
      }
      lines.push(...wrapObject("  headers: ", fields, ";"));
    }

    if (method.body) {
      const json = method.body.json;
      if (!json) {
        const types = method.body.contents.map(content => content.mediaType).join(", ");
        return { reason: `its request body is not JSON (${types})` };
      }
      lines.push(...indent(wrap(method.body.required ? "body: " : "body?: ",
        this.type(json.type, "request"), ";")));
    }

    if (method.responses.length === 0) return { reason: "it documents no 2xx response" };
    const responses: Block[] = [];
    for (const response of method.responses) {
      if (response.contents.length === 0) {
        responses.push([["undefined"]]);
      } else if (response.json) {
        responses.push(this.type(response.json.type, "response"));
      } else {
        const types = response.contents.map(content => content.mediaType).join(", ");
        return { reason: `its ${response.status} response is not JSON (${types})` };
      }
    }
    lines.push(...indent(wrap("response: ", joinBlocks(uniqueBlocks(responses), " | "), ";")));
    lines.push(["}"]);
    return { block: lines };
  }

  /**
   * A query parameter's type, or undefined for one the client cannot send. A parameter sent
   * comma-separated takes the values already joined, as a string. A parameter named `name[]`, the
   * bracket convention for an array, takes an array even where the document declares one value.
   */
  #queryValue(name: string, type: Type, exploded: boolean): Block | undefined {
    const value = withoutNull(type);
    if (isScalarLike(value)) {
      const one = this.type(value, "request");
      return name.endsWith("[]") ? wrap("readonly ", needsParens(value) ? wrap("(", one, ")") : one, "[]") : one;
    }
    if (value.kind === "array" && isScalarLike(withoutNull(value.elem))) {
      return exploded ? this.type(value, "request") : [["string"]];
    }
    return undefined;
  }

  #field(field: Field, value: Block): Block {
    return [
      ...indent(docLines(field.description, field.deprecated)),
      ...indent(wrap(`${key(field.wireName)}${field.required ? "" : "?"}: `, value, ";")),
    ];
  }

  type(type: Type, mode: Mode): Block {
    switch (type.kind) {
      case "scalar":
        return [[scalar(type)]];
      case "enum":
        return [[type.values.map(value => JSON.stringify(value)).join(" | ")]];
      case "array": {
        const elem = this.type(type.elem, mode);
        const grouped = needsParens(type.elem) ? wrap("(", elem, ")") : elem;
        return wrap(mode === "request" ? "readonly " : "", grouped, "[]");
      }
      case "object":
        return this.#object(type, mode);
      case "union":
        return joinBlocks(type.members.map(member => this.#member(member, mode)), " | ");
      case "intersection":
        return joinBlocks(type.members.map(member => this.#member(member, mode)), " & ");
      case "model":
        return [[this.#names.ref(type.model, mode)]];
    }
  }

  #member(type: Type, mode: Mode): Block {
    const block = this.type(type, mode);
    return type.kind === "union" || type.kind === "intersection" ? wrap("(", block, ")") : block;
  }

  #object(type: ObjectType, mode: Mode): Block {
    const fields = mode === "request" ? type.fields.filter(field => !field.readOnly) : type.fields;
    const body: Block = [];
    for (const field of fields) body.push(...this.#field(field, this.type(field.type, mode)));
    const extra = type.extra && indent(wrap("[key: string]: ", this.type(type.extra, mode), ";"));
    if (body.length === 0 && !extra) return [["{}"]];
    if (body.length === 0) return [["{"], ...extra!, ["}"]];
    const object: Block = [["{"], ...body, ["}"]];
    // Fields beside an index signature must fit it, so the two are intersected instead.
    return extra ? [...object.slice(0, -1), ["} & {"], ...extra, ["}"]] : object;
  }
}

/** The fields of a method's path, query and body parameters. */
function parameters(method: Method): Field[] {
  const request = method.request;
  if (!request) return [];
  const objects = request.kind === "intersection" ? request.members : [request];
  return objects.flatMap(type => type.kind === "object" ? type.fields : []);
}

function withoutNull(type: Type): Type {
  if (type.kind !== "union") return type;
  const members = type.members.filter(member => !(member.kind === "scalar" && member.scalar === "null"));
  return members.length === 1 ? members[0] : { ...type, members };
}

/** Whether every value of `type` is a string, number or boolean. */
function isScalarLike(type: Type, seen = new Set<Model>()): boolean {
  switch (type.kind) {
    case "scalar":
      return type.scalar !== "null";
    case "enum":
      return true;
    case "union":
      return type.members.every(member => isScalarLike(member, seen));
    case "model":
      if (seen.has(type.model)) return false;
      seen.add(type.model);
      return isScalarLike(type.model.type, seen);
    default:
      return false;
  }
}

function scalar(type: Extract<Type, { kind: "scalar" }>): string {
  switch (type.scalar) {
    case "unknown": return "unknown";
    case "null": return "null";
    case "boolean": return "boolean";
    case "number": return "number";
    default: return "string";
  }
}

function needsParens(type: Type): boolean {
  return type.kind === "union" || type.kind === "intersection" ||
    (type.kind === "enum" && type.values.length > 1);
}

function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function docLines(text: string, deprecated: boolean): Block {
  const lines = text.trim() === "" ? [] : text.trim().replaceAll("*/", "*\\/").split("\n");
  if (deprecated) lines.push("@deprecated");
  if (lines.length === 0) return [];
  if (lines.length === 1) return [[`/** ${lines[0]} */`]];
  return [["/**"], ...lines.map(line => [` * ${line}`.trimEnd()]), [" */"]];
}

function docComment(f: File, prefix: string, text: string, deprecated: boolean): void {
  for (const line of docLines(text, deprecated)) f(prefix, ...line);
}

/** `prefix` before the block's first line and `suffix` after its last. */
function wrap(prefix: string, block: Block, suffix: string): Block {
  const lines = block.map(line => [...line]);
  lines[0] = [prefix, ...lines[0]];
  lines[lines.length - 1] = [...lines[lines.length - 1], suffix];
  return lines;
}

/** An operation's member holding `fields`, such as `  query: {`, each field one level in. */
function wrapObject(prefix: string, fields: Block, suffix: string): Block {
  return [[prefix, "{"], ...indent(fields), [`  }${suffix}`]];
}

function indent(block: Block): Block {
  return block.map(line => ["  ", ...line]);
}

/** The blocks one after another, `separator` between each one's last line and the next's first. */
function joinBlocks(blocks: Block[], separator: string): Block {
  const lines: Block = [];
  blocks.forEach((block, index) => {
    if (index === 0) {
      lines.push(...block.map(line => [...line]));
      return;
    }
    const [first, ...rest] = block;
    lines[lines.length - 1] = [...lines[lines.length - 1], separator, ...first];
    lines.push(...rest.map(line => [...line]));
  });
  return lines;
}

function uniqueBlocks(blocks: Block[]): Block[] {
  const seen = new Set<string>();
  return blocks.filter(block => {
    const text = JSON.stringify(block.map(line => line.map(part => String(part))));
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

function printBlock(f: File, prefix: string, head: Block, block: Block, suffix: string): void {
  const lines = joinBlocks([head, block], "");
  lines[lines.length - 1] = [...lines[lines.length - 1], suffix];
  for (const line of lines) f(prefix, ...line);
}
