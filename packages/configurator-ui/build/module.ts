// typescript6 = npm:typescript@6.0.3. The transpileModule compiler API this relies on is not shipped
// by the TypeScript 7 package (it only exports version metadata); type-checking uses the workspace
// "typescript" (7.x, tsgo), build-time transpilers stay on the JS-based 6.x line.
import ts from "typescript6";
import { CONFIGURATOR_MODULE_GLOBAL } from "../src/runtime/moduleGlobal.ts";

/** One configurator module, ready to embed in its frame. */
export type ConfiguratorModule = {
  /** The script defining the module for the runtime, ending in its `sourceURL` comment. */
  script: string;
  /** The script's source map, built only for frontend error reporting. */
  sourceMap: string | null;
};

/** How to transpile a {@link ConfiguratorModule}. */
export type ConfiguratorModuleOptions = {
  /** The `.tsx` file's name, which diagnostics and the source map refer to. */
  fileName: string;
  /** Where the module and its original source are named in stack traces. */
  sourceBase: string;
  /** Whether the deployment collects frontend errors, which adds a source map. */
  frontendReporting: boolean;
};

const blankCode = (text: string): string => text.replace(/[^\r\n]/g, " ");

/**
 * The transpiled module as a function body. Imports from `@gadgets/configurator-ui` are dropped,
 * since the runtime provides those names as globals, and the default export becomes the body's
 * `return`. Blanked rather than deleted, so every position the source map records stays put.
 */
const toFunctionBody = (outputText: string): string => outputText
  .replace(/^import\s+[^;]+from\s+["']@gadgets\/configurator-ui["'];\s*\n?/gm, blankCode)
  .replace(/^import\s+type\s+[^;]+;\s*\n?/gm, blankCode)
  .replace(/^export\s+{};\s*\n?/gm, blankCode)
  .replace(/^\/\/# sourceMappingURL=.*$/gm, blankCode)
  .replace(/export[\t ]+default[\t ]+/, match => "return".padEnd(match.length));

/**
 * Every non-ASCII UTF-16 unit as a `\u` escape, which reads the same in strings, templates, regular
 * expressions, comments and identifiers. One such character would make V8 store the whole frame at
 * two bytes per character (see `runtime.ts`). Each escape shifts the rest of its line by five
 * columns, so a mapped column after it is off by that much; positions are otherwise kept.
 */
const asciiOnly = (code: string): string => code.replace(/[\u0080-\uffff]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

const MODULE_SCRIPT_PREFIX = `globalThis.${CONFIGURATOR_MODULE_GLOBAL} = function () {\n`;
/** Lines {@link MODULE_SCRIPT_PREFIX} puts before the module's first line. */
const MODULE_SCRIPT_LINE_OFFSET = 1;

/**
 * Compiles one configurator `.tsx` on its own, as the frame runs it: JSX through the runtime's
 * `h`, and nothing imported but the runtime's components and types. Throws on a syntax error or
 * on any import the frame could not resolve.
 */
export const transpileConfiguratorModule = (
  source: string,
  { fileName, sourceBase, frontendReporting }: ConfiguratorModuleOptions,
): ConfiguratorModule => {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment",
      removeComments: false,
      sourceMap: frontendReporting,
      inlineSources: frontendReporting,
    },
    fileName,
    reportDiagnostics: true,
  });
  if (output.diagnostics?.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(output.diagnostics, {
      getCanonicalFileName: name => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }));
  }

  const body = asciiOnly(toFunctionBody(output.outputText));
  if (/^\s*import\s/m.test(body) || /^\s*export\s+.*\sfrom\s/m.test(body)) {
    throw new Error(
      `${fileName} generated unsupported import or re-export statements. ` +
      `Configurator UI modules must be self-contained after generation.`);
  }

  const moduleName = fileName.replace(/\.tsx$/, "");
  const sourceUrl = `${sourceBase}/${moduleName}.js`;
  const mapped = frontendReporting && output.sourceMapText !== undefined;
  const trailer = mapped
    ? `//# sourceURL=${sourceUrl}\n//# sourceMappingURL=${sourceUrl}.map`
    : `//# sourceURL=${sourceUrl}`;
  const script = `${MODULE_SCRIPT_PREFIX}${body}\n};\n${trailer}`;
  if (!mapped) return { script, sourceMap: null };

  const sourceMap = JSON.parse(output.sourceMapText!);
  sourceMap.file = `${moduleName}.js`;
  sourceMap.sources = [`${sourceBase}/${fileName}`];
  sourceMap.mappings = ";".repeat(MODULE_SCRIPT_LINE_OFFSET) + sourceMap.mappings;
  return { script, sourceMap: JSON.stringify(sourceMap) };
};
