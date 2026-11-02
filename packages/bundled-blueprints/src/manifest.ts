// Manifest validation shared by the bundled-blueprint importer and generator. Keeping one parser
// ensures an import cannot replace valid source with a manifest the following build would reject.

// Icons a blueprint may declare. Duplicated from the shared API's OUTPUT_ICONS because these
// scripts run before (and without) a TypeScript build; runtime validates against the real list.
const OUTPUT_ICONS = ["fileText", "gridNine", "presentation", "appWindow", "flowArrow",
    "kanban", "chartBar", "table", "notebook", "listChecks"];

// Must match isReservedBlueprintKey() in workshop-backend's src/storage-schema/blueprints-kv.ts.
const RESERVED_BLUEPRINT_KEYS = new Set([".featured", ".adminConfig"]);

// Roles a blueprint may publish its workspaces at. Duplicated from the shared API's
// CollaboratorRole for the same reason as OUTPUT_ICONS.
const PUBLICATION_ROLES = ["use", "build"];

// Bounds on a declared importMethods list; each name is called as a gadget method.
const MAX_IMPORT_METHODS = 32;
const IMPORT_METHOD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

export type BundledBlueprintManifest = {
  blueprintId: string;
  title: string;
  description: string;
  output: {id: string; noun: string; plural: string; icon: string};
  author: {type: "user"; name: string; id: string};
  revision: number;
  /**
   * Present when a workspace created from this blueprint is published to everyone signed in by
   * default, at this role. Only the deployment's bundled blueprints are trusted to declare it.
   */
  publication?: "use" | "build";
  /**
   * The gadget methods a space sync may call on a workspace created from this blueprint (see
   * docs/space-sync.md). Absent when a space sync may call none.
   */
  importMethods?: string[];
  created: string;
  version: number;
  lastUpdated: string;
  bindings: Record<string, unknown>;
};

export type BundledBlueprintPresentation = Omit<BundledBlueprintManifest,
    "created" | "version" | "lastUpdated" | "bindings">;

/**
 * The part of a manifest that comes from the Workshop the blueprint was exported from rather than
 * from whoever curates it: what a `.gadget` archive's metadata holds beside its presentation.
 */
export type BundledBlueprintProvenance = Pick<BundledBlueprintManifest,
    "created" | "version" | "lastUpdated" | "bindings">;

export function parseBundledBlueprintPresentation(
  label: string,
  raw: string,
): BundledBlueprintPresentation {
  return parsePresentation(label, JSON.parse(raw), []);
}

export function parseBundledBlueprintManifest(
  name: string,
  raw: string,
): BundledBlueprintManifest {
  let label = `${name}/blueprint.json`;
  let parsed = JSON.parse(raw);
  return {
    ...parsePresentation(label, parsed, ["created", "version", "lastUpdated", "bindings"]),
    ...parseBundledBlueprintProvenance(label, parsed),
  };
}

/**
 * Validates the provenance fields of `parsed`, a manifest or the metadata of a `.gadget` archive,
 * and returns them alone. Whatever else `parsed` holds is the caller's to judge.
 */
export function parseBundledBlueprintProvenance(
  label: string,
  parsed: Record<string, unknown>,
): BundledBlueprintProvenance {
  let bad = (message: string): never => { throw new Error(`${label}: ${message}`); };
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
): BundledBlueprintPresentation {
  let bad = (message: string): never => { throw new Error(`${label}: ${message}`); };
  let {
    blueprintId, title, description, output, author, revision, publication, importMethods, $comment,
    ...rest
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
  if (publication !== undefined && !PUBLICATION_ROLES.includes(publication as string)) {
    bad(`publication must be one of: ${PUBLICATION_ROLES.join(", ")}`);
  }
  if (importMethods !== undefined && (!Array.isArray(importMethods) ||
      importMethods.length === 0 || importMethods.length > MAX_IMPORT_METHODS ||
      importMethods.some(name => typeof name !== "string" || !IMPORT_METHOD_NAME.test(name)) ||
      new Set(importMethods).size !== importMethods.length)) {
    bad(`importMethods must be 1 to ${MAX_IMPORT_METHODS} distinct method names`);
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
    ...(publication === undefined ? {} : {publication: publication as "use" | "build"}),
    ...(importMethods === undefined ? {} : {importMethods: importMethods as string[]}),
  };
}
