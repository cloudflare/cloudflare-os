import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/**
 * Names a frontend build, for a page to learn that a fresh load would get a newer one: the router
 * answers it on `/api/version` as `assets` (see VERSION_PATH in workshop-shared), and the build's
 * own code reads the same id as `import.meta.env.ASSETS_BUILD_ID`, undefined outside a build.
 *
 * The id is a hash of everything the build emits, so that building the same sources again names
 * the same build, and a deploy that changes nothing in the frontend tells no page of a new one. It
 * is known only once the bundle is, so the bundle carries a placeholder until then, the length of
 * the id, so that replacing it moves nothing a source map points at.
 *
 * Reached as `@gadgets/scripts/assets-build-id` from each frontend's `vite.config.ts`.
 */

/**
 * The file, at the root of the build's output, that holds the id. The router's copy of this name is
 * ASSETS_BUILD_ID_PATH in packages/router/src/index.ts (the router depends on no script).
 */
export const ASSETS_BUILD_ID_FILE = "assets-build-id";

const PLACEHOLDER = "__ASSETS_BUILD__";

/** The Vite plugin that names a build (see above). Only `vite build` applies it. */
export function assetsBuildId(): Plugin {
  return {
    name: "gadgets:assets-build-id",
    apply: "build",
    // After every other plugin's output is in the bundle the id hashes.
    enforce: "post",
    config: () => ({ define: { "import.meta.env.ASSETS_BUILD_ID": JSON.stringify(PLACEHOLDER) } }),
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      for (const fileName of Object.keys(bundle).toSorted()) {
        const output = bundle[fileName]!;
        hash.update(fileName).update("\0")
            .update(output.type === "chunk" ? output.code : output.source).update("\0");
      }
      const id = hash.digest("hex").slice(0, PLACEHOLDER.length);
      let baked = false;
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk" || !output.code.includes(PLACEHOLDER)) continue;
        output.code = output.code.replaceAll(PLACEHOLDER, id);
        baked = true;
      }
      // A build that never reads its id could never tell that it is not the latest.
      if (!baked) this.error("No code in the build reads import.meta.env.ASSETS_BUILD_ID.");
      this.emitFile({ type: "asset", fileName: ASSETS_BUILD_ID_FILE, source: id });
    },
  };
}
