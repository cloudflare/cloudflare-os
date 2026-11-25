/**
 * Whether `GOOGLE_DOCS_WIDER_TESTS` is set (non-empty): the same test bodies over wider tables
 * (more seeds, larger shapes). Only tables read it. Declared in the `test` task's `cache.env`.
 */
export const WIDER = !!process.env.GOOGLE_DOCS_WIDER_TESTS;
