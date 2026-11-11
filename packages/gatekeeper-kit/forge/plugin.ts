/**
 * The Forge plugin `bin/openapi-schema.ts` builds and runs: the entry module `forge-plugin build`
 * compiles to a WebAssembly component. It runs in Forge's QuickJS, without Node or a file system.
 */

import { definePlugin } from "@cloudflare/forge/plugin";
import { emit } from "./emit";

export const { generate } = definePlugin({ generate: emit });
