import { it, expect } from "vitest";
import { generateSessionTypes, sessionTypeName } from "../../../mcp-shared/src/schema-to-ts.ts";
import { MCP_BASE_TYPES } from "../../../mcp-shared/src/base-types.ts";
import { validate, declarations } from "./compiler.ts";
it("checks unannotated JS against actual JSON Schema generated MCP types", () => {
  const discriminator = "https://synthetic.invalid/mcp";
  const generated = generateSessionTypes({
    baseTypes: MCP_BASE_TYPES,
    serverId: "demo",
    serverName: "Demo",
    endpoint: discriminator,
    discriminator,
    trust: "byo",
    tools: [
      {
        tool: {
          name: "search_records",
          description: "Search the synthetic record index",
          inputSchema: {
            type: "object",
            properties: {
              filter: {
                type: "object",
                properties: { priority: { enum: ["high", "low"] } },
                required: ["priority"],
                additionalProperties: false,
              },
              limit: { type: "integer" },
            },
            required: ["filter"],
            additionalProperties: false,
          },
        },
        mode: "read",
        autoApprovable: false,
        classifiedBy: "server-annotation",
      },
    ],
  });
  // The generator emits exported interfaces; expose one as a global env declaration.
  const typeName = sessionTypeName("demo", discriminator);
  const env =
    declarations.replace("interface Env {", "interface OriginalEnv {") +
    "\n" +
    generated.replaceAll("export ", "") +
    `\ninterface Env { MCP: ${typeName} }`;
  const good =
    'export default async function(self,env,ctx){return await env.MCP.searchRecords({filter:{priority:"high"},limit:1})}';
  expect(validate(good, "checkjs", env).diagnostics).toEqual([]);
  expect(
    validate(good.replace('"high"', '"urgent"'), "checkjs", env).diagnostics.join(" "),
  ).toContain("urgent");
});
