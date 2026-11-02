import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateBundledBlueprintsModule } from "../src/generate.ts";
import { parseBundledBlueprintManifest, parseBundledBlueprintPresentation } from "../src/manifest.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, {recursive: true, force: true})));
});

const presentation = {
  blueprintId: "format.example",
  title: "Example",
  description: "An example blueprint.",
  output: {id: "example", noun: "Example", plural: "Examples", icon: "fileText"},
  author: {type: "user", name: "Test", id: "test@example.com"},
  revision: 1,
};

const manifest = {
  ...presentation,
  created: "2026-01-01T00:00:00.000Z",
  version: 1,
  lastUpdated: "2026-01-01T00:00:00.000Z",
  bindings: {},
};

describe("bundled blueprint manifest", () => {
  it.each(["use", "build"])("accepts publication %s", role => {
    let raw = JSON.stringify({...manifest, publication: role});
    expect(parseBundledBlueprintManifest("example", raw).publication).toBe(role);
    expect(parseBundledBlueprintPresentation("example.json",
        JSON.stringify({...presentation, publication: role})).publication).toBe(role);
  });

  it("omits publication when the manifest declares none", () => {
    expect(parseBundledBlueprintManifest("example", JSON.stringify(manifest)))
        .not.toHaveProperty("publication");
    expect(parseBundledBlueprintPresentation("example.json", JSON.stringify(presentation)))
        .not.toHaveProperty("publication");
  });

  it.each([["admin"], [""], [true], [1], [null], [["use"]]])("refuses publication %j", role => {
    let raw = JSON.stringify({...manifest, publication: role});
    expect(() => parseBundledBlueprintManifest("example", raw))
        .toThrow("example/blueprint.json: publication must be one of: use, build");
  });

  it("refuses a bad publication in a presentation", () => {
    let raw = JSON.stringify({...presentation, publication: "admin"});
    expect(() => parseBundledBlueprintPresentation("example.json", raw))
        .toThrow("example.json: publication must be one of: use, build");
  });

  it("refuses a key the manifest does not define", () => {
    let raw = JSON.stringify({...manifest, published: "use"});
    expect(() => parseBundledBlueprintManifest("example", raw))
        .toThrow("example/blueprint.json: unknown keys: published");
  });
});

/** Generates the module from `blueprints`, each with a minimal files/ tree. */
async function generate(blueprints: Record<string, object>): Promise<string> {
  let directory = await mkdtemp(join(tmpdir(), "bundled-blueprint-"));
  temporaryDirectories.push(directory);
  for (let [name, json] of Object.entries(blueprints)) {
    await mkdir(join(directory, name, "files"), {recursive: true});
    await writeFile(join(directory, name, "blueprint.json"), JSON.stringify(json));
    await writeFile(join(directory, name, "files", "server.js"), "export default {};\n");
  }
  return (await generateBundledBlueprintsModule(directory, {builtFrom: "a test"})).text;
}

/** The `BUNDLED_BLUEPRINTS` array a generated module declares. */
function entries(text: string): Array<Record<string, unknown>> {
  let json = /export const BUNDLED_BLUEPRINTS: BundledBlueprint\[\] = (.*);\n$/su.exec(text)?.[1];
  expect(json).toBeDefined();
  return JSON.parse(json!);
}

describe("generated bundled blueprints module", () => {
  it("carries a declared publication into its entry and types it", async () => {
    let text = await generate({
      published: {...manifest, blueprintId: "format.published", publication: "use"},
      plain: {...manifest, blueprintId: "format.plain"},
    });

    expect(text).toContain("publication?: CollaboratorRole;");
    let byId = new Map(entries(text).map(entry => [entry.blueprintId, entry]));
    expect(byId.get("format.published")?.publication).toBe("use");
    expect(byId.get("format.plain")).not.toHaveProperty("publication");
  });
});
