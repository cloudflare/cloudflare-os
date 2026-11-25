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
export const DOC_DERIVED = "0e56d5356dd5f4e57e7a4ba0b7ed49dd931a65ecbc3ea82d491577f98db9cd1d";
