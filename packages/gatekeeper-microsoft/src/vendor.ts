// The constants a module may need while it loads: the vendor id and where Microsoft Graph is. This
// file imports nothing, so reading them is safe whatever order the modules that import each other
// load in.

/** The vendor id: the router's `/gatekeeper/microsoft/` path segment, and the log attribution. */
export const VENDOR_ID = "microsoft";

/** Where every API request goes. */
export const GRAPH_ORIGIN = "https://graph.microsoft.com";
/** The Graph version this gatekeeper speaks. */
export const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
