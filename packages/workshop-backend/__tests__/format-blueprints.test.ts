import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { parseBlueprintArchive, parseBlueprintKvRecord, sanitizeBlueprintOutput } from "../src/blueprint-archive.js";
import { formatBlueprintsManifestVersion, installFormatBlueprints } from "../src/format-blueprints.js";
import { FORMAT_BLUEPRINTS } from "../src/generated/format-blueprints.js";

async function readBlueprintFile(
  entry: (typeof FORMAT_BLUEPRINTS)[number],
  filename: string,
): Promise<string> {
  let archive = new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!;
  let {content} = await parseBlueprintArchive(archive);
  let decompressed = content.pipeThrough(new DecompressionStream("gzip"));
  let update = new Uint8Array(await new Response(decompressed).arrayBuffer());
  let doc = new Y.Doc();
  Y.applyUpdateV2(doc, update);
  return doc.getMap<Y.Text>().get(filename)?.toString() ?? "";
}

// Minimal in-memory stand-ins for the two bindings the installer writes to. They record what was
// written so the test can assert on the installed blueprint the way a reader would see it.
function makeEnv() {
  let kv = new Map<string, string>();
  let r2 = new Map<string, Uint8Array>();
  return {
    kv,
    r2,
    env: {
      BLUEPRINTS: {
        put: async (key: string, value: string) => { kv.set(key, value); },
      },
      BLUEPRINT_CONTENT: {
        // Deliberately strict: real R2 rejects a stream of unknown length, so accepting one here
        // would hide exactly the bug this stands in for.
        put: async (key: string, value: unknown) => {
          if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
            throw new TypeError(
                "Provided readable stream must have a known length " +
                "(request/response body or readable half of FixedLengthStream)");
          }
          r2.set(key, new Uint8Array(ArrayBuffer.isView(value)
              ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
              : value));
        },
      },
    } as unknown as Pick<Cloudflare.Env, "BLUEPRINTS" | "BLUEPRINT_CONTENT">,
  };
}

describe("bundled format blueprints", () => {
  it("installs every manifest entry as an ordinary blueprint", async () => {
    let {kv, r2, env} = makeEnv();

    let installed = await installFormatBlueprints(env);

    expect(installed).toHaveLength(FORMAT_BLUEPRINTS.length);
    for (let entry of FORMAT_BLUEPRINTS) {
      let raw = kv.get(entry.blueprintId);
      expect(raw, `${entry.blueprintId} metadata`).toBeDefined();

      let record = parseBlueprintKvRecord(raw!);
      // No owning user: these belong to the deployment, so the owner-anchored featured toggle
      // must not apply to them.
      expect(record.ownerId).toBeUndefined();
      // Presentation comes from the sidecar, not from whatever the archive was called in the
      // workspace it was exported from.
      expect(record.metadata.title).toBe(entry.title);
      expect(record.metadata.description).toBe(entry.description);
      expect(record.metadata.author).toEqual(entry.author);
      // The sidecar's declaration is written into the installed blueprint, so from here on the
      // blueprint declares its own format like any other.
      expect(record.metadata.output).toEqual(entry.output);
      // ...and it survives the same validation an uploaded archive's would.
      expect(sanitizeBlueprintOutput(record.metadata.output)).toEqual(entry.output);

      // Content lands where readBlueprintContent() looks for it.
      let content = r2.get(`${entry.blueprintId}/${record.metadata.version}`);
      expect(content, `${entry.blueprintId} content`).toBeDefined();
      expect(content!.byteLength).toBeGreaterThan(0);
    }
  });

  it("ships print layouts for every standard output format", async () => {
    for (let entry of FORMAT_BLUEPRINTS) {
      expect(await readBlueprintFile(entry, "client.js"), entry.blueprintId)
        .toContain("@media print");
    }
  });

  it("renders document HTML and PDF exports without the editor chrome", async () => {
    let entry = FORMAT_BLUEPRINTS.find(blueprint => blueprint.blueprintId === "format.document")!;
    let client = await readBlueprintFile(entry, "client.js");

    expect(client).toContain('["html", "pdf"].includes(globalThis.gadgetExportFormatId)');
    expect(client).toContain('document.documentElement.classList.add("document-export")');
    expect(client).toContain("app.replaceChildren(canvas)");
  });

  it("declares the intended export formats for every standard output format", async () => {
    let expectedFormats: Record<string, string[]> = {
      "format.document": [
        'id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown"',
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.slides": [
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.spreadsheet": [
        'const CSV_FORMAT_PREFIX = "csv:"',
        'mode: "server"',
        'contentType: "text/csv"',
      ],
    };

    for (let entry of FORMAT_BLUEPRINTS) {
      let serverCode = await readBlueprintFile(entry, "server.js");
      expect(serverCode, entry.blueprintId).toContain("export class ExportHandler");
      for (let declaration of expectedFormats[entry.blueprintId] ?? []) {
        expect(serverCode, `${entry.blueprintId}: ${declaration}`).toContain(declaration);
      }
    }
  });

  // Skipped when the deployment bundles nothing, which FORMAT_BLUEPRINTS_DIR makes a supported
  // configuration rather than a broken checkout.
  it.skipIf(FORMAT_BLUEPRINTS.length === 0)(
      "changes the manifest version when an entry's revision changes", () => {
    let entry = FORMAT_BLUEPRINTS[0];
    let before = formatBlueprintsManifestVersion();
    expect(before).toContain(entry.blueprintId);

    let original = entry.revision;
    try {
      entry.revision = original + 1;
      expect(formatBlueprintsManifestVersion()).not.toBe(before);
    } finally {
      entry.revision = original;
    }
  });

  // Curated text is the input most likely to be edited -- it is the whole point of keeping it in a
  // text file -- and an edit that doesn't reach deployments which already installed would be
  // invisible: the build succeeds and the old wording stays put.
  it.skipIf(FORMAT_BLUEPRINTS.length === 0)(
      "changes the manifest version when curated presentation changes, with no revision bump", () => {
    let entry = FORMAT_BLUEPRINTS[0];
    let before = formatBlueprintsManifestVersion();

    for (let mutate of [
      () => { entry.description += " Now with more detail."; },
      () => { entry.title += " (Beta)"; },
      () => { entry.output = {...entry.output, noun: "Document"}; },
    ]) {
      let restore = {...entry};
      try {
        mutate();
        expect(formatBlueprintsManifestVersion()).not.toBe(before);
        expect(entry.revision).toBe(restore.revision);
      } finally {
        Object.assign(entry, restore);
      }
    }

    expect(formatBlueprintsManifestVersion()).toBe(before);
  });
});
