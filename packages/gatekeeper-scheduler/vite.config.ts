import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import type { Plugin } from "vite";
import { defineConfig, loadEnv } from "vite-plus";
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

export default defineConfig(({ command, mode }) => {
  const errorReporting = loadEnv(mode, packageDirectory).VITE_FRONTEND_ERROR_REPORTING === "true";
  return {
    // Build-only: the single-file/inlining plugins rewrite modules in ways the test projects
    // below must not see -- they inherit this list, and viteSingleFile in particular mangles
    // test modules into a syntax error. Each project brings the plugins it actually needs.
    plugins:
      command === "build"
        ? [react(), tailwindcss(), tsconfigPaths(), viteSingleFile(), emitAppText(errorReporting)]
        : [],
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
        output: { entryFileNames: "gatekeeper-scheduler.js" },
      },
      watch: watch
        ? {
            exclude: ["**/node_modules/**", "**/dist-app/**", "**/.wrangler/**", "**/generated/**"],
          }
        : undefined,
    },
    // Two suites with incompatible runtimes: the Worker tests run inside workerd via
    // vitest-pool-workers, the SPA tests in jsdom. Each project brings its own plugins, so the
    // single-file build plugins above stay out of both. `vp test run` runs the pair.
    test: {
      projects: [
        {
          plugins: [
            capnwebValidate(),
            cloudflareTest({
              main: "./__tests__/worker.ts",
              miniflare: {
                compatibilityDate: "2026-02-02",
                compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
                durableObjects: {
                  SCHEDULE_DRIVER: { className: "ScheduleDriver", useSQLite: true },
                  SCHEDULER_SCOPE_TEST_PARENT: {
                    className: "SchedulerScopeTestParent",
                    useSQLite: true,
                  },
                  SCHEDULER_SCOPE_TEST_FACET: {
                    className: "SchedulerScopeTestFacet",
                    useSQLite: true,
                  },
                },
                serviceBindings: {
                  TEST_HOOKS: { name: kCurrentWorker, entrypoint: "TestHooks" },
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["__tests__/*.test.ts"],
          },
        },
        {
          plugins: [react(), tsconfigPaths()],
          test: {
            name: "app",
            environment: "jsdom",
            include: ["app/*.test.{ts,tsx}"],
          },
        },
      ],
    },
  };
});
