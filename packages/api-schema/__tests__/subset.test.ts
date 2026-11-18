// subsetSchema(), on the extractor's fixture and on this repository's own `workshop-shared/src/api.ts`.
// Its walk is its own, not the declaration emitter's, so the emitter's output from the subset is
// held equal to its output from the whole schema with the same omissions.

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AGENT_OMIT, AGENT_ROOT, API_SOURCE } from "../scripts/generate.ts";
import { emitDeclarations } from "../src/emit/dts.ts";
import { extractSchema } from "../src/extract.ts";
import { type ApiShape, FORMAT, type Schema, type SchemaService } from "../src/schema.ts";
import { subsetSchema } from "../src/subset.ts";

const PACKAGE = join(import.meta.dirname, "..");
const FIXTURE = extractSchema({
  entry: join(PACKAGE, "__tests__", "__fixtures__", "api.ts"),
  tsconfig: join(PACKAGE, "tsconfig.json"),
  entryName: "FixturePublicApi",
  constants: ["SERVICE_SALT"],
});

const methodNames = (schema: Schema, service: string) => schema.services[service]!.methods.map((m) => m.name);

/** A schema of one service, `Api`, with `service`'s fields over one method returning `returns`. */
const schemaOf = (returns: ApiShape, service: Partial<SchemaService> = {}): Schema => ({
  format: FORMAT,
  entry: "Api",
  constants: {},
  services: {
    Api: { doc: "", direction: "server", methods: [{ name: "m", doc: "", params: [], returns }], ...service },
  },
  shapes: {},
});

const leaf = (name: string): ApiShape => ({ kind: "ref", name });

/** Holds emitDeclarations of the subset equal to emitDeclarations of the whole with `omit`. */
function expectSameDeclarations(schema: Schema, root: string, omit?: string[]) {
  const subset = subsetSchema(schema, { root, ...(omit ? { omit } : {}) });
  const header = "Header.";
  const whole = emitDeclarations(schema, { root, header, ...(omit ? { omit } : {}) });
  const fromSubset = emitDeclarations(subset, { root, header });
  expect(fromSubset.full).toBe(whole.full);
  expect(fromSubset.fragments).toEqual(whole.fragments);
}

