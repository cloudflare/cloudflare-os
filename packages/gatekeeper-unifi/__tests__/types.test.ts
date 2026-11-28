/// <reference types="node" />
// The agent receives the type files verbatim through their `.txt` symlinks, so the links must exist
// and point at the real files, and the two files must not declare a name twice: the vendor returns
// them concatenated.

import { readFile, readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url).href);

async function exportedNames(file: string): Promise<string[]> {
  return [...(await readFile(src(file), "utf8")).matchAll(/^export (?:type|interface) (\w+)/gm)].map(match => match[1]!);
}

describe("agent type files", () => {
  it.each(["network-types", "protect-types"])("%s.txt is a symlink to %s.d.ts", async name => {
    expect(await readlink(src(`${name}.txt`))).toBe(`${name}.d.ts`);
  });

  it("declare no exported name twice", async () => {
    const network = await exportedNames("network-types.d.ts");
    const protect = await exportedNames("protect-types.d.ts");
    expect(network.filter(name => protect.includes(name))).toEqual([]);
    expect(new Set([...network, ...protect]).size).toBe(network.length + protect.length);
  });

  it("never mention the approval machinery, which simulation keeps invisible", async () => {
    for (const file of ["network-types.d.ts", "protect-types.d.ts"]) {
      const text = await readFile(src(file), "utf8");
      expect(text, file).not.toMatch(/approv|submitAction|applyAction|simulat|pending action/i);
    }
  });
});
