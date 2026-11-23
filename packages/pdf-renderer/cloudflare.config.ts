import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, textModules, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "pdf-renderer",
  entrypoint: ".wrangler/validate/src/worker.ts",
  observability: OBSERVABILITY,
  // Every page drawn of one open PDF counts against one invocation's CPU time, and a PDF the
  // default 30 seconds runs out on is downloaded and opened again. Five minutes is the most a
  // Worker may be given; a PDF that outruns that too is still opened again (README.md).
  limits: { cpuMs: 300_000 },
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: [
    // The PDFium build and its thunks are imported as compiled modules: workerd compiles
    // WebAssembly from nothing else.
    { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: false },
    // The build's licence notices, which ship with it.
    ...textModules(["**/*.txt"]),
  ],
} satisfies WranglerExtras;
