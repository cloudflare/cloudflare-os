// Test worker for the workerd suite: re-exports the production entrypoints so miniflare can host the
// Durable Objects, which reach each other through `ctx.exports` as they do in production.

export * from "../src/index.js";
export { default } from "../src/index.js";
