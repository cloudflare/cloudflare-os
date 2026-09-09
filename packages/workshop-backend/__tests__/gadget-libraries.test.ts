import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Y from "yjs";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  GADGET_JSON_PATH, type GadgetPins, LIBRARY_SIDES, type LibrarySide, formatPins,
  libraryImportsIn, librarySpecifier, parsePins, readPins,
} from "../src/gadget-libraries.js";
import { describeGadgetLibrary } from "../src/agent.js";
import {
  LIBRARIES_FINGERPRINT, blueprintFilesFromCode, gadgetWorkerModules, resolveLibraries,
} from "../src/gadget-library-resolution.js";
import { FORMAT_BLUEPRINTS } from "../src/generated/format-blueprints.js";
import { type BundledGadgetLibrary, GADGET_LIBRARIES } from "../src/generated/gadget-libraries.js";
import { parseBlueprintArchive } from "../src/blueprint-archive.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    LOADER: WorkerLoader;
  }
}

// Gadget libraries against the real OverseerImpl in workerd: how a pin resolves, what the loader
// and the UI bundle are handed, and what the agent is told about a library-backed gadget.

const SYNC = GADGET_LIBRARIES.find(library => library.name === "sync")!;
const UI = GADGET_LIBRARIES.find(library => library.name === "ui")!;
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };

/**
 * Every bundled library `names` load transitively, in pin order (gadget.json is written sorted by
 * name). A gadget pins its libraries' dependencies as well as its own, so this is what a gadget over
 * `names` has to pin -- derived from the bundles' dependency lists rather than spelled out.
 */
function librariesLoadedBy(...names: string[]): BundledGadgetLibrary[] {
  let loaded = new Set<string>();
  let visit = (name: string) => {
    if (loaded.has(name)) return;
    loaded.add(name);
    for (let dependency of GADGET_LIBRARIES.find(library => library.name === name)!.dependencies) {
      visit(dependency);
    }
  };
  for (let name of names) visit(name);
  return [...loaded].toSorted().map(name => GADGET_LIBRARIES.find(library => library.name === name)!);
}

/** The libraries the test gadget pins: sync and ui, and whatever they import. */
const GADGET_LIBRARIES_PINNED = librariesLoadedBy("sync", "ui");
const LATEST_PINS: GadgetPins = new Map(GADGET_LIBRARIES_PINNED.map(library => [library.name, "latest"]));

/** The modules one side of the gadget resolves to: each pinned library's shipped bundle, in pin order. */
function shippedModules(side: LibrarySide): { specifier: string, code: string, hash: string }[] {
  return GADGET_LIBRARIES_PINNED.map(library => ({
    specifier: librarySpecifier(library.name, side), code: library[side].code, hash: library[side].hash,
  }));
}

/** A gadget built on the shipped libraries: a Durable Object over the sync registry, a UI over ui. */
const GADGET_FILES: Record<string, string> = {
  "client.js": 'import { el } from "gadgets:ui/client";\nimport { createSubscriber } from "gadgets:sync/client";\n' +
      'document.body.append(el("div", { text: "hello" }));\nvoid createSubscriber;\n',
  "server.js": 'import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";\n' +
      'import { MutationQueue, SubscriberRegistry } from "gadgets:sync/server";\n' +
      'import { clientOnly } from "gadgets:ui/server";\n' +
      "export class Gadget extends DurableObject {\n" +
      "  constructor(ctx, env) { super(ctx, env); this.mutations = new MutationQueue(); this.subscribers = new SubscriberRegistry(); }\n" +
      "  count() { return this.mutations.run(() => this.subscribers.size); }\n" +
      "}\n" +
      "export class ExportHandler extends WorkerEntrypoint {\n" +
      '  getExportFormats() { return [{ id: "flag", label: String(clientOnly), mode: "server", contentType: "text/plain", fileExtension: ".txt" }]; }\n' +
      "}\n",
  [GADGET_JSON_PATH]: formatPins(LATEST_PINS),
};

