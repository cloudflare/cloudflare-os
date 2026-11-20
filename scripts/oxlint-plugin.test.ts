import { describe, it } from "node:test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import plugin from "./oxlint-plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { lang: "ts" },
    sourceType: "module",
  },
});

ruleTester.run("prefer-jsdoc", plugin.rules["prefer-jsdoc"], {
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

ruleTester.run("self-contained-agent-types", plugin.rules["self-contained-agent-types"], {
  valid: [
    "export interface Cursor<T> {\n  next(): Promise<T[] | null>;\n}",
    "interface Cursor<T> {}\nexport type { Cursor };",
    "import type { RpcTarget } from \"cloudflare:workers\";\nexport interface Session extends RpcTarget {}",
    "/// <reference lib=\"es2024\" />\nexport interface Session {}",
    "/**\n * import { Helper } from \"./helper\";\n */\nexport interface Session {}",
    {
      code: "import type { ReadSession } from \"./read-types\";\nexport interface Session extends ReadSession {}",
      options: [{ allow: ["./read-types"] }],
    },
  ],
  invalid: [
    {
      code: "import { Cursor } from \"@gadgets/workshop-shared/gatekeeper\";\nexport type { Cursor };",
      errors: [{ messageId: "moduleReference", data: { source: "@gadgets/workshop-shared/gatekeeper" } }],
    },
    {
      code: "export type { Cursor } from \"@gadgets/workshop-shared/gatekeeper\";",
      errors: [{ messageId: "moduleReference" }],
    },
    {
      code: "export * from \"./other-types\";",
      errors: [{ messageId: "moduleReference" }],
    },
    {
      code: "export type Page = import(\"./other-types\").Page;",
      errors: [{ messageId: "moduleReference", data: { source: "./other-types" } }],
    },
    {
      code: "import shared = require(\"./shared\");\nexport type Page = shared.Page;",
      errors: [{ messageId: "moduleReference" }],
    },
    {
      code: "/// <reference types=\"@cloudflare/workers-types\" />\nexport interface Session {}",
      errors: [{ messageId: "moduleReference", data: { source: "@cloudflare/workers-types" } }],
    },
    {
      code: "/// <reference path=\"./other.d.ts\" />\nexport interface Session {}",
      errors: [{ messageId: "moduleReference", data: { source: "./other.d.ts" } }],
    },
    {
      code: "import type { A } from \"./a\";\nimport type { B } from \"./b\";",
      options: [{ allow: ["./a"] }],
      errors: [{ messageId: "moduleReference", data: { source: "./b" } }],
    },
  ],
});

const restrictedFetch = [{ name: "fetch", message: "Use the upstream." }];

ruleTester.run("no-restricted-global-destructuring", plugin.rules["no-restricted-global-destructuring"], {
  valid: [
    { code: "const { fetch } = options;", options: restrictedFetch },
    { code: "const { crypto } = globalThis;", options: restrictedFetch },
    { code: "const { fetch: send } = env.BINDING;", options: restrictedFetch },
    { code: "function run(self: Stub) {\n  const { fetch } = self;\n  return fetch;\n}", options: restrictedFetch },
    { code: "const window = { fetch: 1 };\nconst { fetch } = window;", options: restrictedFetch },
    { code: "import { self } from \"./stub\";\nconst { fetch } = self;", options: restrictedFetch },
    { code: "const { [name]: send } = globalThis;", options: restrictedFetch },
    { code: "const { fetch: send } = globalThis.navigator;", options: restrictedFetch },
    { code: "const { ...rest } = globalThis;", options: restrictedFetch },
    // A computed key that is the bare identifier is a use of the global, which `no-restricted-globals` reports.
    { code: "const { [fetch]: send } = globalThis;", options: restrictedFetch },
    { code: "const self = stub;\nfunction run() {\n  const { fetch } = self;\n  return fetch;\n}", options: restrictedFetch },
    { code: "function outer(window: Stub) {\n  return () => {\n    const { fetch } = window;\n    return fetch;\n  };\n}", options: restrictedFetch },
    "const { fetch } = globalThis;",
  ],
  invalid: [
    {
      code: "const { fetch } = globalThis;",
      options: restrictedFetch,
      errors: [{
        message: "Unexpected use of 'fetch', destructured from 'globalThis'. Use the upstream.",
        line: 1,
        column: 8,
      }],
    },
    {
      code: "const { fetch: send } = self;",
      options: [{ name: "fetch" }],
      errors: [{ message: "Unexpected use of 'fetch', destructured from 'self'." }],
    },
    {
      code: "const { \"fetch\": send } = window;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", data: { name: "fetch", object: "window", message: " Use the upstream." } }],
    },
    {
      code: "const { [\"fetch\"]: send = fallback } = globalThis;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "const { crypto, fetch } = globalThis as unknown as Runtime;",
      options: [...restrictedFetch, { name: "crypto" }],
      errors: [
        { message: "Unexpected use of 'crypto', destructured from 'globalThis'." },
        { message: "Unexpected use of 'fetch', destructured from 'globalThis'. Use the upstream." },
      ],
    },
    {
      code: "const { fetch } = globalThis!;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "const { fetch } = (globalThis satisfies object);",
      options: restrictedFetch,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "let send;\n({ fetch: send } = globalThis);",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", line: 2 }],
    },
    {
      code: "function run({ fetch } = globalThis) {\n  return fetch;\n}",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", line: 1 }],
    },
    {
      code: "function run(stub: Stub) {\n  const { fetch } = self;\n  return stub.fetch === fetch;\n}",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", line: 2 }],
    },
    {
      code: "const { fetch } = <Runtime>globalThis;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "const { fetch } = (globalThis);",
      options: restrictedFetch,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "declare const globalThis: Runtime;\nconst { fetch } = globalThis;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", line: 2 }],
    },
    {
      code: "declare namespace self {}\nfunction run() {\n  const { fetch: send } = self;\n  return send;\n}",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", line: 3 }],
    },
    {
      code: "declare const { globalThis }: Runtime;\nconst { fetch } = globalThis;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", line: 2 }],
    },
  ],
});

