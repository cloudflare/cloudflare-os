/**
 * Gadget libraries: shared code a gadget imports as `gadgets:<name>/client` and
 * `gadgets:<name>/server` instead of carrying its own copy.
 *
 * Which library a gadget uses is decided by one file in the gadget's own tree, `gadget.json`:
 *
 *     {"libraries": {"sync": "latest", "ui": "latest"}}
 *
 * A pin is `latest`: the bundle shipped with the running deployment, so every workspace pinned that
 * way runs the deployment's current library with zero I/O. Both the Durable Object loader and the
 * UI bundle read the pin file from the committed (or chat-proposed) files, so a chat can propose a
 * pin change and run the gadget against it in its preview before anyone accepts. Nothing about a
 * library is stored by the deployment: rolling a bad `latest` back is a redeploy.
 *
 * This module is the grammar -- the pin file and the specifier scheme -- and is shared by the
 * blueprint build (which checks that a blueprint's imports and pins agree) and by the kernel (which
 * resolves pins to code when it loads a gadget).
 */

/** The pin file's path inside a gadget's files. */
export const GADGET_JSON_PATH = "gadget.json";

/** What a library may be called: a lowercase identifier, so a specifier never needs quoting. */
export const LIBRARY_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

/** The two sides of a library, and of the gadget importing it. */
export const LIBRARY_SIDES = ["client", "server"] as const;
export type LibrarySide = (typeof LIBRARY_SIDES)[number];

/**
 * Where a pin's code comes from. Only the deployment's shipped bundle today; a pin to a copy the
 * gadget carries in its own files is the natural next value.
 */
export type LibraryPin = "latest";

/** A gadget's pins: library name to pin, as `gadget.json` declares them. */
export type GadgetPins = ReadonlyMap<string, LibraryPin>;

/** The specifier a gadget imports one side of a library by. */
export function librarySpecifier(name: string, side: LibrarySide): string {
  return `gadgets:${name}/${side}`;
}

/** `gadgets:<name>/<side>` taken apart, or null for any other string. */
export function parseLibrarySpecifier(
  specifier: string,
): { name: string; side: LibrarySide } | null {
  const match = /^gadgets:([^/]+)\/(client|server)$/u.exec(specifier);
  if (!match || !LIBRARY_NAME_PATTERN.test(match[1]!)) return null;
  return { name: match[1]!, side: match[2] as LibrarySide };
}

/**
 * The names of the libraries `code` imports on `side`, in order of first appearance: every
 * `gadgets:<name>/<side>` string literal in it. A text scan, like the blueprint build's, so a
 * specifier in a comment counts; the callers describe the gadget's code to the agent, who reads the
 * same text, and the pins the gadget actually loads are `readPins`'s business.
 */
export function libraryImportsIn(code: string, side: LibrarySide): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/["']gadgets:([^"'/\s]+)\/(client|server)["']/gu)) {
    if (match[2] !== side || !LIBRARY_NAME_PATTERN.test(match[1]!)) continue;
    if (!found.includes(match[1]!)) found.push(match[1]!);
  }
  return found;
}

/**
 * The pins a gadget's files declare: `gadget.json` parsed strictly, or no pins when the file is
 * absent. Throws on a pin file that is malformed -- an unparseable pin file must fail the load
 * loudly rather than run the gadget without the libraries it asked for.
 *
 * `gadget.json` was an unrestricted filename before libraries existed, so a gadget may carry one
 * that is not about pins at all: a value that is not an object, or an object without a `libraries`
 * key, is somebody else's file and declares no pins. Once `libraries` is present the file is a pin
 * file and every rule applies: no other keys, an object of name to pin, valid names, `latest` pins.
 */
export function readPins(files: ReadonlyMap<string, string>): GadgetPins {
  const text = files.get(GADGET_JSON_PATH);
  return text === undefined ? new Map() : parsePins(text);
}

/** {@link readPins} over the file's text. */
export function parsePins(text: string): GadgetPins {
  const bad = (message: string): never => {
    throw new Error(`${GADGET_JSON_PATH}: ${message}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return bad(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(parsed) || !("libraries" in parsed)) return new Map();
  const { libraries, ...rest } = parsed;
  if (Object.keys(rest).length > 0) bad(`unknown keys: ${Object.keys(rest).join(", ")}`);
  if (!isRecord(libraries)) bad("libraries must be an object of library name to pin");
  const pins = new Map<string, LibraryPin>();
  for (const [name, pin] of Object.entries(libraries as Record<string, unknown>)) {
    if (!LIBRARY_NAME_PATTERN.test(name)) bad(`"${name}" is not a library name ([a-z][a-z0-9-]*)`);
    if (pin !== "latest") return bad(`libraries.${name} must be "latest"`);
    pins.set(name, pin);
  }
  return pins;
}

/** The text of a `gadget.json` declaring `pins`, formatted the way the repo's blueprints write it. */
export function formatPins(pins: GadgetPins): string {
  const libraries: Record<string, LibraryPin> = {};
  for (const name of [...pins.keys()].toSorted()) libraries[name] = pins.get(name)!;
  return `${JSON.stringify({ libraries }, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
