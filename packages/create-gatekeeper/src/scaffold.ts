// Renders a new gatekeeper package from ../template: the files every gatekeeper has (`base`), then
// those of each choice made on the command line, which replace a base file of the same path. The
// template is written for an invented provider, "Acme Service", whose name is replaced throughout.

import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

const TEMPLATE = join(import.meta.dirname, "..", "template");

/** How a user connects an account. */
export const AUTH_KINDS = ["oauth"] as const;

/** What to generate. */
export type ScaffoldOptions = {
  /** The vendor id: the package is `gatekeeper-<name>`, served under `/gatekeeper/<name>`. */
  name: string;
  /** The provider's name as users read it. Defaults to `name` with its words capitalized. */
  display?: string;
  auth: (typeof AUTH_KINDS)[number];
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
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`"${name}" is not a gatekeeper name: use lowercase letters and digits, with single hyphens between words.`);
  }
  const shown = display ?? name.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
  if ([...shown].some(char => char < " " || "\"\\`$".includes(char))) throw new Error("The display name can't contain quotes, backslashes, backticks, \"$\" or control characters.");
  const pascal = shown.split(/[^A-Za-z0-9]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join("");
  if (!/^[A-Z]/.test(pascal)) throw new Error(`No class name can be made from the display name "${shown}".`);
  return { name, pascal, constant: name.replaceAll("-", "_").toUpperCase(), display: shown };
}

/** `text` with the template's provider renamed. */
function rename(text: string, names: Names): string {
  return text
    .replaceAll("Acme Service", names.display)
    .replaceAll("Acme", names.pascal)
    .replaceAll("ACME", names.constant)
    .replaceAll("acme", names.name);
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
  for (const layer of ["base", `auth-${options.auth}`]) {
    const root = join(TEMPLATE, layer);
    for (const path of walk(root)) {
      let file: ScaffoldFile;
      try {
        file = { symlink: rename(readlinkSync(path), names) };
      } catch {
        file = { text: rename(readFileSync(path, "utf8"), names) };
      }
      files.set(rename(relative(root, path), names).replaceAll("\\", "/"), file);
    }
  }
  return files;
}

/** The `STOP(<id>)` marks in generated files: what is left for a person or agent to decide. */
export function stops(files: Map<string, ScaffoldFile>): { path: string; id: string }[] {
  return [...files].flatMap(([path, file]) => "text" in file
    ? [...file.text.matchAll(/\bSTOP\(([a-z-]+)\)/g)].map(match => ({ path, id: match[1] }))
    : []);
}
