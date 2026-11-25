# Web Search

Web Search — an auto-provisioned gatekeeper whose account provides an ambient `WEB_SEARCH` singleton.
The README is the design record.

- It searches the public web through its own Workers AI binding (`websearch()`, through the AI
  Gateway its `CF_AI_GATEWAY` var names). The deploy service sets that var to the instance's
  gateway, the backend's; anywhere else it defaults to the account's `default` gateway.
- A deployment admin chooses where searches run with two settings that `describe()` declares
  (`VendorDescription.adminSettings`, in `search.ts`). The Workshop stores the choices, and a
  session reads them once for each search (`ApprovalQueue.getAdminSettings()`):
  - **Search provider**: Ceramic (default), Linkup, Exa, or "The model's provider"
    (`WEB_SEARCH_IN_MODEL`). Under "The model's provider", the Workshop puts the provider's own
    search tool in an agent's model request, on Anthropic and OpenAI models, and this gatekeeper
    runs only the searches that still come through `WEB_SEARCH`, with the Fallback search
    provider.
  - **Fallback search provider**: None (default), Ceramic, Linkup or Exa. It applies only under
    "The model's provider". With None, a search throws an error that tells the caller what to
    do.
- The Search provider's default must never be `WEB_SEARCH_IN_MODEL`: the Workshop takes a
  deployment that has stored no choice as one that does not search in the model. A test pins it.
- A search fails closed. A stored value this version does not know is refused, never replaced
  by a default. A failed search is not sent to another provider: the Fallback search provider
  is not a retry.
- Each query is recorded as an observation *before* it is sent, and the record names the provider
  that receives it. A refusal for the settings comes before the record. A workspace that has
  observed restricted data can still search: unlike a `webFetch` URL, the query can only go to
  the provider an admin chose, under that provider's data terms.
- Preinstalled on every deploy like Scheduled Tasks; every search spends the account's AI Gateway
  credits, outside the model spend limits, unless that gateway holds a key for the provider, which
  the provider then bills.
