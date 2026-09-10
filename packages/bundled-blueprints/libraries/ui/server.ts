/**
 * The ui library's server entry (`gadgets:ui/server`). The library is DOM helpers, so this side has
 * nothing to offer a Durable Object; the module exists because the build bundles both sides of
 * every library, and a gadget that imports it gets exactly this one flag.
 */

/** Marks the library as client-only: everything it offers is under `gadgets:ui/client`. */
export const clientOnly = true as const;