describe("the fixture", () => {
  test("keeps the root and what it reaches, through parameters, results and properties", () => {
    const subset = subsetSchema(FIXTURE, { root: "FixtureAuthedApi" });
    // Cursor only through a subscriber's parameter; the `{}` handle through Notebook's results.
    expect(Object.keys(subset.services)).toEqual(
      ["Cursor", "FixtureAdmin", "FixtureAuthedApi", "Notebook", "NotesSubscriber", "{}"]);
    expect(Object.keys(subset.shapes)).toEqual(["Destination", "Mood", "Note", "Outline"]);
    for (const [name, service] of Object.entries(subset.services)) expect(service).toEqual(FIXTURE.services[name]);
    for (const [name, shape] of Object.entries(subset.shapes)) expect(shape).toEqual(FIXTURE.shapes[name]);

    // From the entry: its properties stay, and what only it reaches is kept.
    const entry = subsetSchema(FIXTURE, { root: "FixturePublicApi" });
    expect(entry.services).toEqual(FIXTURE.services);
    expect(entry.shapes).toEqual(FIXTURE.shapes);
    expect(entry.services.FixturePublicApi!.properties!.map((p) => p.name)).toEqual(["build", "version"]);
  });

  test("drops the services and shapes the root does not reach", () => {
    // Above FixtureAuthedApi: the entry, and the legacy notes only it returns.
    const authed = subsetSchema(FIXTURE, { root: "FixtureAuthedApi" });
    expect(Object.keys(authed.services)).not.toContain("FixturePublicApi");
    expect(Object.keys(authed.services)).not.toContain("LegacyNotes");

    const legacy = subsetSchema(FIXTURE, { root: "LegacyNotes" });
    expect(Object.keys(legacy.services)).toEqual(["Cursor", "LegacyNotes", "{}"]);
    expect(Object.keys(legacy.shapes)).toEqual(["Note"]);

    const admin = subsetSchema(FIXTURE, { root: "FixtureAdmin" });
    expect(Object.keys(admin.services)).toEqual(["FixtureAdmin"]);
    expect(admin.shapes).toEqual({});
  });

  test("follows every edge of a shape, and a property's type", () => {
    const names = ["Element", "Index", "Key", "Member", "Param", "Property", "Read", "Rest", "Result", "Value", "Written"];
    const schema: Schema = {
      ...schemaOf({
        kind: "tuple",
        elements: [
          { kind: "map", key: leaf("Key"), value: leaf("Value") },
          { kind: "set", element: leaf("Element") },
          { kind: "object", properties: { member: leaf("Member") }, index: leaf("Index") },
          { kind: "readableStream", element: leaf("Read") },
          { kind: "writableStream", element: leaf("Written") },
          { kind: "function", params: [{ name: "param", type: leaf("Param"), optional: false }], returns: leaf("Result") },
        ],
        rest: leaf("Rest"),
      }, {
        properties: [
          { name: "other", doc: "", type: { kind: "stub", service: "Other" }, optional: false },
          { name: "value", doc: "", type: leaf("Property"), optional: true },
        ],
      }),
      shapes: Object.fromEntries([...names, "Unreached"].map((name) => [name, { kind: "string" }])),
    };
    schema.services.Other = { doc: "", direction: "server", methods: [] };
    schema.services.Unreached = { doc: "", direction: "server", methods: [] };

    const subset = subsetSchema(schema, { root: "Api" });
    expect(Object.keys(subset.services)).toEqual(["Api", "Other"]);
    expect(Object.keys(subset.shapes)).toEqual(names);
    expectSameDeclarations(schema, "Api");
  });

  test("names the root as its entry, and keeps no constants", () => {
    expect(Object.keys(FIXTURE.constants)).toEqual(["SERVICE_SALT"]);
    const subset = subsetSchema(FIXTURE, { root: "Notebook" });
    expect(subset.format).toBe(FORMAT);
    expect(subset.entry).toBe("Notebook");
    expect(subset.constants).toEqual({});
    expect(Object.keys(subset)).toEqual(["format", "entry", "constants", "services", "shapes"]);
  });

  test("leaves out an omitted method, with what only it reached", () => {
    const subset = subsetSchema(FIXTURE, { root: "FixtureAuthedApi", omit: ["getAdmin", "outline"] });
    expect(methodNames(subset, "FixtureAuthedApi")).toEqual(["findNotes", "importArchive", "openNotebook", "setMood", "setNickname"]);
    expect(methodNames(subset, "Notebook")).not.toContain("outline");
    expect(Object.keys(subset.services)).not.toContain("FixtureAdmin");
    expect(Object.keys(subset.shapes)).toEqual(["Destination", "Mood", "Note"]);

    // What another method still reaches stays: NotesSubscriber through openNotebook's observer.
    const reached = subsetSchema(FIXTURE, { root: "FixtureAuthedApi", omit: ["subscribe"] });
    expect(methodNames(reached, "Notebook")).not.toContain("subscribe");
    expect(Object.keys(reached.services)).toContain("NotesSubscriber");

    // The source is left as it was.
    expect(methodNames(FIXTURE, "FixtureAuthedApi")).toContain("getAdmin");
    expect(methodNames(FIXTURE, "Notebook")).toContain("outline");
  });

  test("omits `Service.method` on that service only", () => {
    const schema: Schema = {
      ...FIXTURE,
      services: {
        ...FIXTURE.services,
        // A second `lock`, beside Notebook's.
        FixtureAdmin: { ...FIXTURE.services.FixtureAdmin!, methods: FIXTURE.services.Notebook!.methods.filter((m) => m.name === "lock") },
      },
    };
    const qualified = subsetSchema(schema, { root: "FixtureAuthedApi", omit: ["Notebook.lock", "FixtureAuthedApi.outline"] });
    expect(methodNames(qualified, "Notebook")).not.toContain("lock");
    expect(methodNames(qualified, "FixtureAdmin")).toEqual(["lock"]);
    // `outline` is Notebook's, not FixtureAuthedApi's.
    expect(methodNames(qualified, "Notebook")).toContain("outline");

    const bare = subsetSchema(schema, { root: "FixtureAuthedApi", omit: ["lock"] });
    expect(methodNames(bare, "Notebook")).not.toContain("lock");
    expect(methodNames(bare, "FixtureAdmin")).toEqual([]);
  });

  test("keeps docs, tags and directions", () => {
    const subset = subsetSchema(FIXTURE, { root: "FixturePublicApi", omit: ["ping"] });
    expect(subset.services.FixtureAuthedApi!.doc).toBe("The authenticated API, as upstream's AuthenticatedApi.");
    expect(subset.services.LegacyNotes!.deprecated).toBe("Kept for clients from before accounts.");
    expect(subset.services.NotesSubscriber!.direction).toBe("client");
    expect(subset.services["{}"]!.direction).toBe("both");
    expect(subset.services.FixturePublicApi!.properties!.find((p) => p.name === "build")!.deprecated).toBe("Read version.");

    const file = subset.services.Notebook!.methods.find((m) => m.name === "file")!;
    expect(file).toMatchObject({ doc: "An object and an object union.\n@mutates\n@since 2", mutates: true, tags: { since: "2" } });
    expect(subset.services.FixtureAuthedApi!.methods.find((m) => m.name === "openNotebook")!.params[0]!.doc)
      .toBe("The notebook's ID.");

    const note = subset.shapes.Note as Extract<ApiShape, { kind: "object" }> & { doc?: string };
    expect(note.doc).toBe("A stored note.");
    expect(note.propertyDocs!.heading).toEqual({
      doc: "Its first line, from before titles.\n@deprecated Read title.\n@since 1",
      deprecated: "Read title.",
      tags: { since: "1" },
    });

    // A service's own tags, which the fixture has none of.
    const tagged = schemaOf({ kind: "void" }, { doc: "Doc.", deprecated: "", tags: { internal: "" } });
    expect(subsetSchema(tagged, { root: "Api" }).services.Api).toEqual(tagged.services.Api);
  });

  test("is deterministic, with sorted keys", () => {
    const subset = subsetSchema(FIXTURE, { root: "FixtureAuthedApi", omit: ["outline"] });
    expect(JSON.stringify(subsetSchema(FIXTURE, { root: "FixtureAuthedApi", omit: ["outline"] })))
      .toBe(JSON.stringify(subset));
    for (const keys of [Object.keys(subset.services), Object.keys(subset.shapes)]) {
      expect(keys.length).toBeGreaterThan(1);
      expect(keys).toEqual(keys.toSorted());
    }
    // A subset of everything is the schema, byte for byte, less its constants.
    expect(JSON.stringify(subsetSchema(FIXTURE, { root: FIXTURE.entry }))).toBe(JSON.stringify({ ...FIXTURE, constants: {} }));
  });

  test("refuses a root the client implements, and names the schema lacks", () => {
    expect(() => subsetSchema(FIXTURE, { root: "NotesSubscriber" })).toThrow(/NotesSubscriber is implemented by the client/);
    expect(() => subsetSchema(FIXTURE, { root: "Nope" })).toThrow("no service Nope in the schema");
    // Not a name inherited from Object.prototype either.
    expect(() => subsetSchema(FIXTURE, { root: "toString" })).toThrow("no service toString in the schema");
    expect(() => subsetSchema(schemaOf({ kind: "stub", service: "Gone" }), { root: "Api" }))
      .toThrow("no service Gone in the schema");
    expect(() => subsetSchema(schemaOf({ kind: "array", element: { kind: "ref", name: "Gone" } }), { root: "Api" }))
      .toThrow("no shape Gone in the schema");
    expect(() => subsetSchema(schemaOf({ kind: "ref", name: "constructor" }), { root: "Api" }))
      .toThrow("no shape constructor in the schema");
    // A service travelling both ways is one a caller holds.
    expect(subsetSchema(FIXTURE, { root: "{}" }).entry).toBe("{}");
  });

  test("declares what the whole schema declares with the same omissions", () => {
    expectSameDeclarations(FIXTURE, "FixturePublicApi");
    expectSameDeclarations(FIXTURE, "FixtureAuthedApi");
    expectSameDeclarations(FIXTURE, "FixtureAuthedApi", ["getAdmin", "Notebook.outline", "Notebook.subscribe"]);
    expectSameDeclarations(FIXTURE, "LegacyNotes", ["release"]);
  });
});

