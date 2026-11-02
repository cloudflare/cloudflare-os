# Web Search

Web Search — an auto-provisioned gatekeeper whose account provides an ambient `WEB_SEARCH` singleton.
The README is the design record.

- It searches the public web through its own Workers AI binding (`websearch()`, through the AI
  Gateway its `CF_AI_GATEWAY` var names, provider pinned to Ceramic). The deploy service sets that
  var to the instance's gateway, the backend's; anywhere else it defaults to the account's `default`
  gateway.
- Each query is recorded as an observation *before* it is sent. A workspace that has observed
  restricted data can still search: unlike a `webFetch` URL, the query can only go to the pinned
  provider.
- Preinstalled on every deploy like Scheduled Tasks; every search spends the account's AI Gateway
  credits, outside the model spend limits, unless that gateway holds a Ceramic key, which Ceramic then
  bills.
