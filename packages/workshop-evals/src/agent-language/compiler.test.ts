import { describe, it, expect } from "vitest";
import { validate } from "./compiler.ts";
const good =
  'export default async function(self, env, ctx) { return (await env.TICKETS.list()).filter(t => t.priority === "high").map(t => t.id); }';
describe("host supplied types", () => {
  it("accepts unannotated JS without changing executed bytes", () => {
    const result = validate(good, "checkjs");
    expect(result.diagnostics).toEqual([]);
    expect(result.javascript).toBe(good);
  });
  it("catches nonexistent methods that baseline accepts", () => {
    const source = good.replace(".list()", ".missing()");
    expect(validate(source, "js").diagnostics).toEqual([]);
    expect(validate(source, "checkjs").diagnostics.join(" ")).toContain("missing");
  });
  it("rejects malformed JS and unsafe static-check suppression", () => {
    expect(validate("export default async function( {", "js").diagnostics.length).toBeGreaterThan(
      0,
    );
    expect(validate("// @ts-nocheck\n" + good, "checkjs").diagnostics.length).toBeGreaterThan(0);
  });
  it("does not pretend static types catch wrong valid IDs", () => {
    expect(
      validate(
        'export default async function(self, env, ctx) { return await env.TICKETS.close({id:"wrong", resolution:"fixed"}); }',
        "checkjs",
      ).diagnostics,
    ).toEqual([]);
  });
});
