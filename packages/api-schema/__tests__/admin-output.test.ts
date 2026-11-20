// The admin gatekeeper's schema, as scripts/generate.ts renders it from this repository's own
// `workshop-shared/src/api.ts`: the part of the Workshop API an `AdminApi` stub reaches, less the
// methods the kind table (`workshop-shared/src/admin-agent.ts`) keeps from an admin's agent.

import { describe, expect, test } from "vitest";
import { ADMIN_AGENT_KINDS } from "../../workshop-shared/src/admin-agent.ts";
import { ADMIN_OMIT, ADMIN_ROOT, API_SOURCE, renderApiSchema } from "../scripts/generate.ts";
import { emitDeclarations } from "../src/emit/dts.ts";
import { extractSchema } from "../src/extract.ts";
import type { Schema } from "../src/schema.ts";

const ADMIN_FILE = "packages/api-schema/generated/admin-api.schema.json";

const whole = extractSchema(API_SOURCE);
const files = renderApiSchema(whole);
const admin = JSON.parse(files.find((file) => file.path === ADMIN_FILE)!.contents) as Schema;

const kinds: Record<string, string> = ADMIN_AGENT_KINDS;
const omitted = Object.keys(kinds).filter((name) => kinds[name] === "omitted");
const kept = Object.keys(kinds).filter((name) => kinds[name] !== "omitted");

const methodNames = (schema: Schema, service: string) => schema.services[service]!.methods.map((m) => m.name);

/** Matches the declaration of method `name`, which starts its line: a doc may mention a method too. */
const declares = (name: string) => new RegExp(`^ +${name}\\(`, "m");

/** The Workshop schema with AdminApi's methods changed by `change`. */
function withMethods(change: (methods: Schema["services"][string]["methods"]) => void): Schema {
  const schema = structuredClone(whole);
  change(schema.services.AdminApi!.methods);
  return schema;
}

/** The services and named shapes `value`, any part of a schema, refers to: stubs' and refs' names. */
function references(value: unknown, found = { services: new Set<string>(), shapes: new Set<string>() }) {
  if (typeof value !== "object" || value === null) return found;
  const { kind, service, name } = value as { kind?: unknown; service?: unknown; name?: unknown };
  if (kind === "stub" && typeof service === "string") found.services.add(service);
  if (kind === "ref" && typeof name === "string") found.shapes.add(name);
  for (const child of Object.values(value)) references(child, found);
  return found;
}

/** What `schema`'s entry reaches, following every reference from it until none is new. */
function reachable(schema: Schema) {
  const services = new Set([schema.entry]);
  const shapes = new Set<string>();
  for (let size = -1; size !== services.size + shapes.size;) {
    size = services.size + shapes.size;
    const found = references([[...services].map((name) => schema.services[name]), [...shapes].map((name) => schema.shapes[name])]);
    for (const name of found.services) services.add(name);
    for (const name of found.shapes) shapes.add(name);
  }
  return { services: [...services].toSorted(), shapes: [...shapes].toSorted() };
}

describe("the files", () => {
  test("hold one admin file, after the Workshop's four", () => {
    const paths = files.map((file) => file.path);
    expect(paths.filter((path) => path.includes("admin"))).toEqual([ADMIN_FILE]);
    expect(paths.slice(0, 5)).toEqual([
      "packages/api-schema/generated/workshop-api.schema.json",
      "packages/api-schema/generated/workshop-api.agent.d.ts",
      "packages/api-schema/generated/workshop-api.fragments.json",
      "packages/api-schema/generated/workshop-api.tools.json",
      ADMIN_FILE,
    ]);
  });

  test("leave the Workshop's schema whole, with the methods the admin schema omits", () => {
    const workshop = JSON.parse(files[0]!.contents) as Schema;
    expect(workshop).toEqual(whole);
    expect(methodNames(workshop, ADMIN_ROOT)).toEqual(expect.arrayContaining(omitted));
  });
});