/**
 * A gadget whose server side spans directories, each importing a library by its bare specifier: what
 * agent-written JavaScript produces, and what the blueprint check accepts. The entrypoint reports
 * whether the class reached through `lib/` is the one server.js imports directly.
 */
const NESTED_FILES: Record<string, string> = {
  "client.js": GADGET_FILES["client.js"],
  "server.js": 'import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";\n' +
      'import { MutationQueue } from "gadgets:sync/server";\n' +
      'import { Queue, viaDeep } from "./lib/impl.js";\n' +
      "export class Gadget extends DurableObject {}\n" +
      "export class ExportHandler extends WorkerEntrypoint {\n" +
      "  sameBinding() { return [MutationQueue === Queue, viaDeep === MutationQueue]; }\n" +
      "}\n",
  "lib/impl.js": 'export { MutationQueue as Queue } from "gadgets:sync/server";\n' +
      'export { viaDeep } from "./deep/more.js";\n',
  "lib/deep/more.js": 'import { MutationQueue } from "gadgets:sync/server";\n' +
      'import { clientOnly } from "gadgets:ui/server";\n' +
      "export const viaDeep = clientOnly ? MutationQueue : null;\n",
  [GADGET_JSON_PATH]: formatPins(LATEST_PINS),
};

/** A gadget whose server.js is one re-export line over a library. */
const REEXPORT_FILES: Record<string, string> = {
  "client.js": 'import "gadgets:ui/client";\n',
  "server.js": 'export { Gadget } from "gadgets:sync/server";\n',
  [GADGET_JSON_PATH]: formatPins(LATEST_PINS),
};

