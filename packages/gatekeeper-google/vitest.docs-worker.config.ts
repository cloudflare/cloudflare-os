import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import type { Plugin } from "vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

// Wrangler ships `*.txt` imports as Text modules, but this pool is driven from inline miniflare
// settings, where Vite would resolve an agent type `.txt`, a symlink to its `.d.ts`, to that file
// and send it through the TypeScript pipeline, leaving the import `undefined`. Resolving by the
// import path, as wrangler does, keeps Vite from following the link.
const textModules: Plugin = {
  name: "text-modules",
  enforce: "pre",
  resolveId(source, importer) {
    if (source.endsWith(".txt") && importer !== undefined) {
      return path.resolve(path.dirname(importer), source);
    }
  },
  load(id) {
    if (id.endsWith(".txt")) {
      return `export default ${JSON.stringify(readFileSync(id, "utf-8"))};`;
    }
  },
};

/**
 * Workerd coverage for nested Drive sessions, Sheets and Slides sessions, the Google Doc and
 * Google Calendar Durable Objects, and creating files.
 */
export default defineConfig({
  plugins: [
    textModules,
    // The tests' program, which holds the PDF renderer's entrypoint the pool's Worker exports: a
    // class outside the program is not given its validators, and refuses to be loaded without.
    capnwebValidate({ tsconfig: "tsconfig.test.json" }),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        // The isolate has none of the environment of the process that runs the tests, and its
        // `process.env` holds the worker's text bindings: the one variable a test file reads
        // (`__tests__/wider-run.ts`) is handed over as one, empty where it is not set.
        bindings: { GOOGLE_DOCS_WIDER_TESTS: process.env.GOOGLE_DOCS_WIDER_TESTS ?? "" },
        // The pool takes its module rules from here, not from the Worker's configuration, and the
        // PDF renderer's PDFium build is imported as a compiled WebAssembly module.
        modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
        // The PDF renderer, which the pool's Worker exports beside the gatekeeper.
        serviceBindings: {
          PDF_RENDERER: { name: kCurrentWorker, entrypoint: "PdfRenderer" },
        },
        // Facets and loopback namespaces need test-only registrations in this test pool.
        durableObjects: {
          CALENDAR_TEST_HOOKS: { className: "CalendarTestHooks", useSQLite: true },
          DOC_COPY_HOST: { className: "DocCopyHost", useSQLite: true },
          DOC_STORE_HOST: { className: "DocStoreHost", useSQLite: true },
          GOOGLE_CALENDAR_GATEKEEPER: { className: "GoogleCalendarGatekeeperImpl", useSQLite: true },
          GOOGLE_DOC_GATEKEEPER: { className: "GoogleDocGatekeeperImpl", useSQLite: true },
          GOOGLE_DRIVE_GATEKEEPER: { className: "GoogleDriveGatekeeperImpl", useSQLite: true },
          GOOGLE_DRIVE_GATEKEEPER_READ_ONLY: { className: "ReadOnlyDriveGatekeeper", useSQLite: true },
          GOOGLE_SHEETS_GATEKEEPER: { className: "GoogleSheetsGatekeeperImpl", useSQLite: true },
          GOOGLE_SLIDES_GATEKEEPER: { className: "GoogleSlidesGatekeeperImpl", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    // Four times as long for the wider run (`__tests__/wider-run.ts`), as in the Node project.
    testTimeout: 15_000 * (process.env.GOOGLE_DOCS_WIDER_TESTS ? 4 : 1),
    include: [
      "__tests__/workerd/calendar-actions.test.ts",
      "__tests__/workerd/doc-actions.test.ts",
      "__tests__/workerd/docs-copy.test.ts",
      "__tests__/workerd/docs-piece.test.ts",
      "__tests__/workerd/docs-store.test.ts",
      "__tests__/workerd/drive-changes.test.ts",
      "__tests__/workerd/drive-editors.test.ts",
      "__tests__/workerd/google-doc-actions.test.ts",
      "__tests__/workerd/google-file-creation.test.ts",
      "__tests__/workerd/native-sessions.test.ts",
      "__tests__/workerd/sheets-actions.test.ts",
      "__tests__/workerd/sheets-session.test.ts",
      "__tests__/workerd/slides-actions.test.ts",
      "__tests__/workerd/slides-session.test.ts",
    ],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
    // Vitest's module cache hands `.txt` modules back under ids `textModules` cannot read, so
    // every run after the first would fail.
    fsModuleCache: false,
  },
});
