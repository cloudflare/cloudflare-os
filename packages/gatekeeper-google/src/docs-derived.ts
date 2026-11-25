/**
 * The digest of the code that derives what the Doc store keeps of a tab beside the tab: each
 * edit's requests and the version they give, each rendering and its summary, and whether the
 * model indexes a tab. The store writes it in every such row and reads a row only under it,
 * so nothing derived by other code is served: a deploy that changes that code makes each
 * document fold its pending edits once more from its stored copy, and fetches nothing.
 *
 * It is the SHA-256 of the JavaScript the TypeScript compiler emits for the modules
 * `__tests__/docs-derived.test.ts` lists, which fails, with the value to put here, whenever
 * that code moves. Record it then; nothing else is to be remembered.
 */
export const DOC_DERIVED = "5b624b9c407694f8bb96dd551934adcd679f3d7ed472c74271a13fe37a5c754b";
