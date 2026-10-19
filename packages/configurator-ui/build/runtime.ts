import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import capnwebValidate from "capnweb-validate/esbuild";
import { build } from "esbuild";
import { PREACT_ALIASES } from "./aliases.ts";
import { sourceTrailer } from "./sourceTrailer.ts";

const packageDir = join(import.meta.dirname, "..");
const runtimeDir = join(packageDir, "src", "runtime");

/** The sandbox runtime every generated configurator frame embeds. */
export type ConfiguratorRuntime = {
  /** The runtime as one classic script, ending in its `sourceURL` comment. */
  script: string;
  /** The script's source map, built only for frontend error reporting. */
  sourceMap: string | null;
  /** Tailwind's base layer, Kumo's tokens, and the utilities `script` references, minified. */
  css: string;
};

/** How to build a {@link ConfiguratorRuntime}. */
export type ConfiguratorRuntimeOptions = {
  /** Whether the deployment collects frontend errors, which adds reporting and a source map. */
  frontendReporting: boolean;
  /** What the script is named in stack traces; its map is named the same plus `.map`. */
  sourceUrl: string;
};

const bundleScript = async ({ frontendReporting, sourceUrl }: ConfiguratorRuntimeOptions) => {
  const result = await build({
    entryPoints: [join(runtimeDir, "main.tsx")],
    // Aliased imports resolve from here, where `preact` is a dependency, rather than beside the
    // Kumo and Base UI files that import `react`.
    absWorkingDir: packageDir,
    outfile: "configurator-runtime.js",
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    alias: PREACT_ALIASES,
    // Generates the runtime validators behind the frame's `@validateRpc()`.
    plugins: [capnwebValidate({ tsconfig: join(packageDir, "tsconfig.validate.json"), cwd: packageDir })],
    define: {
      __FRONTEND_REPORTING__: String(frontendReporting),
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    minify: true,
    legalComments: "none",
    // A single character beyond Latin-1 would make V8 store the whole frame document, in the
    // Workshop page and in the gatekeeper Worker, at two bytes per character.
    charset: "ascii",
    sourcemap: frontendReporting ? "external" : false,
    logLevel: "silent",
  });
  const script = result.outputFiles.find(file => file.path.endsWith(".js"));
  const map = result.outputFiles.find(file => file.path.endsWith(".js.map"));
  if (!script) throw new Error("The configurator runtime bundle produced no script.");
  return {
    script: `${script.text.trimEnd()}\n${sourceTrailer(sourceUrl, map !== undefined)}`,
    sourceMap: map?.text ?? null,
  };
};

/** Compiles `styles.css` with the bundled script as its only source of class names. */
const compileStyles = async (script: string): Promise<string> => {
  const stylesPath = join(runtimeDir, "styles.css");
  const compiler = await compile(await readFile(stylesPath, "utf8"), {
    base: runtimeDir,
    from: stylesPath,
    onDependency: () => {},
  });
  const candidates = new Scanner({ sources: [] }).scanFiles([{ content: script, extension: "js" }]);
  return optimize(compiler.build(candidates), { minify: true }).code;
};

/**
 * Bundles the runtime (`src/runtime/main.tsx`) with Preact standing in for React, and compiles its
 * styles. The same for every configurator a gatekeeper builds, so build it once per run.
 */
export const buildConfiguratorRuntime = async (
  options: ConfiguratorRuntimeOptions,
): Promise<ConfiguratorRuntime> => {
  const { script, sourceMap } = await bundleScript(options);
  return { script, sourceMap, css: await compileStyles(script) };
};
