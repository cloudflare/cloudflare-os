import {defineConfig} from "vitest/config";

/** Native Git consumes the actual smart-HTTP byte stream served by workerd. */
export default defineConfig({test: {include: ["__tests__/native/*.test.ts"], environment: "node"}});
