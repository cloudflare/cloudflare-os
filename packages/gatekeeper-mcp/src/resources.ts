import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

const DESCRIPTION =
  "An MCP endpoint you supply. Tools are discovered automatically, and writes need approval.";

const HTTPS_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Any MCP server",
  description: DESCRIPTION,
};

// Offered only with MCP_ALLOW_INSECURE, so its title has to tell it apart from the https entry.
const HTTP_RESOURCE: SupportedResource = {
  ...HTTPS_RESOURCE,
  urlPattern: "http://*",
  title: "Any MCP server (http, local development only)",
};

export function mcpResources(allowInsecure: boolean): SupportedResource[] {
  return allowInsecure ? [HTTPS_RESOURCE, HTTP_RESOURCE] : [HTTPS_RESOURCE];
}

export function mcpResourceFor(endpoint: string): SupportedResource {
  return new URL(endpoint).protocol === "http:" ? HTTP_RESOURCE : HTTPS_RESOURCE;
}
