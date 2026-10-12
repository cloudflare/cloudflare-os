/**
 * Checks values against the OpenAPI schemas vendored in ./openapi: the subset of JSON Schema those
 * documents use (`$ref`, `allOf`/`oneOf`/`anyOf`, OpenAPI discriminators, `type`, `enum`, `const`,
 * `properties`/`required`/`additionalProperties`, `items`, and numeric and length bounds). Enough to
 * catch a misnamed field, a wrong type, or an unknown enumeration value in what the gatekeeper
 * sends and in what its fake console answers.
 */

type Schema = Record<string, unknown>;
type Document = { components?: { schemas?: Record<string, Schema> } };

const REF_PREFIX = "#/components/schemas/";

/** Validates `value`, returning a list of problems; empty means it conforms. */
export function checkSchema(document: Document, schema: Schema, value: unknown): string[] {
  const errors: string[] = [];
  new Checker(document, errors).check(schema, value, "$", new Set());
  return errors;
}

class Checker {
  constructor(private readonly document: Document, private readonly errors: string[]) {}

  resolve(ref: string): Schema {
    const name = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
    const schema = this.document.components?.schemas?.[name];
    if (!schema) throw new Error(`Unknown schema ${ref}`);
    return schema;
  }

  /**
   * @param dispatched Schemas already dispatched on for this value, so a subtype's `allOf` back to
   * its discriminating base checks the base's own constraints without dispatching again.
   */
  check(schema: Schema, value: unknown, at: string, dispatched: Set<Schema>): void {
    if (typeof schema.$ref === "string") {
      const target = this.resolve(schema.$ref);
      const { $ref: _ref, ...rest } = schema;
      this.check(target, value, at, dispatched);
      if (Object.keys(rest).length > 0) this.check(rest, value, at, dispatched);
      return;
    }

    const discriminator = schema.discriminator as { propertyName: string; mapping?: Record<string, string> } | undefined;
    if (discriminator && !dispatched.has(schema) && value && typeof value === "object" && !Array.isArray(value)) {
      const tag = (value as Record<string, unknown>)[discriminator.propertyName];
      const target = typeof tag === "string" ? discriminator.mapping?.[tag] : undefined;
      if (!target) {
        this.errors.push(`${at}.${discriminator.propertyName}: ${JSON.stringify(tag)} is not one of ${Object.keys(discriminator.mapping ?? {}).join(", ")}`);
        return;
      }
      const next = new Set(dispatched).add(schema);
      this.check(this.resolve(target), value, at, next);
      // A discriminated oneOf is settled by the mapping; a base's own fields are checked below.
      const { discriminator: _d, oneOf: _o, ...own } = schema;
      this.check(own, value, at, next);
      return;
    }

    if (Array.isArray(schema.allOf)) {
      for (const part of schema.allOf as Schema[]) this.check(part, value, at, dispatched);
    }
    if (Array.isArray(schema.anyOf) && !this.passesSome(schema.anyOf as Schema[], value, at, dispatched)) {
      this.errors.push(`${at}: matches none of anyOf`);
    }
    if (Array.isArray(schema.oneOf)) {
      const passing = (schema.oneOf as Schema[]).filter(option => this.passes(option, value, at, dispatched)).length;
      if (passing !== 1) this.errors.push(`${at}: matches ${passing} of oneOf, not exactly 1`);
    }

    if (schema.const !== undefined && value !== schema.const) {
      this.errors.push(`${at}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
    }
    // Some of Ubiquiti's integer fields declare their enumerations as strings (a port's PoE `type`
    // is `integer` with `enum: ["1", "2", "3", "4"]`), so numbers are compared by their spelling.
    if (Array.isArray(schema.enum) && !schema.enum.some(item =>
      item === value || (typeof value === "number" && typeof item === "string" && item === String(value)))) {
      this.errors.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
    }

    const types = schema.type === undefined ? undefined : ([] as unknown[]).concat(schema.type);
    if (types && !types.some(type => matchesType(type as string, value)) &&
        !(schema.nullable === true && value === null)) {
      this.errors.push(`${at}: expected ${types.join(" | ")}, got ${describe(value)}`);
      return;
    }

    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) this.errors.push(`${at}: ${value} < ${schema.minimum}`);
      if (typeof schema.maximum === "number" && value > schema.maximum) this.errors.push(`${at}: ${value} > ${schema.maximum}`);
    }
    if (typeof value === "string") {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) this.errors.push(`${at}: shorter than ${schema.minLength}`);
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) this.errors.push(`${at}: longer than ${schema.maxLength}`);
    }
    if (Array.isArray(value)) {
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) this.errors.push(`${at}: more than ${schema.maxItems} items`);
      if (schema.items && typeof schema.items === "object") {
        value.forEach((item, i) => this.check(schema.items as Schema, item, `${at}[${i}]`, new Set()));
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const name of (schema.required ?? []) as string[]) {
        if (!(name in object)) this.errors.push(`${at}: missing required ${name}`);
      }
      for (const [name, property] of Object.entries(object)) {
        if (property === undefined) continue;
        if (properties[name]) this.check(properties[name]!, property, `${at}.${name}`, new Set());
        else if (schema.additionalProperties === false) this.errors.push(`${at}: unexpected property ${name}`);
      }
    }
  }

  passes(schema: Schema, value: unknown, at: string, dispatched: Set<Schema>): boolean {
    const errors: string[] = [];
    new Checker(this.document, errors).check(schema, value, at, dispatched);
    return errors.length === 0;
  }

  passesSome(options: Schema[], value: unknown, at: string, dispatched: Set<Schema>): boolean {
    return options.some(option => this.passes(option, value, at, dispatched));
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number";
    default: return typeof value === type;
  }
}

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** The schema of an operation's request body, or undefined if it takes none. */
export function requestSchema(document: { paths: Record<string, Record<string, Schema>> }, method: string, path: string): Schema | undefined {
  const operation = document.paths[path]?.[method.toLowerCase()];
  const content = (operation?.requestBody as { content?: Record<string, { schema: Schema }> } | undefined)?.content;
  return content?.["application/json"]?.schema;
}

/** The schema of an operation's JSON success response, or undefined. */
export function responseSchema(document: { paths: Record<string, Record<string, Schema>> }, method: string, path: string): Schema | undefined {
  const operation = document.paths[path]?.[method.toLowerCase()];
  const responses = (operation?.responses ?? {}) as Record<string, { content?: Record<string, { schema: Schema }> }>;
  for (const [status, response] of Object.entries(responses)) {
    if (status.startsWith("2") && response.content?.["application/json"]) return response.content["application/json"].schema;
  }
  return undefined;
}

/** The template in `paths` a concrete path matches, e.g. `/v1/sites/{siteId}` for `/v1/sites/abc`. */
export function matchTemplate(paths: Record<string, unknown>, method: string, concrete: string): string | undefined {
  return Object.keys(paths).find(template => {
    const pattern = new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`);
    return pattern.test(concrete) && (paths[template] as Record<string, unknown>)[method.toLowerCase()] !== undefined;
  });
}
