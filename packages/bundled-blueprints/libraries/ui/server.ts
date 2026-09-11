/**
 * The ui library's server entry (`@gadgets/bundled-blueprints/libraries/ui/server`). The library is
 * DOM helpers, so this side has nothing to offer a Durable Object; the module exists because the
 * build bundles both sides of every library, and a gadget that imports it gets exactly this one
 * flag.
 */

/** Marks the library as client-only: everything it offers is under `.../libraries/ui/client`. */
export const clientOnly = true as const;