function files(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

/** A blueprint code archive (the Yjs snapshot instantiation decodes) holding `entries`. */
function archiveOf(entries: Record<string, string>): Uint8Array {
  let doc = new Y.Doc();
  doc.transact(() => {
    for (let [name, text] of Object.entries(entries)) {
      doc.getMap<Y.Text>().set(name, new Y.Text(text));
    }
  });
  return Y.encodeStateAsUpdateV2(doc);
}

let doCounter = 0;
/** The real overseer, owned by OWNER through a stand-in User DO. */
async function withWorkspace(
    fn: (instance: OverseerDurableObject, impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`gadget-libraries-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = "owner-id";
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({
        id: { toString: () => "owner-id" },
        whoami: async () => OWNER,
        whoamiIfExists: async () => OWNER,
        setGadgetLastActive: async () => {},
        syncWorkspaceOutputs: async () => {},
      }),
    };
    await fn(instance, impl);
  });
}

async function headFiles(impl: any): Promise<Map<string, string>> {
  let gadgetId = impl.resolveGadgetId(undefined);
  return await impl.gitStore.readCommitFiles(impl.getGadgetHead(gadgetId));
}

describe("the shipped libraries", () => {
  it("are the ones the bundled blueprints build on", () => {
    expect(GADGET_LIBRARIES.map(library => library.name)).toEqual(["sync", "ui"]);
    for (let library of GADGET_LIBRARIES) {
      for (let side of LIBRARY_SIDES) {
        expect(library[side].hash, `${library.name} ${side}`).toMatch(/^[0-9a-f]{64}$/);
        expect(library[side].code.length).toBeGreaterThan(0);
      }
    }
    // ui is client-only: its server side is the documented flag-only module.
    expect(UI.server.code).toContain("clientOnly");
    expect(SYNC.server.code).toContain("MutationQueue");
  });

  it("carry both entries' declarations, with the doc comments the bundles drop", () => {
    for (let library of GADGET_LIBRARIES) {
      let paths = library.declarations.map(declaration => declaration.path);
      expect(paths, library.name).toContain("client.d.ts");
      expect(paths, library.name).toContain("server.d.ts");
      expect(paths).toEqual([...paths].toSorted());
      for (let declaration of library.declarations) {
        expect(declaration.path).toMatch(/^(client|server|src\/[a-z-]+)\.d\.ts$/);
      }
    }
    let server = SYNC.declarations.find(declaration => declaration.path === "server.d.ts")!;
    expect(server.side).toBe("server");
    expect(server.text).toContain("MutationQueue");
    let registry = SYNC.declarations.find(declaration => declaration.path === "src/subscribers.d.ts")!;
    expect(registry.text).toMatch(/export declare class SubscriberRegistry/);
    expect(registry.text).toContain("/**");
    expect(SYNC.server.code).not.toContain("/**");
  });

  it("are described to the agent from the manifest and the declarations, entry first", () => {
    let text = describeGadgetLibrary("sync");
    expect(text).toMatch(/^Gadget library sync \d+\.\d+\.\d+\n/);
    expect(text).toContain(SYNC.notes);
    expect(text).toContain('from "gadgets:sync/server"');
    let headers = [...text.matchAll(/^\/\/ (gadgets:.*): (\S+)$/gm)].map(match => [match[1], match[2]]);
    expect(headers).toContainEqual(["gadgets:sync/server", "server.d.ts"]);
    expect(headers).toContainEqual(["gadgets:sync/client", "client.d.ts"]);
    expect(headers).toHaveLength(SYNC.declarations.length);
    let sides = headers.map(([specifiers]) => specifiers!.includes(" and ") ? "both"
        : specifiers!.endsWith("/server") ? "server" : "client");
    // Shared modules, then the server's with its entry first, then the client's likewise.
    expect(sides.join(",")).toMatch(/^(both,)*(server,)+(client,?)+$/);
    expect(headers[sides.indexOf("server")]![1]).toBe("server.d.ts");
    expect(headers[sides.indexOf("client")]![1]).toBe("client.d.ts");
    expect(text).toContain("export declare class SubscriberRegistry");

    let serverOnly = describeGadgetLibrary("sync", "server");
    expect(serverOnly).toContain("// gadgets:sync/server: server.d.ts");
    expect(serverOnly).not.toContain("client.d.ts");
    expect(serverOnly.length).toBeLessThan(text.length);

    expect(() => describeGadgetLibrary("other"))
        .toThrow(/no gadget library named "other"; it ships sync, ui\./);
  });

  it("are found in a gadget's code by specifier, per side", () => {
    expect(libraryImportsIn(GADGET_FILES["server.js"]!, "server")).toEqual(["sync", "ui"]);
    expect(libraryImportsIn(GADGET_FILES["server.js"]!, "client")).toEqual([]);
    expect(libraryImportsIn(GADGET_FILES["client.js"]!, "client")).toEqual(["ui", "sync"]);
    expect(libraryImportsIn(
        'import { a } from "gadgets:sync/server";\nimport { b } from "gadgets:ui/server"; // gadgets:sync/server again',
        "server")).toEqual(["sync", "ui"]);
    expect(libraryImportsIn("import 'gadgets:ui/client'; import 'gadgets:Bad/client'", "client"))
        .toEqual(["ui"]);
  });
});

describe("resolveLibraries", () => {
  it("resolves latest pins to the shipped bundles, by side, in pin order", () => {
    let pins = parsePins(GADGET_FILES[GADGET_JSON_PATH]!);
    expect(pins).toEqual(LATEST_PINS);
    expect(resolveLibraries(pins, "server")).toEqual(shippedModules("server"));
    expect(resolveLibraries(pins, "client")).toEqual(shippedModules("client"));
  });

  it("refuses a pin whose bundled dependency is unpinned, naming the pin to add", () => {
    // No shipped library imports another today, so the rule is exercised against a stand-in
    // dependency list the way the resolver reads it.
    let withDependency = GADGET_LIBRARIES.find(library => library.dependencies.length > 0);
    if (!withDependency) {
      expect(resolveLibraries(new Map([["sync", "latest"]]), "server")).toHaveLength(1);
      return;
    }
    let [dependency] = withDependency.dependencies;
    expect(() => resolveLibraries(new Map([[withDependency!.name, "latest"]]), "server"))
        .toThrow(`pins ${withDependency!.name}, which imports ${dependency}; pin ${dependency} too.`);
  });

  it("refuses a pin the deployment does not bundle", () => {
    expect(() => resolveLibraries(new Map([["nope", "latest"]]), "server"))
        .toThrow(/no library named nope/);
  });

  it("names every shipped bundle in the loader fingerprint", () => {
    expect(GADGET_LIBRARIES.length).toBeGreaterThan(0);
    for (let library of GADGET_LIBRARIES) {
      expect(LIBRARIES_FINGERPRINT).toContain(library.client.hash.slice(0, 16));
      expect(LIBRARIES_FINGERPRINT).toContain(library.server.hash.slice(0, 16));
    }
  });
});

describe("gadgetWorkerModules", () => {
  it("adds each pinned server library as a typed module under its specifier", () => {
    let { modules, libraries } = gadgetWorkerModules(files({
      ...GADGET_FILES, "gadgets:sync/server": "// a file that happens to share the name",
    }));
    expect(modules["server.js"]).toBe(GADGET_FILES["server.js"]);
    for (let { specifier, code } of shippedModules("server")) {
      expect(modules[specifier], specifier).toEqual({ js: code });
    }
    expect(modules).not.toHaveProperty(GADGET_JSON_PATH);
    expect(libraries.map(library => library.specifier))
        .toEqual(shippedModules("server").map(library => library.specifier));
  });

  it("fails the load on a malformed gadget.json", () => {
    expect(() => gadgetWorkerModules(files({ ...GADGET_FILES, [GADGET_JSON_PATH]: "{" })))
        .toThrow(/gadget\.json: not valid JSON/);
    expect(() => gadgetWorkerModules(files({
      ...GADGET_FILES, [GADGET_JSON_PATH]: '{"libraries": {"sync": "newest"}}',
    }))).toThrow(/must be "latest"/);
  });

  it("is what workerd's loader runs: a gadget over the shipped libraries resolves its imports", async () => {
    let { modules } = gadgetWorkerModules(files(GADGET_FILES));
    expect(Object.keys(modules).toSorted()).toEqual(
        ["client.js", "server.js", ...shippedModules("server").map(library => library.specifier)].toSorted());
    let worker = env.LOADER.get(`gadget-libraries-gadget-${++doCounter}`, async () => ({
      compatibilityDate: "2026-02-01",
      compatibilityFlags: ["allow_irrevocable_stub_storage"],
      mainModule: "server.js",
      modules,
      globalOutbound: null,
    }));
    let handler = worker.getEntrypoint<{ getExportFormats(): Promise<{ id: string, label: string }[]> }>(
        "ExportHandler");
    expect(await handler.getExportFormats()).toEqual([expect.objectContaining({ id: "flag", label: "true" })]);
    expect(worker.getDurableObjectClass("Gadget")).toBeDefined();
  });

  it("registers no shims for a flat gadget, and one per directory and library for a nested one", () => {
    let flat = gadgetWorkerModules(files(GADGET_FILES)).modules;
    expect(Object.keys(flat).filter(name => name.includes("/gadgets:"))).toEqual([]);

    let { modules } = gadgetWorkerModules(files(NESTED_FILES));
    expect(Object.keys(modules).filter(name => name.includes("/gadgets:")).toSorted()).toEqual(
        ["lib", "lib/deep"].flatMap(directory =>
            shippedModules("server").map(library => `${directory}/${library.specifier}`)).toSorted());
    // One `../` per slash in the shim's own name: workerd takes `lib/gadgets:sync/` as its directory.
    expect(modules["lib/gadgets:sync/server"]).toEqual({ js: 'export * from "../../gadgets:sync/server";\n' });
    expect(modules["lib/deep/gadgets:ui/server"])
        .toEqual({ js: 'export * from "../../../gadgets:ui/server";\n' });
  });

  it("resolves a bare library import from a nested module to the one root instance", async () => {
    // workerd resolves `gadgets:sync/server` in lib/impl.js as `lib/gadgets:sync/server`; without the
    // shims the load fails with "No such module". The `../` climb is also what a library's own
    // import of another library relies on (see scripts/build-gadget-libraries.ts).
    let { modules } = gadgetWorkerModules(files(NESTED_FILES));
    let worker = env.LOADER.get(`gadget-libraries-nested-${++doCounter}`, async () => ({
      compatibilityDate: "2026-02-01",
      compatibilityFlags: ["allow_irrevocable_stub_storage"],
      mainModule: "server.js",
      modules,
      globalOutbound: null,
    }));
    let handler = worker.getEntrypoint<{ sameBinding(): Promise<boolean[]> }>("ExportHandler");
    expect(await handler.sameBinding()).toEqual([true, true]);
  });
});

describe("blueprintFilesFromCode", () => {
  it("decodes an archive whose pins the deployment honours", () => {
    expect(blueprintFilesFromCode(archiveOf(GADGET_FILES))).toEqual(files(GADGET_FILES));
    expect(blueprintFilesFromCode(archiveOf({ "client.js": "// plain\n" })))
        .toEqual(files({ "client.js": "// plain\n" }));
  });

  it("refuses an empty archive", () => {
    expect(() => blueprintFilesFromCode(archiveOf({}))).toThrow(/code archive is empty/);
  });

  it("refuses a pin the deployment does not bundle, on either side", () => {
    expect(() => blueprintFilesFromCode(archiveOf({
      ...GADGET_FILES, [GADGET_JSON_PATH]: formatPins(new Map([["nope", "latest"]])),
    }))).toThrow(/no library named nope/);
    expect(() => blueprintFilesFromCode(archiveOf({ "server.js": "export class Gadget {}\n", [GADGET_JSON_PATH]: "{" })))
        .toThrow(/gadget\.json: not valid JSON/);
  });

  it("refuses a pin whose bundled dependency is unpinned", () => {
    // Same stand-in as resolveLibraries' own case: no shipped library imports another today.
    let withDependency = GADGET_LIBRARIES.find(library => library.dependencies.length > 0);
    if (!withDependency) {
      expect(blueprintFilesFromCode(archiveOf(REEXPORT_FILES))).toEqual(files(REEXPORT_FILES));
      return;
    }
    let [dependency] = withDependency.dependencies;
    expect(() => blueprintFilesFromCode(archiveOf({
      ...GADGET_FILES, [GADGET_JSON_PATH]: formatPins(new Map([[withDependency!.name, "latest"]])),
    }))).toThrow(`pin ${dependency} too.`);
  });
});

describe("the bundled blueprints", () => {
  it("pin every library their code imports, all latest, and nothing else", async () => {
    expect(FORMAT_BLUEPRINTS.length).toBeGreaterThan(0);
    for (let entry of FORMAT_BLUEPRINTS) {
      let { content } = await parseBlueprintArchive(
          new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!);
      let update = new Uint8Array(await new Response(
          content.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
      let doc = new Y.Doc();
      Y.applyUpdateV2(doc, update);
      let tree = new Map([...doc.getMap<Y.Text>()].map(([name, text]) => [name, text.toString()]));
      let pins = readPins(tree);
      let imported = new Set([
        ...libraryImportsIn(tree.get("client.js") ?? "", "client"),
        ...libraryImportsIn(tree.get("server.js") ?? "", "server"),
      ]);
      expect([...pins.keys()].toSorted(), entry.blueprintId).toEqual(
          librariesLoadedBy(...imported).map(library => library.name));
      expect(imported.size, `${entry.blueprintId} builds on the libraries`).toBeGreaterThan(0);
      // Every pin resolves against what this deployment ships.
      for (let side of LIBRARY_SIDES) expect(resolveLibraries(pins, side)).toHaveLength(pins.size);
    }
  });
});

describe("instantiating a blueprint", () => {
  it("writes the pin file with the code and refuses pins that do not resolve",
      () => withWorkspace(async (instance, impl) => {
    let unknown = { ...GADGET_FILES, [GADGET_JSON_PATH]: formatPins(new Map([["nope", "latest"]])) };
    await expect(instance.initializeFromBlueprint(archiveOf(unknown), "Broken"))
        .rejects.toThrow(/no library named nope/);
    expect(impl.defaultGadgetId).toBeUndefined();

    await instance.initializeFromBlueprint(archiveOf(GADGET_FILES), "A gadget");
    expect([...(await headFiles(impl)).keys()].toSorted())
        .toEqual(["client.js", "gadget.json", "server.js"]);
    expect(readPins(await headFiles(impl))).toEqual(LATEST_PINS);
  }));

  it("keys the loader by the shipped bundles and runs the gadget over them",
      () => withWorkspace(async (instance, impl) => {
    await instance.initializeFromBlueprint(archiveOf(GADGET_FILES), "A gadget");
    let gadgetId = impl.resolveGadgetId(undefined);
    let keys: string[] = [];
    let loader: WorkerLoader = impl.env.LOADER;
    impl.env = { ...impl.env, LOADER: { get: (key: string, code: () => Promise<WorkerLoaderWorkerCode>) => {
      keys.push(key);
      return loader.get(`${key}.${++doCounter}`, code);
    } } };
    let worker: WorkerStub = impl.loadGadgetWorker(gadgetId);
    let handler = worker.getEntrypoint<{ getExportFormats(): Promise<{ id: string }[]> }>(
        "ExportHandler");
    expect((await handler.getExportFormats()).map(format => format.id)).toEqual(["flag"]);
    expect(keys).toEqual([expect.stringContaining(`.${LIBRARIES_FINGERPRINT}`)]);
  }));

  it("points the agent at the library's declarations for a re-exporting binding, at server.js otherwise",
      () => withWorkspace(async (instance, impl) => {
    await instance.initializeFromBlueprint(archiveOf(REEXPORT_FILES), "Reexport");
    let described = await impl.describeBinding("notes", impl.resolveGadgetId(undefined));
    expect(described).toContain("re-exports its Gadget class from `gadgets:sync/server`");
    expect(described).toContain('call describeGadgetLibrary("sync") for the methods and types');
    expect(described).not.toContain("read that file");
  }).then(() => withWorkspace(async (instance, impl) => {
    await instance.initializeFromBlueprint(archiveOf(GADGET_FILES), "Built on");
    let described = await impl.describeBinding("notes", impl.resolveGadgetId(undefined));
    expect(described).toContain("which imports `gadgets:sync/server` and `gadgets:ui/server`");
    expect(described).toContain('describeGadgetLibrary("sync") and describeGadgetLibrary("ui")');
  })).then(() => withWorkspace(async (instance, impl) => {
    await instance.initializeFromBlueprint(archiveOf({
      "client.js": "// plain\n", "server.js": "export class Gadget {}\n",
    }), "Plain");
    let plain = await impl.describeBinding("plain", impl.resolveGadgetId(undefined));
    expect(plain).toContain("(read that file to learn the API it offers).");
    expect(plain).not.toContain("describeGadgetLibrary");
  })));
});

describe("the UI bundle", () => {
  it("carries library refs and serves each ref's code, from the pins", () => withWorkspace(async (instance, impl) => {
    await instance.initializeFromBlueprint(archiveOf(GADGET_FILES), "A gadget");
    let gadgetId = impl.resolveGadgetId(undefined);
    let refs = shippedModules("client");
    expect(await impl.getGadgetUiBundle(gadgetId)).toEqual({
      jsCode: GADGET_FILES["client.js"],
      libraries: refs.map(({ specifier, hash }) => ({ specifier, hash })),
    });
    for (let { specifier, code } of refs) {
      expect(await impl.getGadgetLibraryCode(gadgetId, specifier), specifier).toBe(code);
    }
    await expect(impl.getGadgetLibraryCode(gadgetId, "gadgets:sync/server"))
        .rejects.toThrow(/Not a client library/);
    // A library the gadget does not pin is refused whether or not the deployment bundles one.
    await expect(impl.getGadgetLibraryCode(gadgetId, "gadgets:other/client"))
        .rejects.toThrow(/does not import gadgets:other\/client/);
  }));

  it("has no refs for a gadget without pins", () => withWorkspace(async (instance, impl) => {
    await instance.initializeFromBlueprint(archiveOf({ "client.js": "// plain\n", "server.js": "export class Gadget {}\n" }), "Plain");
    expect(await impl.getGadgetUiBundle(impl.resolveGadgetId(undefined))).toEqual({ jsCode: "// plain\n" });
  }));
});
