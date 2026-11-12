import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

const DESCRIPTION =
  "An MCP endpoint you supply. Tools are discovered automatically, and writes need approval.";

const HTTPS_RESOURCE: SupportedResource = {
  id: "https-server",
  urlPattern: "https://*",
  title: "Any MCP server",
  description: DESCRIPTION,
};

const HTTP_RESOURCE: SupportedResource = { ...HTTPS_RESOURCE, id: "http-server", urlPattern: "http://*" };

export function mcpResources(allowInsecure: boolean): SupportedResource[] {
  return allowInsecure ? [HTTPS_RESOURCE, HTTP_RESOURCE] : [HTTPS_RESOURCE];
}

export function mcpResourceFor(endpoint: string): SupportedResource {
  return new URL(endpoint).protocol === "http:" ? HTTP_RESOURCE : HTTPS_RESOURCE;
}
