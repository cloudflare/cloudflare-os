// `wrangler types` emits no declarations for Node module specifiers at this worker's settings.
// Declare the one function this package uses (the Doc store names its rows with it, and a Sheets
// guard is digested with it), without bringing the Node.js type environment into the worker's
// type space.
declare module "node:crypto" {
  /** A running digest. */
  interface Hash {
    update(data: string, inputEncoding: "utf8"): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}