describe("what is omitted", () => {
  test("is every method the kind table classifies \"omitted\", by service and sorted", () => {
    expect(ADMIN_ROOT).toBe("AdminApi");
    expect(omitted.length).toBeGreaterThan(0);
    expect(ADMIN_OMIT).toEqual(omitted.map((name) => `AdminApi.${name}`).toSorted());
  });

  test("the kind table names the methods AdminApi declares, and no other", () => {
    expect(Object.keys(kinds).toSorted()).toEqual(methodNames(whole, ADMIN_ROOT).toSorted());
  });
});

describe("the admin schema", () => {
  test("is rooted at AdminApi, with the methods the kind table keeps and none it omits", () => {
    expect(admin.format).toBe(whole.format);
    expect(admin.entry).toBe("AdminApi");
    expect(methodNames(admin, "AdminApi").toSorted()).toEqual(kept.toSorted());
    expect(methodNames(admin, "AdminApi").filter((name) => omitted.includes(name))).toEqual([]);
    // Each kept method is the Workshop schema's own, parameters, result and doc.
    expect(admin.services.AdminApi!.methods)
      .toEqual(whole.services.AdminApi!.methods.filter((method) => kept.includes(method.name)));
  });

  test("holds what AdminApi reaches, the views among it, and nothing else", () => {
    const reached = reachable(admin);
    expect(Object.keys(admin.services)).toEqual(reached.services);
    expect(Object.keys(admin.shapes)).toEqual(reached.shapes);
    // A view a kept method opens is a service of its own, whole.
    for (const [method, view] of [["inspectWorkspace", "AdminWorkspaceView"], ["inspectUser", "AdminUserView"]]) {
      expect(admin.services.AdminApi!.methods.find((kept) => kept.name === method)!.returns)
        .toEqual({ kind: "stub", service: view });
      expect(admin.services[view!]).toEqual(whole.services[view!]);
    }
    expect(Object.keys(admin.services)).toEqual(["AdminApi", "AdminUserView", "AdminWorkspaceView"]);
    for (const [name, shape] of Object.entries(admin.shapes)) expect(shape).toEqual(whole.shapes[name]);
  });

  test("holds no constants and none of the services that lead to AdminApi", () => {
    expect(whole.constants).not.toEqual({});
    expect(admin.constants).toEqual({});
    for (const service of ["AuthenticatedApi", "Overseer", "PublicApi"]) {
      expect(Object.keys(whole.services)).toContain(service);
      expect(Object.keys(admin.services)).not.toContain(service);
    }
  });

  test("declares what the whole schema declares from AdminApi less the omitted methods", () => {
    const header = "Header.";
    const fromAdmin = emitDeclarations(admin, { root: ADMIN_ROOT, header });
    const fromWhole = emitDeclarations(whole, { root: ADMIN_ROOT, omit: ADMIN_OMIT, header });
    expect(fromAdmin.full).toBe(fromWhole.full);
    expect(fromAdmin.fragments).toEqual(fromWhole.fragments);
    expect(Object.keys(fromAdmin.fragments).toSorted()).toEqual(Object.keys(admin.services));
    for (const name of kept) expect(fromAdmin.fragments.AdminApi).toMatch(declares(name));
    for (const name of omitted) expect(fromAdmin.full).not.toMatch(declares(name));
  });
});

describe("a kind table out of step with AdminApi", () => {
  test("fails the generation, naming a method AdminApi declares and the table lacks", () => {
    const schema = withMethods((methods) => {
      methods.push({ name: "wipeEverything", doc: "", params: [], returns: { kind: "void" } });
      methods.push({ name: "wipeTheRest", doc: "", params: [], returns: { kind: "void" } });
    });
    expect(() => renderApiSchema(schema)).toThrow(
      "AdminApi.wipeEverything has no kind in ADMIN_AGENT_KINDS; AdminApi.wipeTheRest has no kind in ADMIN_AGENT_KINDS " +
      "(packages/workshop-shared/src/admin-agent.ts)");
  });

  test("fails the generation, naming a method the table classifies and AdminApi lacks", () => {
    for (const name of ["listUsers", "setSiteName"]) {
      const schema = withMethods((methods) => {
        methods.splice(methods.findIndex((method) => method.name === name), 1);
      });
      expect(() => renderApiSchema(schema)).toThrow(
        `ADMIN_AGENT_KINDS names ${name}, which AdminApi does not declare (packages/workshop-shared/src/admin-agent.ts)`);
    }
  });
});
