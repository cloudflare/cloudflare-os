import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Y from "yjs";
import type { BlueprintMetadata } from "@gadgets/workshop-shared/api";
import {
  blueprintContentKey, deleteBlueprintContent, readBlueprintRelease, sanitizeBlueprintOutput,
} from "../src/blueprint-archive.js";
import { listReleaseFiles, readReleasePack } from "../src/blueprint-release.js";
import { parseGitCommitRefs } from "../src/git-codec.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { parseBlueprintKvRecord } from "../src/storage-schema/blueprints-kv.js";
import { bundledBlueprintsManifestVersion, installBundledBlueprints } from "../src/bundled-blueprints.js";
import { BUNDLED_BLUEPRINTS } from "../src/generated/bundled-blueprints.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

function readBlueprintFile(entry: (typeof BUNDLED_BLUEPRINTS)[number], filename: string): string {
  return new Map(entry.files).get(filename) ?? "";
}

/**
 * Whether `code` exports `name`, in either shape a blueprint's installed JavaScript can have: hand
 * written (`export class Foo`), or produced by the TypeScript build, which rewrites the declaration
 * to a `var` and gathers every export into one trailing `export { ... }` list.
 */
function exportsName(code: string, name: string): boolean {
  return new RegExp(`export\\s+(?:class|function|const|let|var)\\s+${name}\\b`, "u").test(code) ||
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, "su").test(code);
}

// A deployment to install into: the pool's real content bucket, and an in-memory stand-in for the
// BLUEPRINTS namespace, which the suites' Worker does not bind (see blueprints.test.ts).
function makeDeployment() {
  let kv = new Map<string, string>();
  let bindings = {
    BLUEPRINTS: {
      put: async (key: string, value: string) => { kv.set(key, value); },
    } as unknown as KVNamespace,
    BLUEPRINT_CONTENT: env.BLUEPRINT_CONTENT,
  };
  return {
    /** What the namespace holds, by key. */
    kv,

    /** Installs the bundled blueprints, every one of which has to succeed. */
    async install(): Promise<void> {
      expect(await installBundledBlueprints(bindings)).toHaveLength(BUNDLED_BLUEPRINTS.length);
    },

    /** The metadata published for a blueprint, as a reader of the namespace sees it. */
    published(blueprintId: string): BlueprintMetadata {
      return parseBlueprintKvRecord(kv.get(blueprintId)!).metadata;
    },
  };
}

async function storedKeys(blueprintId: string): Promise<string[]> {
  let listing = await env.BLUEPRINT_CONTENT.list({ prefix: `${blueprintId}/` });
  return listing.objects.map(object => object.key).toSorted();
}

