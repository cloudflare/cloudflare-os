import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, textModules, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "pdf-renderer",
  entrypoint: ".wrangler/validate/src/worker.ts",
  observability: OBSERVABILITY,
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
