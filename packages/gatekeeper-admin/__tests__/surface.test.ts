// The generated surface, in Node: the schema the sessions are built from, the load-time checks
// that refuse a schema they cannot serve, and the declarations an agent reads. That this suite
// imports `src/surface.ts` at all shows the module loads with no Workers runtime and no loader
// for text modules.

import { emitDeclarations } from "@gadgets/api-schema/emit/dts";
import WORKSHOP_SCHEMA_JSON from "@gadgets/api-schema/generated/workshop-api.schema.json" with { type: "json" };
import type { ApiShape, Schema, SchemaMethod } from "@gadgets/api-schema/schema";
import { describe, expect, it } from "vitest";
import { ADMIN_AGENT_KINDS } from "../src/kinds.js";
import { adminSchema } from "../src/subset.js";
import {
  ADMIN_SCHEMA, PREAMBLE, SERVICES, assertAdminSchema, generatedDeclarations, kindOf,
} from "../src/surface.js";
import SURFACE_SOURCE from "../src/surface.ts?raw";

const ROOT = "AdminApi";
const VIEW = "AdminWorkspaceView";
const USER_VIEW = "AdminUserView";

/** The Workshop API's whole schema, which this Worker's is cut from. */
const WORKSHOP_SCHEMA = WORKSHOP_SCHEMA_JSON as unknown as Schema;

const namesOfKind = (...kinds: string[]) =>
  Object.keys(ADMIN_AGENT_KINDS).filter((name) => kinds.includes(kindOf(name)!)).toSorted();
const READS = namesOfKind("read");
const OMITTED = namesOfKind("omitted");

const method = (schema: Schema, service: string, name: string): SchemaMethod =>
  schema.services[service]!.methods.find((candidate) => candidate.name === name)!;

/** ADMIN_SCHEMA, changed by `change`. */
function doctored(change: (schema: Schema) => void): Schema {
  const schema = structuredClone(ADMIN_SCHEMA);
  change(schema);
  return schema;
}

/** A method that takes nothing and returns `returns`. */
const methodNamed = (name: string, returns: ApiShape = { kind: "void" }): SchemaMethod =>
  ({ name, doc: "", params: [], returns });

/**
 * The member `name` of `interface <service>` in `declarations`: its JSDoc, one line per line
 * without the comment's frame, and its signature.
 */
function member(declarations: string, service: string, name: string) {
  const lines = declarations.split("\n");
  const start = lines.indexOf(`export interface ${service} {`);
  const end = lines.indexOf("}", start);
  const body = lines.slice(start + 1, end);
  const at = body.findIndex((line) => line.startsWith(`  ${name}(`));
  if (start < 0 || at < 0) return undefined;
  let first = at;
  while (first > 0 && /^ {2}(\/\*\*| \*)/.test(body[first - 1]!)) first--;
  const doc = body.slice(first, at)
      .map((line) => line.replace(/^ {2}(\/\*\* ?| \*\/?) ?/, "").replace(/ ?\*\/$/, ""))
      .join("\n").trim();
  return { doc, signature: body[at]! };
}

describe("the schema", () => {
  it("gives a session exactly the methods the kind table does not omit", () => {
    expect(SERVICES.get(ROOT)!.toSorted()).toEqual(READS);
    expect(READS.length).toBeGreaterThan(0);
  });

  it("holds the two views the binding opens, and no omitted method", () => {
    expect([...SERVICES.keys()].toSorted()).toEqual([ROOT, USER_VIEW, VIEW]);
    expect(SERVICES.get(VIEW)!.length).toBeGreaterThan(0);
    expect(SERVICES.get(USER_VIEW)!.length).toBeGreaterThan(0);
    // Each is what the method that opens it returns, and the only capability the root hands out.
    expect(ADMIN_SCHEMA.services[ROOT]!.methods
        .flatMap(({ name, returns }) => returns.kind === "stub" ? [[name, returns.service]] : []))
        .toEqual([["inspectUser", USER_VIEW], ["inspectWorkspace", VIEW]]);
    const served = new Set([...SERVICES.values()].flat());
    expect(OMITTED.filter((name) => served.has(name))).toEqual([]);
    expect(OMITTED).toContain("setSiteName");
    expect(OMITTED).toContain("checkForUpdates");
  });

  it("is the schema it asserts", () => {
    expect(assertAdminSchema(doctored(() => {}))).toEqual(ADMIN_SCHEMA);
  });

  it("imports no text module and nothing of the Workers runtime", () => {
    const imported = [...SURFACE_SOURCE.matchAll(/\b(?:from|import) "([^"]+)"/g)].map((match) => match[1]!);
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((name) => /^cloudflare:|\.txt$|\.d\.ts$/.test(name))).toEqual([]);
  });
});

