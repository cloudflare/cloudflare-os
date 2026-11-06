// A doc's first sentence, its summary. Shared by the emitter, which writes the first sentence of a
// named type's doc into the table for an argument's help, and the runtime, whose listings and
// search read commands' and capabilities' docs by their first sentence. Pure: no `node:` imports,
// so the generator can import it.

/** The first sentence of `doc`'s first paragraph, whole: one that `e.g.` or `i.e.` does not end. */
export function firstSentence(doc: string): string {
  const first = doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  return /^(.*?(?<!\b(?:e\.g|i\.e))[.!?])(\s|$)/.exec(first)?.[1] ?? first;
}
