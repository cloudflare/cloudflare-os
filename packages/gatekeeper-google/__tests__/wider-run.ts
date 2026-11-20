/**
 * Whether this is the wider run of the Docs tests: `GOOGLE_DOCS_WIDER_TESTS` set to anything
 * but the empty string. The default pass holds in full what is deterministic and cheap, since
 * every pull request runs it; the wider run holds the tables too large for that (a second
 * seed, a larger shape, a suite the default pass registers and skips) and is run before a
 * push. It is THE SAME TEST BODIES OVER A WIDER TABLE: a table with two widths reads this
 * constant and nothing else, and no body branches on it but through the table it reads. The
 * package's `test` task declares the variable in its `cache.env` (`vite.config.ts`), so a
 * cached run neither strips it nor replays the narrower result.
 */
export const WIDER = !!process.env.GOOGLE_DOCS_WIDER_TESTS;
