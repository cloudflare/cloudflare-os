// A shape as TypeScript-like text. Shared by the emitter, which writes each argument's and result's
// type into the table for help, and the codec, which names the expected type when a JSON value does
// not fit its shape. Pure: no `node:` imports, disk, clock or environment.

import type { ApiShape } from "./table.ts";

const BUILTIN_TEXT: Record<string, string> = {
  date: "Date", bytes: "Uint8Array", error: "Error", readableStream: "ReadableStream",
  writableStream: "WritableStream", arrayBuffer: "ArrayBuffer", dataView: "DataView", regexp: "RegExp",
  blob: "Blob", url: "URL", headers: "Headers", request: "Request", response: "Response",
};

/** A shape as TypeScript-like text, for help: named shapes by name. */
export function typeText(shape: ApiShape): string {
  switch (shape.kind) {
    case "literal": return JSON.stringify(shape.value);
    case "array": return `${wrapped(shape.element)}[]`;
    case "set": return `Set<${typeText(shape.element)}>`;
    case "map": return `Map<${typeText(shape.key)}, ${typeText(shape.value)}>`;
    case "tuple": {
      const min = shape.minLength ?? shape.elements.length;
      const elements = shape.elements.map((element, i) => `${typeText(element)}${i < min ? "" : "?"}`);
      if (shape.rest) elements.push(`...${wrapped(shape.rest)}[]`);
      return `[${elements.join(", ")}]`;
    }
    case "object": {
      const entries = Object.entries(shape.properties).map(([key, value]) => {
        const optional = value.kind === "undefined"
          || value.kind === "union" && value.branches.some((branch) => branch.kind === "undefined");
        const inner = value.kind === "union" && optional ? withoutUndefined(value) : value;
        return `${propertyKey(key)}${optional ? "?" : ""}: ${typeText(inner)}`;
      });
      if (shape.index && entries.length === 0) return `Record<string, ${typeText(shape.index)}>`;
      if (shape.index) entries.push(`[key: string]: ${typeText(shape.index)}`);
      return entries.length === 0 ? "{}" : `{ ${entries.join("; ")} }`;
    }
    case "union": {
      return shape.branches.toSorted((a, b) => nullishLast(a) - nullishLast(b)).map(wrapped).join(" | ");
    }
    case "ref": return shape.name;
    case "typedArray": return shape.name;
    case "stub": return `RpcStub<${shape.service ?? "any"}>`;
    case "function": {
      const params = shape.params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${typeText(p.type)}`);
      return `(${params.join(", ")}) => ${typeText(shape.returns)}`;
    }
    case "unsupported": return "unknown";
    default: return BUILTIN_TEXT[shape.kind] ?? shape.kind;
  }
}

/** Sorts `null`, then `undefined`, after the other branches, as TypeScript is written. */
function nullishLast(shape: ApiShape): number {
  return shape.kind === "null" ? 1 : shape.kind === "undefined" ? 2 : 0;
}

function wrapped(shape: ApiShape): string {
  return shape.kind === "union" || shape.kind === "function" ? `(${typeText(shape)})` : typeText(shape);
}

/**
 * The union without its `undefined` branches: the type of an optional property (`key?: T`) when it
 * is present, which is how both the help and the codec's type check read it.
 */
export function withoutUndefined(shape: ApiShape & { kind: "union" }): ApiShape {
  const branches = shape.branches.filter((branch) => branch.kind !== "undefined");
  return branches.length === 1 ? branches[0]! : { kind: "union", branches };
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** An object key as TypeScript writes it: bare when it is an identifier, quoted otherwise. */
export function propertyKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}
