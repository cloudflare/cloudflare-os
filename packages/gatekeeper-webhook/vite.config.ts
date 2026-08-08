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

function emitAppText(errorReporting: boolean): Plugin {
  return {
    name: "emit-app-text",
    closeBundle() {
      const builtHtml = resolve(packageDirectory, "dist-app", "app", "index.html");
      const html = readFileSync(builtHtml, "utf8").replace(
        /(<script type="module"[^>]*>)([\s\S]*?)(<\/script>)/,
        "$1$2\n//# sourceURL=app:///gatekeeper/webhook/gatekeeper-webhook.js\n$3",
      );
      const script = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/)?.[1];
      if (script && errorReporting) {
        writeFileSync(
          resolve(packageDirectory, "dist-app", "gatekeeper-webhook.js"),
          `${script}\n//# sourceMappingURL=gatekeeper-webhook.js.map\n`,
        );
      }
      const output = resolve(packageDirectory, "src", "generated", "app.txt");
      const contents =
        "<!-- Generated from packages/gatekeeper-webhook/app. Do not edit. -->\n" + html;
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
      minify: watch ? false : "terser",
      terserOptions: { compress: { passes: 2 }, format: { comments: false } },
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      sourcemap: errorReporting ? "hidden" : false,
      rollupOptions: {
        input: "app/index.html",
        output: { entryFileNames: "gatekeeper-webhook.js" },
      },
      watch: watch
        ? {
            exclude: ["**/node_modules/**", "**/dist-app/**", "**/.wrangler/**", "**/generated/**"],
          }
        : undefined,
    },
  };
});
