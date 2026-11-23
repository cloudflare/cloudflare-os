// Renders a new gatekeeper package from ../template: the files every gatekeeper has (`base`), then
// those of each choice made on the command line, which replace a base file of the same path. The
// template is written for an invented provider, "Acme Service", whose name is replaced throughout.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const TEMPLATE = join(import.meta.dirname, "..", "template");

/** How a user connects an account: an OAuth authorization-code grant, or a key they paste. */
export const AUTH_KINDS = ["oauth", "api-key"] as const;

/**
 * Where a gatekeeper's events come from: `app`, one webhook for the deployment, set up by hand or
 * in the provider's OAuth app; or `subscription`, webhooks the gatekeeper adds itself through the
 * provider's API, for each connection.
 */
export const HOOK_KINDS = ["app", "subscription"] as const;

/**
 * The optional parts a template block can name: `hooks` is a package with either kind of hooks,
 * `openapi` one that has the provider's OpenAPI description, and `openapi-copy` one that keeps it.
 */
const FEATURES = ["hooks", ...HOOK_KINDS.map(kind => `hooks-${kind}`), "openapi", "openapi-copy"];

/** The name of a package's copy of the description `text`, for what it is: JSON, or else YAML. */
export const openApiDocument = (text: string): string => `openapi.${text.trimStart().startsWith("{") ? "json" : "yaml"}`;
/**
 * A description's URL: `https`, one word to the shell the package's script runs in, and with no
 * user or password, which the package would otherwise commit.
 */
