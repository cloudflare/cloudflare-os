// What the Workshop shares with the Web Search gatekeeper beyond the generic gatekeeper contract.
//
// A deployment admin chooses where web searches run with one of that gatekeeper's settings (see
// VendorDescription.adminSettings). The gatekeeper runs every option but one. Under that one, an
// agent's model searches with its provider's own tool, inside the model request, which only the
// Workshop can arrange (see AiModelConfig.webSearch). So the Workshop reads this setting itself,
// by the names below, and the gatekeeper declares it with them.

/** The Web Search gatekeeper's vendor id: its binding's name, GATEKEEPER_WEBSEARCH, lowercased. */
export const WEB_SEARCH_VENDOR_ID = "websearch";

/** The id of the Web Search gatekeeper's setting that says where searches run. */
export const WEB_SEARCH_PROVIDER_SETTING = "provider";

/**
 * The value of WEB_SEARCH_PROVIDER_SETTING under which an agent's model searches with its
 * provider's own tool. The gatekeeper must declare another value as the setting's default: the
 * Workshop takes a deployment that has stored no choice as one that does not search in the model.
 */
export const WEB_SEARCH_IN_MODEL = "model";