async function storedContent(key: string): Promise<Uint8Array> {
  let object = await env.BLUEPRINT_CONTENT.get(key);
  if (object === null) throw new Error(`no content at ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

/** Content in the form blueprints took before releases were commits. */
async function snapshotContent(files: Iterable<[string, string]>): Promise<Uint8Array> {
  let doc = new Y.Doc();
  let map = doc.getMap<Y.Text>();
  for (let [path, text] of files) map.set(path, new Y.Text(text));
  let compressed = new Response(Y.encodeStateAsUpdateV2(doc) as BufferSource).body!
      .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

let workspaces = 0;

/**
 * Instantiates a blueprint in a fresh workspace, as AuthenticatedApi.newGadgetFromBlueprint() has
 * the Overseer do it, and returns the files of the gadget that results. The owner's user DO is
 * faked.
 */
async function instantiate(blueprintId: string, metadata: BlueprintMetadata)
    : Promise<Map<string, string>> {
  let stub = env.TEST_OVERSEER.getByName(`bundled-blueprints-${++workspaces}`);
  return await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let owner = {
      whoami: async () => ({ type: "user", id: "olive@example.com", name: "Olive" }),
      setGadgetLastActive: async () => {},
    };
    impl.ownerId = "owner-user-do";
    impl.users = { idFromString: (id: string) => id, get: () => owner };
    impl.markOutputsDirty = () => {};  // would sync the new gadget's format to the owner

    await instance.initializeFromBlueprint(blueprintId, metadata, metadata.output);
    let [gadget, ...others] = [...impl.storage.gadgets.list()];
    expect(others).toEqual([]);
    expect(gadget.output).toEqual(metadata.output);
    return await impl.gitStore.readCommitFiles(gadget.commitId);
  });
}

// Runs `fn` with the first bundled blueprint changed by `mutate`, then puts it back. The
// installer reads the generated module's entries, so changing one in place is how a test stands
// in for a deployment that ships something else.
async function withEntry(
    mutate: (entry: (typeof BUNDLED_BLUEPRINTS)[number]) => void, fn: () => Promise<void>)
    : Promise<void> {
  let entry = BUNDLED_BLUEPRINTS[0];
  let original = { ...entry };
  try {
    mutate(entry);
    await fn();
  } finally {
    Object.assign(entry, original);
  }
}

describe("bundled blueprints", () => {
  // The bucket outlives a test, and every test here installs under the same ids.
  beforeEach(async () => {
    for (let { blueprintId } of BUNDLED_BLUEPRINTS) await deleteBlueprintContent(env, blueprintId);
  });

  it("installs every manifest entry as an ordinary blueprint", async () => {
    let deployment = makeDeployment();
    await deployment.install();

    for (let entry of BUNDLED_BLUEPRINTS) {
      let raw = deployment.kv.get(entry.blueprintId);
      expect(raw, `${entry.blueprintId} metadata`).toBeDefined();

      let record = parseBlueprintKvRecord(raw!);
      // No owning user: these belong to the deployment, so the owner-anchored featured toggle
      // must not apply to them.
      expect(record.ownerId).toBeUndefined();
      // Presentation comes from the source manifest, not from whatever the blueprint was called in
      // the workspace it was exported from.
      expect(record.metadata.title).toBe(entry.title);
      expect(record.metadata.description).toBe(entry.description);
      expect(record.metadata.author).toEqual(entry.author);
      // The manifest's declaration is written into the installed blueprint, so from here on the
      // blueprint declares its own format like any other.
      expect(record.metadata.output).toEqual(entry.output);
      // ...and it survives the same validation an uploaded archive's would.
      expect(sanitizeBlueprintOutput(record.metadata.output)).toEqual(entry.output);
      // What that workspace did supply is the rest of the manifest.
      expect(record.metadata).toMatchObject({
        version: entry.version,
        created: new Date(entry.created),
        lastUpdated: new Date(entry.lastUpdated),
        bindings: entry.bindings,
      });

      // Content is a release pack of the entry's files, stored under the commit the metadata
      // names, which is where readBlueprintRelease() looks for it.
      let commitId = record.metadata.commitId!;
      let key = `${entry.blueprintId}/${commitId}`;
      expect(blueprintContentKey(entry.blueprintId, record.metadata)).toBe(key);
      expect(await storedKeys(entry.blueprintId)).toEqual([key]);
      let objects = await readReleasePack(await storedContent(key), commitId);
      expect(listReleaseFiles(objects, commitId)).toEqual(new Map(entry.files));
    }
  });

  it("installs blueprints that instantiate", async () => {
    let deployment = makeDeployment();
    await deployment.install();

    for (let entry of BUNDLED_BLUEPRINTS) {
      let files = await instantiate(entry.blueprintId, deployment.published(entry.blueprintId));
      expect(files, entry.blueprintId).toEqual(new Map(entry.files));
    }
  });

  // What gives a gadget made from an older install something in common with a later one: content
  // stored before releases were commits is read as the snapshot release of its files, and an
  // install of those same files is that same commit.
  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "installs the commit that the same files, stored as a snapshot, are read as", async () => {
    let entry = BUNDLED_BLUEPRINTS[0];
    let deployment = makeDeployment();
    await deployment.install();
    let installed = deployment.published(entry.blueprintId);

    let older = { ...installed };
    delete older.commitId;
    await env.BLUEPRINT_CONTENT.put(
        blueprintContentKey("older-install", older), await snapshotContent(entry.files));
    let release = await readBlueprintRelease(env, "older-install", older);
    expect(release.commitId).toBe(installed.commitId);
  });

  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "installs the same release again when the files have not changed", async () => {
    let { blueprintId } = BUNDLED_BLUEPRINTS[0];
    let deployment = makeDeployment();

    await deployment.install();
    let first = deployment.published(blueprintId);
    let record = deployment.kv.get(blueprintId);
    let key = `${blueprintId}/${first.commitId}`;
    let content = await storedContent(key);

    await deployment.install();
    expect(deployment.kv.get(blueprintId)).toBe(record);
    expect(await storedKeys(blueprintId)).toEqual([key]);
    expect(await storedContent(key)).toEqual(content);
  });

  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "installs changed files as a new release with no parent", async () => {
    let { blueprintId, files } = BUNDLED_BLUEPRINTS[0];
    let deployment = makeDeployment();
    await deployment.install();
    let before = deployment.published(blueprintId);

    let added: [string, string] = ["lib/added.js", "export const added = true;\n"];
    await withEntry(entry => { entry.files = [...files, added]; }, () => deployment.install());
    let after = deployment.published(blueprintId);

    expect(after.commitId).not.toBe(before.commitId);
    let objects = await readReleasePack(
        await storedContent(`${blueprintId}/${after.commitId}`), after.commitId!);
    expect(listReleaseFiles(objects, after.commitId!)).toEqual(new Map([...files, added]));
    // A bundled blueprint's releases are not chained to one another.
    let commit = objects.get(after.commitId!)!;
    expect(parseGitCommitRefs(commit.payload, after.commitId!).parents).toEqual([]);

    // The release it replaced stays where it was, for whoever read the metadata that names it
    // just before this install and goes on to instantiate from it.
    expect(await storedKeys(blueprintId)).toEqual(
        [`${blueprintId}/${before.commitId}`, `${blueprintId}/${after.commitId}`].toSorted());
    expect(await instantiate(blueprintId, before)).toEqual(new Map(files));
    expect(await instantiate(blueprintId, after)).toEqual(new Map([...files, added]));
  });

  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "installs the same release when only its metadata has changed", async () => {
    let { blueprintId } = BUNDLED_BLUEPRINTS[0];
    let deployment = makeDeployment();
    await deployment.install();
    let before = deployment.published(blueprintId);

    let lastUpdated = new Date(before.lastUpdated.valueOf() + 1000);
    await withEntry(entry => {
      entry.title += " (Beta)";
      entry.version += 1;
      entry.lastUpdated = lastUpdated.toISOString();
    }, () => deployment.install());

    expect(deployment.published(blueprintId)).toEqual({
      ...before, title: `${before.title} (Beta)`, version: before.version + 1, lastUpdated,
    });
    expect(await storedKeys(blueprintId)).toEqual([`${blueprintId}/${before.commitId}`]);
  });

  it("ships print layouts for every standard output format", () => {
    for (let entry of BUNDLED_BLUEPRINTS) {
      expect(readBlueprintFile(entry, "client.js"), entry.blueprintId)
        .toContain("@media print");
    }
  });

  it("renders document HTML and PDF exports without the editor chrome", () => {
    let entry = BUNDLED_BLUEPRINTS.find(blueprint => blueprint.blueprintId === "format.document")!;
    let client = readBlueprintFile(entry, "client.js");

    // The TypeScript build rewrites the source; what survives is the export-mode check itself.
    expect(client).toContain('["html", "pdf"].includes(');
    expect(client).toContain("gadgetExportFormatId");
    expect(client).toContain('document.documentElement.classList.add("document-export")');
    expect(client).toContain("app.replaceChildren(canvas)");
  });

  it("declares the intended export formats for every standard output format", () => {
    let expectedFormats: Record<string, string[]> = {
      "format.document": [
        'id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown"',
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.slides": [
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
        'id: "pptx", label: "PowerPoint", mode: "server", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"',
      ],
      "format.spreadsheet": [
        // `const` in the source; the TypeScript build emits `var`.
        'CSV_FORMAT_PREFIX = "csv:"',
        'id: "xlsx"',
        'label: "Excel Workbook"',
        'contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"',
        'mode: "server"',
        'contentType: "text/csv"',
      ],
    };

    for (let entry of BUNDLED_BLUEPRINTS) {
      let serverCode = readBlueprintFile(entry, "server.js");
      expect(exportsName(serverCode, "ExportHandler"),
        `${entry.blueprintId}: server.js exports ExportHandler`).toBe(true);
      for (let declaration of expectedFormats[entry.blueprintId] ?? []) {
        expect(serverCode, `${entry.blueprintId}: ${declaration}`).toContain(declaration);
      }
    }
  });

  // The export assertion above is only as good as its shape matching, and its two shapes come from
  // two different producers (a hand-written blueprint, and esbuild), so neither the suite nor a
  // reader can see them side by side anywhere else.
  it.each<[string, boolean]>([
    ["export class ExportHandler {}\n", true],
    ["var ExportHandler = class {\n};\nexport {\n  ExportHandler,\n  Gadget\n};\n", true],
    ["class ExportHandler {}\nnew ExportHandler();\n", false],
    ["export {\n  Gadget\n};\n// ExportHandler moved out.\n", false],
  ])("recognizes an ExportHandler export in %j", (code, expected) => {
    expect(exportsName(code, "ExportHandler")).toBe(expected);
  });

  // Skipped when the deployment bundles nothing, which BUNDLED_BLUEPRINTS_DIR makes a supported
  // configuration rather than a broken checkout.
  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "changes the manifest version when an entry's revision changes", () => {
    let entry = BUNDLED_BLUEPRINTS[0];
    let before = bundledBlueprintsManifestVersion();
    expect(before).toContain(entry.blueprintId);

    let original = entry.revision;
    try {
      entry.revision = original + 1;
      expect(bundledBlueprintsManifestVersion()).not.toBe(before);
    } finally {
      entry.revision = original;
    }
  });

  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "changes the manifest version when bundled source changes", () => {
    let entry = BUNDLED_BLUEPRINTS[0];
    let before = bundledBlueprintsManifestVersion();
    let original = entry.contentHash;
    try {
      entry.contentHash = `${original}-changed`;
      expect(bundledBlueprintsManifestVersion()).not.toBe(before);
    } finally {
      entry.contentHash = original;
    }
  });

  // Curated text is the input most likely to be edited -- it is the whole point of keeping it in a
  // text file -- and an edit that doesn't reach deployments which already installed would be
  // invisible: the build succeeds and the old wording stays put.
  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "changes the manifest version when curated presentation changes, with no revision bump", () => {
    let entry = BUNDLED_BLUEPRINTS[0];
    let before = bundledBlueprintsManifestVersion();

    for (let mutate of [
      () => { entry.description += " Now with more detail."; },
      () => { entry.title += " (Beta)"; },
      () => { entry.output = {...entry.output, noun: "Document"}; },
    ]) {
      let restore = {...entry};
      try {
        mutate();
        expect(bundledBlueprintsManifestVersion()).not.toBe(before);
        expect(entry.revision).toBe(restore.revision);
      } finally {
        Object.assign(entry, restore);
      }
    }

    expect(bundledBlueprintsManifestVersion()).toBe(before);
  });
});