export const OPENAPI_URL = /^https:\/\/[^\s"'`$\\/?#@]+(?:[/?#][^\s"'`$\\]*)?$/;
/** What a URL that is not one is refused with. */
export const openApiUrlRefusal = (url: string): string =>
  `The description's URL must be an https one, with no user or password in it: ${url}`;
/** The operations the package's schema is generated for, as JSON Lines. */
export const OPENAPI_OPERATIONS = "openapi-operations.jsonl";
/** Where the generated schema goes. */
export const OPENAPI_SCHEMA_DIR = "src/openapi";

/** The provider's OpenAPI description, and what was chosen and generated from it. */
export type OpenApiOptions = {
  /** The description's text, which the package pins by hash. */
  document: string;
  /**
   * Where the description is published, an `https` URL, which the package's script then generates
   * from. Nothing is fetched here: the hash is the given text's, and a URL that serves another
   * document fails the script.
   */
  url?: string;
  /** Keeps a copy of the description in the package, which the script generates from instead of `url`. */
  copy?: boolean;
  /**
   * The chosen operations, as the lines `gatekeeper-openapi-schema --list` prints for them, and
   * the schema files generated for them, by path within `OPENAPI_SCHEMA_DIR`. Left out when no
   * operation is chosen yet: the package then has the description and an empty list.
   */
  generated?: { operations: string; schema: ReadonlyMap<string, string> };
};

/**
 * The decisions that shape everything else, in the order the write-gatekeeper skill takes them.
 * The first three need the operator's review before the rest is filled in.
 */
const FIRST_STOPS = ["session-api", "resources", "subresources", "origins", "identity", "actions"];

/** What to generate. */
export type ScaffoldOptions = {
  /** The vendor id: the package is `gatekeeper-<name>`, served under `/gatekeeper/<name>`. */
  name: string;
  /** The provider's name as users read it. Defaults to `name` with its words capitalized. */
  display?: string;
  auth: (typeof AUTH_KINDS)[number];
  /** Whether the gatekeeper pushes events to gadgets, and where from. */
  hooks?: (typeof HOOK_KINDS)[number];
  /** The provider's OpenAPI description, to call its API through a schema generated from it. */
  openapi?: OpenApiOptions;
};

/** One generated file: its text, or the target of a symlink. */
export type ScaffoldFile = { text: string } | { symlink: string };

/** The names a provider goes by in generated code. */
export type Names = {
  /** `pagerduty`: paths, the vendor id, storage namespaces. */
  name: string;
  /** `PagerDuty`: class and type names. */
  pascal: string;
  /** `PAGERDUTY`: constants and suggested binding names. */
  constant: string;
  /** `PagerDuty`: prose and UI text. */
  display: string;
};

/**
 * The names for a provider.
 * @throws Error for a `name` that is not 1-20 lowercase letters and digits starting with a letter,
 * or a `display` no identifier can be made from.
 */
export function namesFor({ name, display }: Pick<ScaffoldOptions, "name" | "display">): Names {
  // The release's install slug rule (`releaseShortName`): the name is a binding and a route.
  if (!/^[a-z][a-z0-9]{0,19}$/.test(name)) {
    throw new Error(`"${name}" is not a gatekeeper name: use 1-20 lowercase letters and digits, starting with a letter.`);
  }
  const shown = display ?? name[0].toUpperCase() + name.slice(1);
  if (!/^[A-Za-z0-9][A-Za-z0-9 .&+-]*$/.test(shown)) {
    throw new Error("The display name can have only letters, digits, spaces and . & + -, and starts with a letter or digit.");
  }
  const pascal = shown.split(/[^A-Za-z0-9]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join("");
  if (!/^[A-Z]/.test(pascal)) throw new Error(`No class name can be made from the display name "${shown}".`);
  // The template's types for what the provider sends are `WireItem` and `WireUser`.
  if (pascal === "Wire") throw new Error(`"${shown}" names its types as the template names its own: use another display name.`);
  return { name, pascal, constant: name.toUpperCase(), display: shown };
}

/** `text` with the template's provider renamed. */
function rename(text: string, names: Names): string {
  const spellings: Record<string, string> = {
    "Acme Service": names.display, Acme: names.pascal, ACME: names.constant, acme: names.name,
  };
  // One pass, so a name that itself contains "Acme" is not renamed again.
  return text.replace(/Acme Service|Acme|ACME|acme/g, spelling => spellings[spelling]);
}

/**
 * `text` with its conditional blocks resolved. A block is the lines between `// #if <feature>` and
 * `// #endif`, each alone on a line, with an optional `// #else`; blocks do not nest.
 * @throws Error for a block that is not closed, a directive outside one, or an unknown feature.
 */
export function resolveBlocks(text: string, features: ReadonlySet<string>): string {
  let keep: boolean | undefined;
  const lines = text.split("\n").filter(line => {
    const directive = /^\s*\/\/ #(if|else|endif)(?: ([a-z-]+))?$/.exec(line);
    if (!directive) return keep ?? true;
    const [, word, feature] = directive;
    if ((word === "if") !== (keep === undefined) || (word === "if") !== (feature !== undefined)) {
      throw new Error(`Misplaced template directive: ${line.trim()}`);
    }
    if (word === "if" && !FEATURES.includes(feature)) throw new Error(`Unknown template feature: ${feature}`);
    keep = word === "if" ? features.has(feature) : word === "else" ? !keep : undefined;
    return false;
  });
  if (keep !== undefined) throw new Error("A template block is not closed.");
  return lines.join("\n");
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/**
 * The files of a new gatekeeper package, by path within it.
 * @throws Error for options that name no valid package.
 */
export function scaffold(options: ScaffoldOptions): Map<string, ScaffoldFile> {
  const names = namesFor(options);
  if (!AUTH_KINDS.includes(options.auth)) throw new Error(`Unknown --auth "${options.auth}": use ${AUTH_KINDS.join(" or ")}.`);
  const files = new Map<string, ScaffoldFile>();
  const { openapi } = options;
  // The entrypoint would be `src/openapi.ts`, which `./openapi` finds before the generated schema.
  if (openapi && names.name === "openapi") throw new Error('"openapi" names the generated schema\'s directory: use another name.');
  const { hooks } = options;
  if (hooks !== undefined && !HOOK_KINDS.includes(hooks)) throw new Error(`Unknown --hooks "${hooks}": use ${HOOK_KINDS.join(" or ")}.`);
  // The shared hooks module, then the driver of the kind asked for.
  const hookLayers = hooks ? ["hooks", `hooks-${hooks}`] : [];
  const features = new Set([...hookLayers, ...(openapi ? ["openapi"] : []), ...(openapi?.copy ? ["openapi-copy"] : [])]);
  // A package whose schema is generated calls through it: that layer replaces the invented schema.
  const layers = ["base", `auth-${options.auth}`, ...hookLayers, ...(openapi?.generated ? ["openapi-schema"] : [])];
  for (const layer of layers) {
    const root = join(TEMPLATE, layer);
    for (const path of walk(root)) {
      const module = relative(root, path).replaceAll("\\", "/");
      // The entrypoint is `src/<name>.ts`, which would replace or shadow a module of that name.
      if (!/acme/i.test(module) && module.startsWith(`src/${names.name}.`)) {
        throw new Error(`"${names.name}" is a module every gatekeeper has (${module}): use another name.`);
      }
      files.set(rename(module, names), { text: rename(resolveBlocks(readFileSync(path, "utf8"), features), names) });
    }
  }
  // What an agent is shown is the declarations themselves, so the two cannot differ. Made here and
  // not kept in the template, where a checkout without symlinks would turn it into a file.
  files.set("src/types.txt", { symlink: "types.d.ts" });
  if (openapi) addOpenApi(files, openapi);
  return files;
}

/**
 * Adds the list of chosen operations, the schema generated for them, and the script that generates
 * it again. The script is the record of the description: it pins it by its hash, and names its
 * URL or the package's copy. A description can be megabytes, so with neither the package holds
 * none, and the script takes the file as its argument.
 * @throws Error for a URL that is not `https`, that names a user or password, or that a shell
 * would not take as one word.
 */
function addOpenApi(files: Map<string, ScaffoldFile>, { document, url, copy, generated }: OpenApiOptions): void {
  if (url !== undefined && !OPENAPI_URL.test(url)) throw new Error(openApiUrlRefusal(url));
  const edit = (path: string, change: (text: string) => string): void => {
    const file = files.get(path);
    if (!file || !("text" in file)) throw new Error(`The template has no ${path}.`);
    files.set(path, { text: change(file.text) });
  };
  const kept = openApiDocument(document);
  if (copy) {
    files.set(kept, { text: document });
    // The template's README names a JSON copy.
    edit("README.md", text => text.replaceAll("openapi.json", kept));
  }
  const source = copy ? `${kept} ` : url === undefined ? "" : `"${url}" `;
  files.set(OPENAPI_OPERATIONS, { text: generated?.operations ?? "" });
  for (const [path, text] of generated?.schema ?? []) files.set(`${OPENAPI_SCHEMA_DIR}/${path}`, { text });

  edit("package.json", text => {
    const parsed = JSON.parse(text) as { scripts: Record<string, string> };
    parsed.scripts["generate:openapi"] = `gatekeeper-openapi-schema ${source}--out ${OPENAPI_SCHEMA_DIR} ` +
      `--sha256 ${createHash("sha256").update(document).digest("hex")} --operations ${OPENAPI_OPERATIONS}`;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  });
}

/** Where a stop comes in review order: the `FIRST_STOPS` in turn, then the rest. */
const rank = ({ id }: { id: string }): number => (FIRST_STOPS.indexOf(id) + 1) || FIRST_STOPS.length + 1;

/** The `STOP(<id>)` marks in generated files: what is left for a person or agent to decide. */
export function stops(files: Map<string, ScaffoldFile>): { path: string; id: string }[] {
  const found = [...files].flatMap(([path, file]) => "text" in file
    ? [...file.text.matchAll(/\bSTOP\(([a-z-]+)\)/g)].map(match => ({ path, id: match[1] }))
    : []);
  return found.toSorted((a, b) => rank(a) - rank(b));
}