describe("the Workshop API", () => {
  const schema = extractSchema(API_SOURCE);

  test("declares what the whole schema declares from AdminApi, less a method", () => {
    // A method returning a capability, so that omitting it leaves out a service as well.
    const opener = schema.services.AdminApi!.methods.find((m) => m.returns.kind === "stub" && m.returns.service !== undefined)!;
    const opened = (opener.returns as Extract<ApiShape, { kind: "stub" }>).service!;
    const omit = [`AdminApi.${opener.name}`];

    const whole = subsetSchema(schema, { root: "AdminApi" });
    expect(whole.entry).toBe("AdminApi");
    expect(Object.keys(whole.services)).toContain(opened);
    expect(whole.services.AdminApi).toEqual(schema.services.AdminApi);

    const less = subsetSchema(schema, { root: "AdminApi", omit });
    expect(methodNames(less, "AdminApi")).toEqual(methodNames(schema, "AdminApi").filter((name) => name !== opener.name));
    expect(Object.keys(less.services)).not.toContain(opened);

    expectSameDeclarations(schema, "AdminApi", omit);
    expectSameDeclarations(schema, "AdminApi");
  });

  test("declares what the whole schema declares from the agent's root, less the methods an agent never calls", () => {
    const subset = subsetSchema(schema, { root: AGENT_ROOT, omit: AGENT_OMIT });
    expect(Object.keys(subset.services)).not.toContain(schema.entry);
    for (const service of Object.keys(subset.services)) {
      expect(methodNames(subset, service).filter((name) => AGENT_OMIT.includes(name))).toEqual([]);
    }
    expectSameDeclarations(schema, AGENT_ROOT, AGENT_OMIT);
  });
});
