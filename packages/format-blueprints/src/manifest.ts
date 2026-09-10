// Manifest validation shared by the format-blueprint importer and generator. Keeping one parser
// ensures an import cannot replace valid source with a manifest the following build would reject.

// Icons a blueprint may declare. Duplicated from the shared API's OUTPUT_ICONS because these
// scripts run before (and without) a TypeScript build; runtime validates against the real list.
const OUTPUT_ICONS = ["fileText", "gridNine", "presentation", "appWindow", "flowArrow",
    "kanban", "chartBar", "table", "notebook", "listChecks"];

// Must match isReservedBlueprintKey() in src/blueprint-archive.ts.
const RESERVED_BLUEPRINT_KEYS = new Set([".featured", ".adminConfig"]);

export type FormatBlueprintManifest = {
  blueprintId: string;
  title: string;
  description: string;
  output: {id: string; noun: string; plural: string; icon: string};
  author: {type: "user"; name: string; id: string};
  revision: number;
  created: string;
  version: number;
  lastUpdated: string;
  bindings: Record<string, unknown>;
};

export type FormatBlueprintPresentation = Omit<FormatBlueprintManifest,
    "created" | "version" | "lastUpdated" | "bindings">;

export function parseFormatBlueprintPresentation(
  label: string,
  raw: string,
): FormatBlueprintPresentation {
  return parsePresentation(label, JSON.parse(raw), []);
}

export function parseFormatBlueprintManifest(
  name: string,
  raw: string,
): FormatBlueprintManifest {
  let label = `${name}/blueprint.json`;
  let bad = (message: string): never => { throw new Error(`${label}: ${message}`); };
  let parsed = JSON.parse(raw);
  let presentation = parsePresentation(label, parsed,
      ["created", "version", "lastUpdated", "bindings"]);
  let {created, version, lastUpdated, bindings} = parsed;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    bad("version must be a positive integer");
  }
  for (let [key, value] of [["created", created], ["lastUpdated", lastUpdated]] as const) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      bad(`${key} must be an ISO date string`);
    }
  }
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) {
    bad("bindings must be an object");
  }

  return {
    ...presentation,
    created: created as string,
    version: version as number,
    lastUpdated: lastUpdated as string,
    bindings: bindings as Record<string, unknown>,
  };
}

function parsePresentation(
  label: string,
  parsed: Record<string, unknown>,
  allowedExtra: string[],
): FormatBlueprintPresentation {
  let bad = (message: string): never => { throw new Error(`${label}: ${message}`); };
  let {
    blueprintId, title, description, output, author, revision, $comment, ...rest
  } = parsed;
  let unknown = Object.keys(rest).filter(key => !allowedExtra.includes(key));
  if (unknown.length > 0) bad(`unknown keys: ${unknown.join(", ")}`);

  let string = (value: unknown, what: string): string => {
    if (typeof value !== "string" || value.trim() === "") bad(`${what} must be a non-empty string`);
    return value as string;
  };

  if (typeof blueprintId !== "string" || !/^[a-zA-Z0-9._-]+$/.test(blueprintId)) {
    bad("blueprintId must be a non-empty [a-zA-Z0-9._-] string");
  }
  if (RESERVED_BLUEPRINT_KEYS.has(blueprintId as string)) {
    bad(`blueprintId ${blueprintId} is reserved`);
  }
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    bad("revision must be a positive integer");
  }
  if (typeof output !== "object" || output === null) bad("output is required");
  let { id, noun, plural, icon, ...outputRest } = output as Record<string, unknown>;
  if (Object.keys(outputRest).length > 0) {
    bad(`unknown output keys: ${Object.keys(outputRest).join(", ")}`);
  }
  if (!OUTPUT_ICONS.includes(icon as string)) {
    bad(`output.icon must be one of: ${OUTPUT_ICONS.join(", ")}`);
  }
  if (typeof author !== "object" || author === null) bad("author is required");
  let {
    type: authorType, name: authorName, id: authorId, ...authorRest
  } = author as Record<string, unknown>;
  if (Object.keys(authorRest).length > 0) {
    bad(`unknown author keys: ${Object.keys(authorRest).join(", ")}`);
  }
  if (authorType !== undefined && authorType !== "user") bad(`author.type must be "user"`);

  return {
    blueprintId: blueprintId as string,
    title: string(title, "title"),
    description: string(description, "description"),
    output: {
      id: string(id, "output.id"),
      noun: string(noun, "output.noun"),
      plural: string(plural, "output.plural"),
      icon: icon as string,
    },
    author: {
      type: "user",
      name: string(authorName, "author.name"),
      id: string(authorId, "author.id"),
    },
    revision: revision as number,
  };
}