describe("the schema's generation", () => {
  /** The Workshop's schema with AdminApi's methods changed by `change`. */
  function withMethods(change: (methods: SchemaMethod[]) => void): Schema {
    const schema = structuredClone(WORKSHOP_SCHEMA);
    change(schema.services[ROOT]!.methods);
    return schema;
  }

  it("writes what the Worker bundles: the Workshop's own methods and views, less the omitted", () => {
    expect(adminSchema(WORKSHOP_SCHEMA)).toEqual(ADMIN_SCHEMA);
    const whole = WORKSHOP_SCHEMA.services[ROOT]!.methods;
    expect(whole.map((candidate) => candidate.name).toSorted())
        .toEqual(Object.keys(ADMIN_AGENT_KINDS).toSorted());
    expect(ADMIN_SCHEMA.services[ROOT]!.methods)
        .toEqual(whole.filter((candidate) => READS.includes(candidate.name)));
    for (const view of [VIEW, USER_VIEW]) {
      expect(ADMIN_SCHEMA.services[view]).toEqual(WORKSHOP_SCHEMA.services[view]);
    }
    for (const [name, shape] of Object.entries(ADMIN_SCHEMA.shapes)) {
      expect(shape, name).toEqual(WORKSHOP_SCHEMA.shapes[name]);
    }
    // Nothing of the services that lead to AdminApi, and no constants.
    expect(Object.keys(WORKSHOP_SCHEMA.services)).toContain("AuthenticatedApi");
    expect(ADMIN_SCHEMA.constants).toEqual({});
  });

  it("fails for a source in another format, which the subset would relabel as its own", () => {
    const older = { ...WORKSHOP_SCHEMA, format: "capnweb-schema/0" as Schema["format"] };
    expect(() => adminSchema(older)).toThrow(/^The Workshop API's schema is in format capnweb-schema\/0, not /);
  });

  it("fails, naming a method AdminApi declares and the kind table lacks", () => {
    const schema = withMethods((methods) => {
      methods.push(methodNamed("wipeEverything"), methodNamed("wipeTheRest"));
    });
    expect(() => adminSchema(schema)).toThrow(
        "AdminApi.wipeEverything has no kind in ADMIN_AGENT_KINDS; AdminApi.wipeTheRest has no " +
        "kind in ADMIN_AGENT_KINDS (packages/gatekeeper-admin/src/kinds.ts)");
  });

  it("fails, naming a method the kind table classifies and AdminApi lacks", () => {
    for (const name of ["listUsers", "setSiteName"]) {
      const schema = withMethods((methods) => {
        methods.splice(methods.findIndex((candidate) => candidate.name === name), 1);
      });
      expect(() => adminSchema(schema)).toThrow(`ADMIN_AGENT_KINDS names ${name}, which AdminApi ` +
          "does not declare (packages/gatekeeper-admin/src/kinds.ts)");
    }
  });
});

describe("the declarations", () => {
  const declarations = generatedDeclarations();
  const emitted = emitDeclarations(ADMIN_SCHEMA, { root: ROOT, header: PREAMBLE }).full;

  it("start with the preamble", () => {
    const preamble = PREAMBLE.split("\n").map((line) => `// ${line}`.trimEnd()).join("\n");
    expect(declarations.startsWith(`${preamble}\n`)).toBe(true);
    expect(PREAMBLE).toContain("marks this workspace as holding restricted data");
  });

  it("say which reads the deployment's audit log records, and which it does not", () => {
    const preamble = PREAMBLE.replace(/\n {2}/g, " ");
    expect(preamble).toContain(
        "A read runs at once and is recorded in this workspace's activity. Opening a view, of a " +
        "workspace or of a user's account, and each call on one are also recorded in the " +
        "deployment's audit log, as made through the admin connection; a listing, a setting and " +
        "the audit log itself leave no record there.");
  });

  it("declare every read method, and every method of a view, as the schema has it", () => {
    expect(declarations).toBe(emitted);
    for (const name of READS) {
      expect(member(declarations, ROOT, name), name).toBeDefined();
    }
    for (const name of SERVICES.get(VIEW)!) {
      expect(member(declarations, VIEW, name), name).toBeDefined();
    }
  });

  it("declare no omitted method", () => {
    for (const name of OMITTED) {
      expect(member(declarations, ROOT, name), name).toBeUndefined();
      expect(declarations, name).not.toMatch(new RegExp(`^ +${name}\\(`, "m"));
    }
  });
});

/** Expects ADMIN_SCHEMA changed by `change` to be refused, for `problem`. */
function refuses(change: (schema: Schema) => void, problem: RegExp): void {
  const refusal = () => assertAdminSchema(doctored(change));
  expect(refusal).toThrow(/^The admin gatekeeper can't serve this Admin API schema: /);
  expect(refusal).toThrow(problem);
}

describe("assertAdminSchema() refuses", () => {
  it("another format, another entry, and a schema without a service the declarations name", () => {
    refuses((schema) => { schema.format = "capnweb-schema/0" as Schema["format"]; },
        /its format is capnweb-schema\/0/);
    refuses((schema) => { schema.entry = VIEW; }, /its entry is AdminWorkspaceView, not AdminApi/);
    refuses((schema) => { delete schema.services[ROOT]; }, /it has no AdminApi/);
  });

  it("a service the caller implements", () => {
    refuses((schema) => { schema.services[VIEW]!.direction = "client"; },
        /AdminWorkspaceView is implemented by the caller/);
    refuses((schema) => { schema.services[ROOT]!.direction = "both"; },
        /AdminApi is implemented by the caller/);
  });

  it("a service with a property", () => {
    refuses((schema) => {
      schema.services[VIEW]!.properties =
          [{ name: "title", doc: "", type: { kind: "string" }, optional: false }];
    }, /AdminWorkspaceView has properties/);
  });

  it("a parameter that takes a capability, at any depth", () => {
    refuses((schema) => {
      method(schema, ROOT, "listUsers").params.push(
          { name: "view", type: { kind: "stub", service: VIEW }, optional: true, doc: "" });
    }, /a parameter of AdminApi\.listUsers takes a capability/);
    refuses((schema) => {
      schema.shapes.Callback = { kind: "object", properties: {
        each: { kind: "array", element: { kind: "function", params: [], returns: { kind: "void" } } },
      } };
      method(schema, VIEW, "listChats").params.push(
          { name: "callback", type: { kind: "ref", name: "Callback" }, optional: true, doc: "" });
    }, /a parameter of AdminWorkspaceView\.listChats takes a capability/);
  });

  it("a parameter that takes a stream, at any depth", () => {
    refuses((schema) => {
      method(schema, ROOT, "listWorkspaces").params.push({
        name: "upload", optional: true, doc: "",
        type: { kind: "union", branches: [{ kind: "undefined" }, { kind: "readableStream" }] },
      });
    }, /a parameter of AdminApi\.listWorkspaces takes a stream/);
    refuses((schema) => {
      method(schema, VIEW, "listFiles").params.push(
          { name: "sink", type: { kind: "writableStream" }, optional: true, doc: "" });
    }, /a parameter of AdminWorkspaceView\.listFiles takes a stream/);
  });

  it("a parameter of a kind the schema doesn't describe, at any depth", () => {
    refuses((schema) => {
      method(schema, ROOT, "listUsers").params.push(
          { name: "anything", type: { kind: "any" }, optional: true, doc: "" });
    }, /a parameter of AdminApi\.listUsers takes a value the schema doesn't describe/);
    refuses((schema) => {
      schema.shapes.Loose = { kind: "object", properties: {
        each: { kind: "array", element: { kind: "unsupported", reason: "a symbol" } },
      } };
      method(schema, VIEW, "getChatState").params.push(
          { name: "loose", type: { kind: "ref", name: "Loose" }, optional: true, doc: "" });
    }, /a parameter of AdminWorkspaceView\.getChatState takes a value the schema doesn't describe/);
  });

  it("a result of a kind the schema doesn't describe, at any depth", () => {
    refuses((schema) => { method(schema, ROOT, "getSettings").returns = { kind: "any" }; },
        /AdminApi\.getSettings returns a value the schema doesn't describe/);
    refuses((schema) => {
      method(schema, VIEW, "describe").returns = { kind: "union", branches: [
        { kind: "undefined" }, { kind: "array", element: { kind: "unsupported", reason: "a symbol" } },
      ] };
    }, /AdminWorkspaceView\.describe returns a value the schema doesn't describe/);
  });

  it("a root method that returns the root itself", () => {
    refuses((schema) => { method(schema, ROOT, "inspectWorkspace").returns = { kind: "stub", service: ROOT }; },
        /AdminApi\.inspectWorkspace returns AdminApi itself/);
  });

  it("a view's method that returns a capability, and a root result that is more than one stub", () => {
    refuses((schema) => { method(schema, VIEW, "describe").returns = { kind: "stub", service: VIEW }; },
        /AdminWorkspaceView\.describe returns a capability/);
    refuses((schema) => {
      method(schema, ROOT, "getSettings").returns =
          { kind: "object", properties: { view: { kind: "stub", service: VIEW } } };
    }, /AdminApi\.getSettings returns a capability/);
    refuses((schema) => { method(schema, ROOT, "inspectWorkspace").returns = { kind: "stub", service: "Elsewhere" }; },
        /AdminApi\.inspectWorkspace returns a capability of no service in the schema/);
    refuses((schema) => { method(schema, ROOT, "inspectWorkspace").returns = { kind: "stub" }; },
        /AdminApi\.inspectWorkspace returns a capability of no service in the schema/);
  });

  it("a root that lacks a method of the table, or has one the table does not serve", () => {
    refuses((schema) => {
      const methods = schema.services[ROOT]!.methods;
      methods.splice(methods.findIndex((candidate) => candidate.name === "listUsers"), 1);
    }, /AdminApi has no listUsers/);
    refuses((schema) => { schema.services[ROOT]!.methods.push(methodNamed("exportEverything")); },
        /AdminApi\.exportEverything has no kind/);
    refuses((schema) => { schema.services[ROOT]!.methods.push(methodNamed("setSiteName")); },
        /AdminApi\.setSiteName is omitted for an agent/);
  });

  it("a method with a reserved name", () => {
    for (const name of ["constructor", "then", "dup", "onRpcBroken", "toString", "hasOwnProperty"]) {
      refuses((schema) => { schema.services[VIEW]!.methods.push(methodNamed(name)); },
          new RegExp(`AdminWorkspaceView\\.${name} has a reserved name`));
    }
  });

  it("a secret, tagged on a named shape or on a property", () => {
    refuses((schema) => { schema.shapes.AdminSettingsView!.tags = { secret: "" }; },
        /the shape AdminSettingsView holds a secret/);
    refuses((schema) => {
      schema.shapes.Credentials = { kind: "object", properties: {
        nested: { kind: "array", element: {
          kind: "object", properties: { token: { kind: "string" } },
          propertyDocs: { token: { doc: "The token.", tags: { secret: "" } } },
        } },
      } };
    }, /the shape Credentials holds a secret/);
    refuses((schema) => {
      method(schema, ROOT, "getSettings").returns = {
        kind: "object", properties: { key: { kind: "string" } },
        propertyDocs: { key: { tags: { secret: "" } } },
      };
    }, /AdminApi\.getSettings returns a secret/);
  });
});
