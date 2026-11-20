// Renders a new gatekeeper package from ../template: the files every gatekeeper has (`base`), then
// those of each choice made on the command line, which replace a base file of the same path. The
// template is written for an invented provider, "Acme Service", whose name is replaced throughout.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const TEMPLATE = join(import.meta.dirname, "..", "template");

/** How a user connects an account: an OAuth authorization-code grant, or a key they paste. */
export const AUTH_KINDS = ["oauth", "api-key"] as const;

/** The optional parts a template block can name. */
const FEATURES = ["hooks"];

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
  /** Whether the gatekeeper pushes events to gadgets, from a webhook the provider delivers to. */
  hooks?: boolean;
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
 * @throws Error for a `name` that is not lowercase words joined by single hyphens, or a `display`
 * no identifier can be made from.
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
  const features = new Set(options.hooks ? ["hooks"] : []);
  for (const layer of ["base", `auth-${options.auth}`, ...features]) {
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
  return files;
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
