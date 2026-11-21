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

const gatekeeper = (members: string) => `class GatekeeperImpl {\n  async startSession() {}\n${members}\n}`;
const observers = "  async addObserver(_id: string) {}\n  async removeObserver(_id: string) {}";
const history = "  async getHistoricalSubresources() { return []; }\n";
const contract = history + observers;
const call = (description: string) => `await queue.authorizeObservation(${description});`;
const unreported = (description: string) => ({ code: call(description), errors: [{ messageId: "unreported" }] });

ruleTester.run("new-gatekeeper-observer-contract", plugin.rules["new-gatekeeper-observer-contract"], {
  valid: [
    gatekeeper(contract),
    gatekeeper(`${contract}\n  async verifyObserverAccess(observers, ids) { return check(observers, ids); }`),
    // Not a gatekeeper: it starts no session.
    "class Roster {\n  async addObserver(id: string) { this.ids.add(id); }\n}",
    // A base class may supply the session and the history; what this one defines is still checked.
    "class Facet extends Base implements Gatekeeper<Session> {\n  async addObserver(_id: string) {}\n}",
    // An abstract declaration leaves the method to each subclass, which is checked where it is written.
    "abstract class Base extends DurableObject<Env> implements Gatekeeper<Session> {\n" +
      "  abstract getHistoricalSubresources(): Promise<string[]>;\n  async addObserver(_id: string) {}\n}",
    // The implementation is the method that runs, not the overload signature before it.
    gatekeeper("  getHistoricalSubresources(): Promise<string[]>;\n" +
      `  async getHistoricalSubresources() { return [] as string[]; }\n${observers}`),
    ...[
      "{ title, subresources: [] }",
      "{ ...observation, subresources: [id] }",
      "{ title, subresources }",
      "{ title, \"subresources\": [id] }",
      "{ title, subresources: [id] } satisfies ObservationDescription",
      "{ title, [\"subresources\"]: [id] }",
      "{ title, subresources: id ? [id] : [] }",
      // An `undefined` on the left of `??` or `||` gives way to the fallback.
      "{ title, subresources: (id ? [id] : undefined) ?? [] }",
      "{ title, subresources: (scoped ? ids : undefined) || all }",
      // A description built elsewhere is checked by its helper's type, not here.
      "observation",
      "scoped ? { title, subresources: ids } : observation",
    ].map(call),
    // A name computed at run time is not one the rule can read.
    "await queue[method]({ title });",
    // A private helper of the same name is not the queue's method.
    "class Session {\n  #authorizeObservation(description, ids) {}\n" +
      "  read() { return this.#authorizeObservation({ title }, ids); }\n}",
  ],
  invalid: [
    { code: gatekeeper(observers), errors: [{ messageId: "missingHistory" }] },
    {
      code: gatekeeper(`  async getHistoricalSubresources() { return this.tracker.ids(); }\n${observers}`),
      errors: [{ messageId: "history" }],
    },
    {
      code: gatekeeper(`  async getHistoricalSubresources() { return [this.id]; }\n${observers}`),
      errors: [{ messageId: "history" }],
    },
    {
      code: gatekeeper(`  async getHistoricalSubresources() { return ready ? [] : []; }\n${observers}`),
      errors: [{ messageId: "history" }],
    },
    {
      code: gatekeeper(history +
        "  async addObserver(id: string, user) { await this.verify(user); }\n" +
        "  async removeObserver(id: string) { this.observers.delete(id); }"),
      errors: [
        { messageId: "observerState", data: { name: "addObserver" } },
        { messageId: "observerState", data: { name: "removeObserver" } },
      ],
    },
    {
      code: gatekeeper(history +
        "  addObserver(id: string, user: Verifier): Promise<void>;\n" +
        "  async addObserver(id: string, user?: Verifier) { this.observers.add(id); }\n" +
        "  async removeObserver(_id: string) {}"),
      errors: [{ messageId: "observerState", data: { name: "addObserver" } }],
    },
    {
      code: "class Facet extends Base implements Gatekeeper<Session> {\n" +
        "  async addObserver(id: string) { this.observers.add(id); }\n}",
      errors: [{ messageId: "observerState", data: { name: "addObserver" } }],
    },
    {
      code: "class Facet implements Gatekeeper<Session> {\n  async addObserver(_id: string) {}\n}",
      errors: [{ messageId: "missingHistory" }],
    },
    {
      code: gatekeeper(`${history}  async "addObserver"(id: string) { this.observers.add(id); }\n` +
        "  async removeObserver(_id: string) {}"),
      errors: [{ messageId: "observerState", data: { name: "addObserver" } }],
    },
    // A getter is not a method the kernel can call.
    {
      code: gatekeeper(`  get getHistoricalSubresources() { return []; }\n${observers}`),
      errors: [{ messageId: "missingHistory" }],
    },
    {
      code: "abstract class Base extends DurableObject<Env> implements Gatekeeper<Session> {\n" +
        "  abstract startSession(): Promise<Session>;\n  async addObserver(_id: string) {}\n}",
      errors: [{ messageId: "missingHistory" }],
    },
    // A static method is not the facet's.
    {
      code: "class Facet implements Gatekeeper<Session> {\n  async addObserver(_id: string) {}\n" +
        "  static async getHistoricalSubresources() { return []; }\n}",
      errors: [{ messageId: "missingHistory" }],
    },
    // The shape the skeleton writes: Cloudflare's base class supplies no history.
    {
      code: "class Facet extends DurableObject<Env> implements Gatekeeper<Session> {\n  async addObserver(_id: string) {}\n}",
      errors: [{ messageId: "missingHistory" }],
    },
    ...[
      "{ ...observation }",
      "{ title } satisfies ObservationDescription",
      "{ title } as ObservationDescription",
      "{ title }!",
      // The spread comes last, and can carry `subresources: undefined`.
      "{ subresources: [id], ...observation }",
      // The kernel reads `undefined` as the field left out, in any branch of the value.
      "{ title, subresources: undefined }",
      "{ title, subresources: id ? [id] : undefined }",
      "{ title, subresources: (id ? undefined : [id]) as string[] }",
      "{ title, subresources: ids ?? undefined }",
      "{ title, subresources: scoped && undefined }",
      // Each branch written at the call is one that may be sent.
      "scoped ? { title, subresources: ids } : { title }",
      "given ?? { title }",
    ].map(unreported),
    {
      code: call("scoped ? { title } : ({ title } satisfies ObservationDescription)"),
      errors: [{ messageId: "unreported" }, { messageId: "unreported" }],
    },
    {
      code: "await this.queue.authorizeObservation({ title: \"Read inbox\" });",
      errors: [{ messageId: "unreported" }],
    },
    { code: "await queue[\"authorizeObservation\"]({ title });", errors: [{ messageId: "unreported" }] },
    ...[
      call("{ title, subresources: [], excludeObservers: [id] }"),
      call("{ title, subresources: [], \"excludeObservers\": [id] }"),
      call("{ title, subresources: [], [\"excludeObservers\"]: [id] }"),
      `observation.excludeObservers = denied;\n${call("observation")}`,
      `observation["excludeObservers"] = denied;\n${call("observation")}`,
    ].map(code => ({ code, errors: [{ messageId: "excludeObservers" }] })),
  ],
});
