import { describe, expect, it } from "vitest";
import { mergeTypeModules } from "../src/type-modules";

const CURSOR = "/** A page of results. */\nexport interface Cursor<T> {\n  next(): Promise<{ items: T[] }>;\n}\n";

describe("mergeTypeModules", () => {
  it("keeps a declaration shared word for word once, and everything else in order", () => {
    const first = `${CURSOR}\nexport type Site = { id: string };\n`;
    const second = `export type Mailbox = { id: string; cursor: Cursor<string> };\n\n${CURSOR}`;
    const merged = mergeTypeModules([first, second]);
    expect(merged.match(/export interface Cursor/g)).toHaveLength(1);
    expect(merged.indexOf("export type Site")).toBeLessThan(merged.indexOf("export type Mailbox"));
    expect(merged).toContain("export type Mailbox = { id: string; cursor: Cursor<string> };");
  });

  it("refuses a shared name declared differently", () => {
    expect(() => mergeTypeModules([CURSOR, CURSOR.replace("items: T[]", "items: readonly T[]")]))
      .toThrow(/declare Cursor differently/);
  });

  it("ends a type alias at its own semicolon, not one inside a method signature", () => {
    const first = "export type Lookup = { find(id: string): Promise<{ a: string; b: number }>; done: boolean };\n";
    const second = `${first}export type Extra = { x: 1 };\n`;
    const merged = mergeTypeModules([first, second]);
    expect(merged.match(/export type Lookup/g)).toHaveLength(1);
    expect(merged).toContain("export type Extra = { x: 1 };");
  });
});
