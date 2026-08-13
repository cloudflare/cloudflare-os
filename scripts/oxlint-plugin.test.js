import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { preferJsdoc } from "./oxlint-plugin.mjs";

const require = createRequire(import.meta.url);
const vitePlusRequire = createRequire(require.resolve("vite-plus/package.json"));
// Test against Vite+'s pinned oxlint without adding a second direct dependency that can drift.
const { RuleTester } = await import(vitePlusRequire.resolve("oxlint/plugins-dev"));

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { lang: "ts" },
    sourceType: "module",
  },
});

ruleTester.run("prefer-jsdoc", preferJsdoc, {
  valid: [
    "// Explains an implementation detail.\nconst value = 1;",
    "/** Documents the public value. */\nexport const value = 1;",
    "// A detached module note.\n\nexport const value = 1;",
    "// oxlint-disable-next-line no-warning-comments\nexport const value = 1;",
    "/// <reference path=\"./types.d.ts\" />\nexport const value = 1;",
    "// Re-export the canonical value.\nexport { value };",
    "initialize(); // Explains initialization.\nexport const value = 1;",
    "/*! Retain this license. */\nexport const value = 1;",
    "/*@__PURE__*/\nexport const value = makeValue();",
    "/*@__NO_SIDE_EFFECTS__*/\nexport function value() {}",
    "interface Internal {\n  // Internal property.\n  value: number;\n}",
    "export class PublicClass {\n  // Private state.\n  private value = 1;\n}",
    "export class PublicClass {\n  #read(): {\n    // Private result.\n    value: number;\n  } { return { value: 1 }; }\n}",
    "export class PublicClass {\n  run(): void {\n    const local: {\n      // Local value.\n      value: number;\n    } = { value: 1 };\n  }\n}",
    "export class PublicClass {\n  constructor(\n    // Private state.\n    private value: number,\n  ) {}\n}",
    "export function run() {\n  return {} as {\n    // Local value.\n    value: number;\n  };\n}",
    "export class PublicClass {\n  constructor(private value: {\n    // Private nested state.\n    nested: number;\n  }) {}\n}",
    "export class PublicClass {\n  accessor state = makeValue<{\n    // Initializer detail.\n    nested: number;\n  }>();\n}",
  ],
  invalid: [
    {
      code: "// The public value.\nexport const value = 1;",
      output: "/** The public value. */\nexport const value = 1;",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "// The public operation.\n// Throws when it cannot finish.\nexport function run(): void {}",
      output: "/**\n * The public operation.\n * Throws when it cannot finish.\n */\nexport function run(): void {}",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "// The public contract.\nexport interface Contract {}",
      output: "/** The public contract. */\nexport interface Contract {}",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "// The default implementation.\nexport default class Implementation {}",
      output: "/** The default implementation. */\nexport default class Implementation {}",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "// A delimiter example: */.\nexport const value = 1;",
      output: null,
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "/* The public value. */\nexport const value = 1;",
      output: "/** The public value. */\nexport const value = 1;",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "export interface Contract {\n  // Runs the operation.\n  run(): void;\n}",
      output: "export interface Contract {\n  /** Runs the operation. */\n  run(): void;\n}",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "export type Options = {\n  // Enables retries.\n  retry: boolean;\n};",
      output: "export type Options = {\n  /** Enables retries. */\n  retry: boolean;\n};",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "export class PublicClass {\n  // Runs the operation.\n  run(): void {}\n}",
      output: "export class PublicClass {\n  /** Runs the operation. */\n  run(): void {}\n}",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "export enum Status {\n  // The operation completed.\n  Done,\n}",
      output: "export enum Status {\n  /** The operation completed. */\n  Done,\n}",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "export class PublicClass {\n  run(): {\n    // Public result.\n    value: number;\n  } { return { value: 1 }; }\n}",
      output: "export class PublicClass {\n  run(): {\n    /** Public result. */\n    value: number;\n  } { return { value: 1 }; }\n}",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "export abstract class PublicClass {\n  // Runs the operation.\n  abstract run(): void;\n  // Public state.\n  abstract value: number;\n}",
      output: "export abstract class PublicClass {\n  /** Runs the operation. */\n  abstract run(): void;\n  /** Public state. */\n  abstract value: number;\n}",
      errors: [{ messageId: "useJsdoc" }, { messageId: "useJsdoc" }],
    },
    {
      code: "export class PublicClass {\n  // Public state.\n  accessor value = 1;\n}",
      output: "export class PublicClass {\n  /** Public state. */\n  accessor value = 1;\n}",
      errors: [{ messageId: "useJsdoc" }],
    },
    {
      code: "export class PublicClass {\n  constructor(\n    // Public state.\n    public value: number,\n  ) {}\n}",
      output: "export class PublicClass {\n  constructor(\n    /** Public state. */\n    public value: number,\n  ) {}\n}",
      errors: [{ messageId: "useJsdoc" }],
    },
  ],
});
