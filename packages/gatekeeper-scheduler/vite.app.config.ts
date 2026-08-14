import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import tsconfigPaths from "vite-tsconfig-paths";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Minification is the only thing that differs between the watch build and the one-shot build, so
// it is the only reason their `src/generated/app.txt` bytes differ -- and that difference is what
// makes `pnpm dev-server` rebuild the app twice and restart Wrangler mid-startup: the cached
// one-shot build lands first, then the watcher's initial build overwrites it. `build:app:dev` sets
// this so the pre-flight produces exactly what the watcher will, letting the write be skipped.
const unminified = watch || process.env.GATEKEEPER_APP_UNMINIFIED === "true";

function emitAppText(errorReporting: boolean): Plugin {
  return {
    name: "emit-app-text",
    closeBundle() {
      const builtHtml = resolve(packageDirectory, "dist-app", "app", "index.html");
      const html = readFileSync(builtHtml, "utf8").replace(
        /(<script type="module"[^>]*>)([\s\S]*?)(<\/script>)/,
        "$1$2\n//# sourceURL=app:///gatekeeper/scheduler/gatekeeper-scheduler.js\n$3",
      );
      const script = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/)?.[1];
      if (script && errorReporting) {
        writeFileSync(
          resolve(packageDirectory, "dist-app", "gatekeeper-scheduler.js"),
          `${script}\n//# sourceMappingURL=gatekeeper-scheduler.js.map\n`,
        );
      }
      const output = resolve(packageDirectory, "src", "generated", "app.txt");
      const contents =
        "<!-- Generated from packages/gatekeeper-scheduler/app. Do not edit. -->\n" + html;
      if (existsSync(output) && readFileSync(output, "utf8") === contents) return;
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, contents);
    },
  };
}

export default defineConfig(({ mode }) => {
  const errorReporting = loadEnv(mode, packageDirectory).VITE_FRONTEND_ERROR_REPORTING === "true";
  return {
    plugins: [
      react(),
      tailwindcss(),
      tsconfigPaths(),
      viteSingleFile(),
      emitAppText(errorReporting),
    ],
    build: {
      outDir: "dist-app",
      emptyOutDir: true,
      minify: unminified ? false : "terser",
      terserOptions: { compress: { passes: 2 }, format: { comments: false } },
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      sourcemap: errorReporting ? "hidden" : false,
      rollupOptions: {
        input: "app/index.html",
        output: { entryFileNames: "gatekeeper-scheduler.js" },
      },
      watch: watch
        ? {
            exclude: ["**/node_modules/**", "**/dist-app/**", "**/.wrangler/**", "**/generated/**"],
          }
        : undefined,
    },
  };
});