ruleTester.run("no-restricted-global-declaration", plugin.rules["no-restricted-global-declaration"], {
  valid: [
    { code: "const fetch = upstream.fetcher();", options: restrictedFetch },
    { code: "function fetch(url: string): void;\nfunction fetch(url: unknown) {}", options: restrictedFetch },
    { code: "declare const crypto: Crypto;", options: restrictedFetch },
    { code: "declare function send(fetch: Fetcher): void;", options: restrictedFetch },
    { code: "type fetch = unknown;", options: restrictedFetch },
    { code: "interface fetch {}", options: restrictedFetch },
    { code: "declare global {\n  function fetch(input: string): Promise<Response>;\n}\nexport {};", options: restrictedFetch },
    { code: "declare namespace runtime {\n  const fetch: Fetcher;\n}", options: restrictedFetch },
    { code: "declare module \"fetch\" {}", options: restrictedFetch },
    { code: "const { fetch } = options;", options: restrictedFetch },
    { code: "declare const { crypto }: Runtime;", options: restrictedFetch },
    // A property's key is no binding: the name bound is the one it is renamed to.
    { code: "declare const { fetch: send }: Platform;", options: restrictedFetch },
    { code: "declare const [send, ...others]: Fetcher[];", options: restrictedFetch },
    "declare const fetch: Fetcher;",
  ],
  invalid: [
    {
      code: "declare const fetch: (input: string) => Promise<Response>;\nexport const send = (url: string) => fetch(url);",
      options: restrictedFetch,
      errors: [{
        message: "Unexpected ambient declaration of 'fetch', which hides the global from lint. Use the upstream.",
        line: 1,
        column: 14,
      }],
    },
    {
      code: "declare function fetch(input: string): Promise<Response>;\nexport const send = fetch;",
      options: [{ name: "fetch" }],
      errors: [{ message: "Unexpected ambient declaration of 'fetch', which hides the global from lint.", line: 1 }],
    },
    {
      code: "declare var other: Other, fetch: Fetcher;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", data: { name: "fetch", message: " Use the upstream." }, column: 26 }],
    },
    {
      code: "declare let fetch: Fetcher;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "export declare const fetch: Fetcher;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "declare class fetch {}",
      options: restrictedFetch,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "declare enum fetch {}",
      options: restrictedFetch,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "declare namespace fetch {\n  const preconnect: unknown;\n}",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", line: 1 }],
    },
    {
      code: "declare const self: Scope, fetch: Fetcher;",
      options: [...restrictedFetch, { name: "self" }],
      errors: [
        { message: "Unexpected ambient declaration of 'self', which hides the global from lint." },
        { message: "Unexpected ambient declaration of 'fetch', which hides the global from lint. Use the upstream." },
      ],
    },
    {
      code: "declare const { fetch }: { fetch: Fetcher };\nexport const send = (url: string) => fetch(url);",
      options: restrictedFetch,
      errors: [{
        message: "Unexpected ambient declaration of 'fetch', which hides the global from lint. Use the upstream.",
        line: 1,
        column: 16,
      }],
    },
    {
      code: "declare const { platform: fetch }: Platform;\nexport const send = fetch;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", data: { name: "fetch", message: " Use the upstream." }, line: 1, column: 26 }],
    },
    {
      code: "declare const [fetch]: [Fetcher];\nexport const send = (url: string) => fetch(url);",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", line: 1, column: 15 }],
    },
    {
      code: "declare const { self }: Runtime;\nexport const send = (url: string) => self.fetch(url);",
      options: [...restrictedFetch, { name: "self" }],
      errors: [{ message: "Unexpected ambient declaration of 'self', which hides the global from lint.", line: 1 }],
    },
    {
      code: "declare const { runtime: { fetch } }: Platform;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", column: 27 }],
    },
    {
      code: "declare const [, [first, fetch]]: [Fetcher, Fetcher[]];",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", column: 25 }],
    },
    {
      code: "declare const { crypto, ...fetch }: Runtime;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", column: 27 }],
    },
    {
      code: "declare const [first, ...fetch]: Fetcher[];",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", column: 25 }],
    },
    {
      code: "declare const { fetch = fallback }: Runtime;",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", column: 16 }],
    },
    {
      code: "declare const [first, fetch = fallback]: Fetcher[];",
      options: restrictedFetch,
      errors: [{ messageId: "restricted", column: 22 }],
    },
    {
      code: "export declare const { fetch, self }: Runtime, [window]: Runtime[];",
      options: [...restrictedFetch, { name: "self" }, { name: "window" }],
      errors: [
        { messageId: "restricted", data: { name: "fetch", message: " Use the upstream." } },
        { messageId: "restricted", data: { name: "self", message: "" } },
        { messageId: "restricted", data: { name: "window", message: "" } },
      ],
    },
  ],
});
