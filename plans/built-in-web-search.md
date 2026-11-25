# Web search: one provider setting, and built-in search in the agent's turn

The design record for PR #1274. The measurements it cites are at the end. They were run on
2026-11-24 on `claude-haiku-5-5` and `gpt-6-luna`, through the route the agent uses in gateway
mode. Samples are small: one model for each provider and 1 to 4 runs for each row.

## Goal

A deployment's admin chooses, in one place, where web searches run: on Cloudflare's Web Search
API with Ceramic, Linkup or Exa, or in the agent's own model. With the last, an agent whose chat
model is an Anthropic or OpenAI model searches with the provider's own search tool, inside its model
request. A review of #1274 asked for that, in place of the second model request that PR's first
design made for each search.

## What the measurements say

| Question | Result |
|---|---|
| How long does a search hold the turn? | Anthropic 0.9 to 1.6 s. OpenAI 1.8 to 3.5 s. The first design's second request took 10 to 18 s and 6 to 13 s. |
| Can we add the tool and leave pi alone? | No. pi 1.6.0 drops the search blocks. With thinking on, the user's next message then fails: 400 "`thinking` ... blocks in the latest assistant message cannot be modified" (run a4). Where it does not fail, the model searches again and is billed again (a1, a2). |
| Does sending Anthropic's response back unchanged work? | Yes, 200 in all 4 cases. |
| Does OpenAI need the same? | No. Its response holds the queries only (0.5 to 5.3 KB), and 5 replays without the search items returned 200. Its results end with the response that ran the search. |
| What does a search add to a Claude chat? | 12,500 to 14,700 input tokens and 24 to 35 KB for 10 results. |
| What is billed? | On Claude, the input summed over the provider's internal steps, so a response re-reads its earlier results at each step. Five searches one after another billed 203,297 input tokens (p3). The $0.01 search fee is extra, and AI Gateway's logged cost leaves it out. |
| Is `usage` still the chat's size? | No. Anthropic reported 713,421 input tokens for a chat that held 136,881 (p2). OpenAI's count holds the results a search read, which the chat does not keep: 167,508 for a prompt of about 154,500 (w1). |
| What else goes wrong? | A search with no result yet, followed by anything but tool results: 400 (p2, p4, and Anthropic's docs). A request with `max_output_tokens: 16`, the cache-warm resend, starts a search on OpenAI (4 of 4). |

## Decisions

Each names the alternative we reject and why.

1. **The provider's tool goes in the request. The agent's tool list does not change.**
   - Anthropic Messages: `{type: "web_search_20250305", name: "web_search", max_uses: 5}`. Only this
     version: later ones run code at the provider and are not eligible for zero data retention.
   - OpenAI Responses: `{type: "web_search", external_web_access: false}` and `max_tool_calls: 5`.
     Never `web_search_preview`, which ignores `external_web_access`. Cache-only means OpenAI
     fetches no live page for the agent, so a live page is read only under the workspace's fetch
     policy (`docs/unified-fetch.md`). The model
     can still open a page from OpenAI's cache (an `open_page` call, in 1 of 3 captures of the
     built code on 2026-11-24), and that is recorded too. A request whose `reasoning.effort` is
     `minimal` does not carry the tool: OpenAI refuses the two together (g1). Such a chat
     searches as one with no tool does.
   Rejected: a Workshop tool that asks the provider in a second request (the first design).

2. **One setting says where searches run.** Admin → Gatekeepers → Web Search → **Search
   provider**, a select:

   | Option | Searches run |
   |---|---|
   | Ceramic (default), Linkup, Exa | On Cloudflare's Web Search API with that provider, through the `WEB_SEARCH` binding, for agents and gadgets. No model request carries a search tool. |
   | The model's provider | In the agent's model request, with Anthropic's or OpenAI's own tool, on every Anthropic and OpenAI model the deployment runs on AI Gateway. |

   With "The model's provider", a second select shows: **Fallback search provider**, which is
   None (default), Ceramic, Linkup or Exa. It serves every search that cannot run in a model
   request, through `WEB_SEARCH`:
   - a gadget's, and those of code an agent runs, on any model;
   - an agent's on Auto, Gemini, Workers AI or a user's own model;
   - every chat's in a workspace whose owner pays through their own Cloudflare account;
   - those of a workspace that holds restricted data;
   - every search, on a deployment that runs no models on AI Gateway.

   With None, those searches fail, and the error tells the caller so and names the setting.
   The Fallback search provider is not a retry. A search that fails in a model, or at Ceramic,
   goes nowhere else, and a fallback search that fails is a failed search.

   The Web Search gatekeeper declares both settings, and the Workshop stores them:
   - `VendorDescription.adminSettings`: each setting is one choice from a list
     (`GatekeeperAdminSetting`: `id`, `label`, `help`, `options` of `{value, label}`,
     `defaultValue`, and `shownWhen: {settingId, value}` for a setting the panel shows only
     under one value of another).
   - `AdminApi.setGatekeeperSetting(vendorId, settingId, value)` refuses a vendor that is not
     installed, a setting the vendor does not declare and a value that is not one of its
     options. It then records and stores the choice through the one writer of the admin config.
     Choosing the default stores nothing.
   - `ApprovalQueue.getAdminSettings()`: a gatekeeper session reads what the admin stored for
     its own vendor, as one map. The gatekeeper applies its own defaults.
   - `AdminResourceVendor.settings`: each setting with the value in effect, for the admin panel.

   `shownWhen` hides a select and nothing more. A hidden setting keeps its stored value, saving
   one setting never changes another, and the Workshop checks a value against that setting's
   options only. So a fallback chosen earlier applies again when the admin returns to "The
   model's provider". The selects show in every mode of Web Search (disabled, optional, enabled).

   A stored value that the vendor no longer offers, after a rollback for example, is kept and
   never replaced by the default: the gatekeeper refuses to search with it, and the panel shows
   it until the admin chooses again. A default would send queries to a provider nobody chose.

   The Workshop reads one of these values itself. `GatewayModels.runConfig()` sets
   `AiModelConfig.webSearch` on an Anthropic or OpenAI gateway model while Web Search's stored
   provider is "The model's provider". Nothing stored means it is not, so the gatekeeper's
   default must be another option, and a test pins that. The vendor, the setting and the value
   are three constants in `workshop-shared`, which the gatekeeper declares its setting with.
   The backend already names one gatekeeper, Cloudflare's, for billing (`CLOUDFLARE_VENDOR_ID`
   in `user.ts`). A user cannot set `AiModelConfig.webSearch` on a model of their own:
   `RedactedAiModelConfig` omits it and `user.ts` drops it, as both do for `reasoning`. A record
   stored before that can hold the field, so `user.ts` also drops it when it resolves a stored
   model for a chat or a quick task.

   Both model Tests send the tool while the setting says so: the Test of a model in the list,
   and the Test before a model is added. They read the saved setting at once. A chat reads it
   from the KV copy of the admin settings, so a change reaches new turns within about a minute,
   and a running turn keeps what it started with. So an admin tests the deployment's Anthropic
   and OpenAI models right after choosing "The model's provider": a provider account that has
   web search off refuses every request that carries the tool, and a Test covers one model.

   Rejected: a setting on each model (this PR's second design). An admin with many models sets
   each one.
   Rejected: a text field that the gatekeeper validates (the first design's
   `validateAdminSetting()`). With a fixed list the Workshop checks the value, and the admin
   picks from a select.
   Rejected: a setting the Workshop owns. The Workshop would name the Web Search API's
   providers, which are the gatekeeper's to know.
   Rejected: one select with an option for each pair, "The model's provider, then Linkup" and
   so on. It needs no `shownWhen`, but the Workshop would then know four of the gatekeeper's
   values in place of one, and the fallback stops being its own setting.
   Rejected: "The model's provider" by default. A provider account can refuse the tool, and a
   search costs more there (see Risks).
   Rejected: a second fallback. The admin names one, and nothing follows it.

3. **Declared on an agent's turn only, in a chat that holds Web Search, in a workspace that
   holds no restricted data.** The agent asks for it on each request: `ModelStreamOptions` gains
   `webSearch`, beside `thinking`, and one `AgentHooks` method says whether the chat may
   search in the model. It has to be asked for, because other requests stream on the turn's
   handle. The summary a non-Anthropic model writes for compaction (`completeText` in
   `runAgentPass`) does not ask. The Anthropic compaction request does: it must be the request a
   turn would send (see `anthropic-compaction.ts`), or the chat's largest prompt misses the
   cache. `ai-models.ts` adds the tool with its other per-API request rewrites, and not on a
   user's own Cloudflare gateway: that route is billed to credits, which is not measured.
   A cache-warm resend repeats a request built earlier, with the tool it declared. It cannot
   search (decision 9), and its prompt is older than the restriction.
   - **Web Search is the capability, for each chat.** A chat searches in the model only while
     it holds a binding to the Web Search gatekeeper's ambient record, that record is usable,
     and the Web Search Worker is installed. A workspace's record is not enough: a
     gadget-spawned agent holds only the bindings its spawner gave it. So:
     - the admin's mode for Web Search (disabled, optional, enabled) and the workspace owner's
       own choice under "optional" cover both ways to search;
     - a spawned agent searches in the model only if its spawner gave it Web Search;
     - uninstalling the Web Search Worker stops both ways.

     The provider setting only says who runs the search.
   - **A restricted workspace does not get the tool.** Its searches go through `WEB_SEARCH`, to
     the fallback provider if one is set: recorded before they leave, as a gatekeeper's are,
     and under that provider's data terms. Exa keeps a query that is billed to credits. An admin
     who names Exa trusts it with restricted text, as with a host in `restrictedWebFetchHosts`.
   Rejected: search in the model for restricted workspaces. The numbers for it exist (the
   provider fetched a canary URL in 0 of 6 and 0 of 8 queries), but it is a new rule, and the
   kernel's owner makes it.

4. **A search is an observation, and nothing else.** When the provider's answer to a search
   arrives in the stream, the agent calls `recordProviderObservation()`, which writes the record a
   fetch by the workspace gets: the provider, the queries, the results' titles and URLs, or the
   error. That one record
   is both:
   - the Activity entry;
   - the chat's row for the search. Every observation already gets one ("Read ..." with a
     magnifying glass), the `WEB_SEARCH` binding's included, so both kinds of search look alike.
   The provider runs the search before we see the query, so it cannot be recorded first.
   A page GPT opens from OpenAI's cache (`open_page`, `find_in_page`) is recorded the same way,
   with its URL, and is not billed. So is a call that ends `failed` or `incomplete`, with its
   status.
   Only a response to a request that declared the tool is read for searches. The wrapper reads
   that from the request as it was sent. A user's own endpoint can send search events for a
   request with no tool, and those are not recorded, charged or kept.
   The fee comes from the same response: `addChatMessages()` adds $0.01 for each search the
   provider billed. That is Anthropic's `usage.server_tool_use.web_search_requests`, and OpenAI's
   `tool_usage.web_search.num_requests`, or its completed `search` calls where a response holds
   no such count.
   A search that the provider started and whose result never arrived is not recorded: Stop, or a
   broken stream, in the second or so that the search runs.
   If the response fails after a search, the Activity record stays. Its chat row comes with the
   next step that commits, and a restart before that loses the row, not the record. A failed
   response adds no cost today, and its search fee follows that.
   Rejected: a `webSearch` kind of `AiToolCall`. It needs six `switch` statements in
   `ChatInterface.tsx`, and two places that read `toolCalls` as "calls we ran" would have to skip
   it: the replay loop and `#decisionWait`.
   Limits: no row shows while the search runs (1 to 3.5 s), and the row lands with the step's
   other observations, after the response's text. If that reads badly in the real chat, taking
   the step's observations when the model's stream ends puts it before the text.

5. **A Claude answer ends with its sources.** In the committed message, one line after the
   answer links each page it cites, by its host. GPT writes such links itself: in the captured
   response, each `url_citation` annotation covers a Markdown link in the text. Both providers
   require clickable citations.
   Rejected: a link after each cited passage. A passage can end inside a code block or after a
   table row's last cell, where a link is not a link, and placing it right needs a Markdown
   parser.

6. **pi stays as released, and for Claude we keep what it drops.** pi's author declined
   provider-run tools (earendil-works/pi#1740, 2026-03-03, "I do not want to support this").
   A wrapper around the turn's stream reads each response's content from `onProviderStreamEvent`.
   Before a request it puts a marker in each kept message of the transcript it hands to pi, and in
   `onPayload` it replaces each marked message's content with the kept content. A marker that is
   left fails the request. `anthropic-compaction.ts` does all of this today for the compaction
   block.
   - **Whole.** The kept content replaces the whole message, so nothing depends on how pi writes
     a block.
   - **Stored in the step's snapshot.** `StoredAssistantMessage` gains `providerContent?: string`,
     written only when the response holds a finished search. Client tool inputs are left out, as
     `StoredToolCall` leaves them out, and come back from the block pi wrote for that call.
   - **For the model that produced it** (pi's rule in `transformMessages`). Another model gets
     pi's form, which has no thinking blocks.
   - **Always sent back**, whatever the setting or the workspace is now. Without it the next
     request fails as a4 did.
   - **Never with an unanswered search.** A response can end with one: beside a client tool call
     (a3), or when the provider pauses (p2, p4). Sent back, it fails unless tool results and
     nothing else follow, which a steer, an approval or Stop can break. So the wrapper drops it.
     Nothing is billed for it, and the model asks again if it still wants it (a3 without it, then
     the tool results: 200, searched again; p4 without it, then a user message: 200). Every kept
     message is then whole, and a paused turn ends there. Nothing the stream holds of such a
     search fails the response. A response that finished one search and hit its output cap in
     the query of the next is kept, with the finished search.
   Rejected: a patch or fork of pi (nine or more releases in the seven weeks since 1.0.0).
   Rejected: finding the message by its content (two answers can share their text).

7. **A response that searched does not report the chat's size.** `finishTurn` and
   `meta.totalTokens` read `usage.totalTokens`, and such a count would compact a chat with room
   left. Such a response counts as unmeasured, and the estimate that already covers unmeasured
   chats takes over until the next response that ran no search. For that estimate, kept content
   weighs its bytes divided by 2 (5 samples: 2% under to 25% over). The `usage` pi reports is not
   changed, because it is what the provider bills. Kept content goes back to the model that
   produced it and to no other. So a size that another model measured is too small for the model
   that is sent the content, and too large for a model that is not. A pass after a model switch
   counts as unmeasured while a stored reply of the chat holds kept content.
   Cost: a response that searched and also called a tool reloads the pass, as an unmeasured one
   does today. On Claude that is at most five times in a user turn. A turn that ends on a
   response that searched is not cache-warmed, as an unmeasured one is not.
   Rejected: a formula for each provider.

8. **Five searches.** Anthropic documents `max_uses` as a cap for one turn, which lasts while each
   request ends in tool results only. That is not measured with pi's requests, which end in a
   system message, so the cap may apply to each request. OpenAI's `max_tool_calls` counts in one
   response. With the cap, Claude stopped and said what it had not searched (p3), and the API did
   not pause.

9. **A cache-warm resend must not search.** `cappedForResend()` adds `tool_choice: "none"` on
   OpenAI: no search started in 3 of 3, and the cache was still read. Anthropic's 1-token resend
   ran no search in 3 of 3.

10. **The Web Search gatekeeper searches with the provider the admin chose.** It declares the two
    settings of decision 2 and reads the stored map once for each search. Ceramic, Linkup and
    Exa are the same call to Cloudflare's Web Search API with another name. Under "The model's
    provider" it searches with the fallback provider. With no fallback it refuses before it
    records or sends anything. That error is written for the caller: use the model's own search
    tool if it has one, a gadget cannot search on this deployment, and an admin can set a
    fallback under Web Search. A stored value it does not know is refused the same way. The
    query is recorded before it is sent, as today, and the record names the provider that
    receives it. A change reaches open sessions within about a minute, the lag of the KV copy.
    The first design's second model request, with its `anthropic/<model>` and `openai/<model>`
    values, is dropped.

## What changes

The kernel change has three parts. GPT needs only the first two.

| Part | Holds |
|---|---|
| A: gatekeeper settings | Decision 2. `workshop-shared`: `GatekeeperAdminSetting`, `VendorDescription.adminSettings`, `AdminApi.setGatekeeperSetting()`, `AdminResourceVendor.settings`, `ApprovalQueue.getAdminSettings()`, and the three names of the Web Search choice. `workshop-backend`: `AdminConfig.gatekeeperSettings` and its helpers in `admin-config.ts`, the setter and the admin view in `admin-settings.ts`, the queue's getter in `overseer.ts`. |
| B: the tool, on GPT | Decisions 1, 3, 4 and 7 to 9. `workshop-shared`: `AiModelConfig.webSearch`, and the omit in `RedactedAiModelConfig`. `workshop-backend`: new `built-in-search.ts` (the stream wrapper: it reports each search and the billed count), `ai-models.ts`, `ai-gateway.ts`, `agent.ts`, `overseer.ts`, and a few lines each in `user.ts`, `ai-invoke.ts`. |
| C: Claude | Decisions 5 and 6. `built-in-search.ts` keeps and sends back. `overseer-storage.ts`: the field. `agent-compaction.ts`: the weight. `agent.ts`: the sources line. |

`gatekeeper-websearch`: decision 10. `workshop-frontend`: the settings' selects under a
gatekeeper's entry in the admin panel.

One new admin RPC method and one new queue method. No new agent tool, chat message or tool-call
kind, and no chat UI change.

Docs: `docs/observers.md`, `docs/public-server.md`, `docs/unified-fetch.md`,
`docs/admin-access.md`, the backend's `AGENTS.md`, and the README, notes, diagrams and vendor
description of `gatekeeper-websearch`.

## What does not change

- The `WEB_SEARCH` binding's interface, its admin modes, and Ceramic as the default provider.
- The pi version, the agent loop, the agent's own tools, `webFetch`.
- What a restricted workspace may do, apart from where its searches go (decision 3).
- A model's own settings: no model has a search setting.

## Verification

- **Red first.** With the tool added and nothing else, a scripted Claude turn that thinks,
  searches and answers fails on the next message, as a4 did. Each decision's test fails without
  its code.
- **pi's real adapter with a fake `fetch`.** The probe responses a2, a3, a4 and p2 as fixtures:
  the next request's body holds the kept content byte for byte, and no unanswered search. This
  test fails first if a pi release changes how it writes a message.
- **Integration harness, scripted model.** The chat's observation message with the step; the
  Activity record also when the response fails after the search. The cost. No compaction after a search
  in a large chat. No tool once the workspace is restricted, or with the setting off, and the
  kept content still sent. A steer, an approval and Stop after a search beside a tool call. A
  model switch mid-chat.
- **On the PR's preview, real gateway.** Claude and GPT: a search then a follow-up; a search and
  a tool call in one step, forced as in a3; a restricted workspace; a cache-warm resend; an
  Anthropic compaction of a chat that searched.
- **The UI**, at full size, light and dark, desktop and phone: a search's row in the chat, closed
  and open, with an error, and beside a `webFetch` row; the two selects under Web Search, with
  the fallback shown and hidden, and a refused save.
- **Before more models are documented as run:** one request with the tool to each suggested
  Anthropic and OpenAI model. These spend on Opus and Sonnet class models, so they need an OK
  first. The README's Known limits names the two models that were run.
- **Before a user's own gateway gets the tool:** one request on a gateway billed to credits. No
  account we could reach on 2026-11-23 had credits.
- **Before Linkup and Exa are documented as supported:** one search with each, on an account
  with credits.

## Rollback

- A release from before this setting sends every `WEB_SEARCH` search to Ceramic, and no model
  request carries a search tool, whatever is stored. So an admin who chose "The model's
  provider" with no fallback, to keep queries from Ceramic, Linkup and Exa, gets Ceramic.
- Its backend drops the stored choices the next time an admin changes any setting, so after
  the next upgrade searches go to Ceramic until the admin chooses again. The admin panel shows
  the settings only while the Web Search Worker is installed. The README gives the order that
  keeps queries from Ceramic: Disabled, uninstall, roll back, upgrade, install, choose.
- A Web Search Worker with these settings asks the Workshop for the stored choices on each
  search. A Workshop from before them has no such method, so the search fails (not run). The
  Workshop is upgraded before the Worker, or with it.
- A Claude reply that searched in the model is stored with its kept content. A release without
  decision 6 sends pi's form of it, and the next message can fail as a4 did.

## Risks and what is not measured

- **Cost on Claude is higher than the first design, not lower.** On a $2 per million chat model:

  | | Built-in search | First design |
  |---|---|---|
  | One search | $0.01 fee + about $0.026 of input, then a cache write of about $0.03 | $0.01 fee + $0.002 of Haiku |
  | Five searches one after another | $0.05 in fees + $0.41 of input (p3) | $0.05 in fees + $0.01 of Haiku |

  On a model that costs twice as much, the input part doubles. The first design's results also
  entered the chat model's context, as text; that part is not measured. Built-in search is faster:
  about 1 s against 10 to 18 s.
- **GPT pays for the tool on every request**: about 4,470 input tokens, cached after the first.
- **On GPT, results end with the response.** After a client tool call the model searched again
  (o1). Not solved here.
- **An agent can have both search paths** when a fallback is set: the built-in tool and the
  `WEB_SEARCH` binding. Nothing tells it which to use.
- **With no fallback, every chat is still told about `WEB_SEARCH`**, and each call fails. The
  catalog is built with no session, so it cannot read the setting. The error is written for the
  agent (decision 10).
- **"The model's provider" is all or nothing.** It turns the tool on for every Anthropic and
  OpenAI gateway model at once: the most expensive, where a search costs the most, and a hidden
  model that an old chat still uses. A provider account that has web search off then refuses
  every request that carries the tool, so each such chat fails on every message, also when it
  does not search. If one provider accepts the tool and the other refuses it, the only fix is
  another Search provider.
- **Auto does not search in the model.** Auto is the default model for new chats while its
  provider is on, so on such a deployment most searches go to the fallback.
- **After the Web Search Worker is uninstalled, the model Tests still send the tool** while
  "The model's provider" is stored, though no chat does: the per-chat gate checks the Worker, and
  the Tests read the stored choice alone. The Gatekeepers panel lists installed gatekeepers only,
  so the choice cannot be changed until the Worker is installed again.
- **The Workshop reads one gatekeeper's setting**, by three names it shares with that gatekeeper.
- **Linkup and Exa were not run live.** `websearch()` returned 402 for lack of credits on every
  account tried on 2026-11-23, and 502 with Ceramic on the dev account on 2026-11-25.
- **The query guidance is Ceramic's**: keywords in Latin script and no question, under Linkup
  and Exa too. The gatekeeper writes that text with no session, so it cannot know the provider.
- **Linkup's licensed sources.** For an organization Linkup has authorized, Linkup adds licensed
  publisher content to its results. Web Search treats every result as public.
- **On a public deployment with spend limits**, free users run on the platform's gateway and get
  the tool, at the platform's cost: five searches a request at most, and the daily allowance
  counts turns. A workspace whose owner pays through their own Cloudflare account gets no tool.
  Its searches go to the fallback, billed to the deployment, or fail.
  `docs/public-server.md` says both.
- **A gateway with no key for the provider** runs the model on Cloudflare credits, unless the
  gateway requires provider credentials. Whether a request on credits may carry the tool is not
  measured. The model's Test shows it.
- **The marker and the capture** depend on pi's hooks and on Anthropic's stream shapes.
- **Not measured:** Opus, Sonnet and GPT-6.2; reasoning models that open pages; a gateway billed
  to credits, which is also every user who pays through their own Cloudflare account; what
  OpenAI leaves out of a search above its 128,000-token search window (a request of about
  154,500 tokens searched and answered, w1); a pass reload's cost; a reasoning level that pi
  sends to OpenAI as an input item in place of `reasoning.effort`, which the check for
  `minimal` does not read (no suggested model lists Minimal). The canary runs were the first
  design's one-search requests, not searches inside a turn.

## Decisions a reviewer may overrule

- The cost table above: Ceramic is the default because of it.
- Decision 4: a query is recorded after it left.
- Decision 1's OpenAI mode: cache-only, and not OpenAI's default.

## Measurements

Throwaway Worker run with `wrangler dev` and the remote `AI` binding, in the account whose
gateway `gadgets` holds an Anthropic key and an OpenAI key. Requests went through the binding's
`fetch` to `https://workers-binding.ai/ai-gateway/gateways/gadgets/<provider>/...`, the route the
agent uses in gateway mode (`gatewayNativeModel` in `ai-models.ts`). Models: `claude-haiku-5-5` (adaptive
thinking), `gpt-6-luna` (Responses API, `store: false`, `include: ["reasoning.encrypted_content"]`).
"Lossy" is what pi 1.6.0 sends back: Anthropic `text`, `thinking`, `tool_use` only, no citations;
OpenAI `reasoning`, `message`, `function_call` only, `annotations: []`.

### Anthropic, `web_search_20250305`, max_uses 3

| Run | Response | Total | Search pause | Summed `input_tokens` | First prompt | Raw content |
|---|---|---|---|---|---|---|
| a1 search then client tool, effort default | server_tool_use, web_search_tool_result, tool_use; stop `tool_use` | 2.4 s | 1.2 s | 17,665 | 2,937 | 30.6 KB |
| a2 same, effort high | thinking, server_tool_use, web_search_tool_result, tool_use; stop `tool_use` | 2.8 s | 1.6 s | 15,454 | 2,937 | 24.5 KB |
| a4 plain search turn, effort high | thinking, server_tool_use, web_search_tool_result, thinking, 5 text (2 cited); stop `end_turn` | 4.6 s | 0.9 s | 17,547 | 2,923 | 35.0 KB |
| a3 search and client tool in one step | thinking, tool_use, server_tool_use (no result); stop `tool_use`; no search billed | 1.1 s | n/a | 2,935 | 2,935 | 1.3 KB |

Replays of the turn (next request):

| Run | Raw content sent back | Lossy (pi 1.6.0) | Raw, tool not declared |
|---|---|---|---|
| a1 | 200, answers, no new search | 200, searches again (1 more billed search, 5.7 s vs 2.9 s) | 200 |
| a2 | 200, no new search | 200, searches again (5.3 s vs 3.2 s) | 200 |
| a4 | 200 | **400** "`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified" | 200 |
| a3 | 200; the pending search runs at the start of this request, and its `web_search_tool_result` is the first block of this response | 200, searches again | **400** "`web_search` tool use ... found without a corresponding `web_search_tool_result` block, but no `web_search` tool was provided" |

Other facts:
- `usage.input_tokens` is the sum over the response's server-side iterations: a2 15,454 = 2,937
  (`message_start.usage`) + 12,517. The next request's prompt was 12,562. No `usage.iterations`.
- One search of 10 results adds about 12,500 to 14,700 input tokens to the context.
- `usage.server_tool_use.web_search_requests` counts billed searches.
- A request with `max_tokens: 1` (the cache-warm resend shape) ran no search (3 of 3).
- AI Gateway's log `cost` is tokens only: a2 $0.00161 for 15,454 in and 131 out. The $0.01 per
  search is not in it.

### Anthropic, long turns (a request for 12 searches)

| Run | Searches | Stop | Total | Summed `input_tokens` | Real context after | Raw content |
|---|---|---|---|---|---|---|
| p1 no cap, model searched all 12 in one step | 12 | `end_turn` | 15.6 s | 151,987 | about 149,000 | 366 KB |
| p2 no cap, one search at a time | 10, an 11th pending | `pause_turn` | 21.4 s | 713,421 | 136,881 | 292 KB |
| p4 same as p2 | 10, an 11th pending | `pause_turn` | 24.3 s | 692,957 | 133,268 | 298 KB |
| p3 `max_uses: 5`, one at a time | 5, then the model stopped and said which it had not searched | `end_turn` | 16.5 s | 203,297 | about 68,000 | 155 KB |

After a `pause_turn` (p2, p4), whose content ends in a `server_tool_use` with no result:
- Paused assistant message sent back as the last message: 200, runs the pending search (2 of 2).
- Paused message, then a user text message: **400** "`web_search` tool use ... found without a
  corresponding `web_search_tool_result` block" (2 of 2).
- Paused message without its last, unanswered `server_tool_use`, then a user text message: 200
  (p4, 1 of 1), though the message holds thinking blocks.

Kept content against the tokens it added (summed input minus the prompts before it):

| Run | Content | Tokens added | Bytes / 2 | Against tokens |
|---|---|---|---|---|
| a1 | 30,552 B | 14,728 | 15,276 | 4% over |
| a2 | 24,479 B | 12,517 | 12,240 | 2% under |
| a4 | 34,954 B | 14,624 | 17,477 | 20% over |
| p1 | 365,700 B | 146,131 | 182,850 | 25% over |
| p2 | 291,642 B | 133,914 | 145,821 | 9% over |

### OpenAI, `web_search`

| Run | Output items | Total | Search | Raw output |
|---|---|---|---|---|
| o1 search then client tool, live | web_search_call, function_call | 5.9 s | 3.5 s | 0.5 KB |
| o2 plain, live | web_search_call, message (1 annotation, inline link in the text) | 3.6 s | 1.8 s | 0.9 KB |
| o3 plain, live, effort high (2 runs) | web_search_call, reasoning, web_search_call, (reasoning,) message | 10.3 s, 5.2 s | | 5.3 KB, 3.3 KB |
| o4 plain, `external_web_access: false` | web_search_call ×2, message (1 annotation) | 8.3 s | 2.8 s, 2.1 s | |

- Search results are not in the output: the `web_search_call` item holds the queries only.
- Replays: raw and lossy both 200 in every run (5 lossy replays, including two where a reasoning
  item sat between search calls). In o1 the model searched again in both.
- Declaring the tool costs about 4,470 input tokens a request (cached after the first). A request
  without the tool had 146 to 185 input tokens.
- A request with `max_output_tokens: 16` (the cache-warm resend shape) started a
  `web_search_call` (status `incomplete`) in 4 of 4 runs. With `tool_choice: "none"` added it
  started none (3 of 3) and still read the cache (4,418 of 4,490 cached tokens).
- `usage` has no count of searches. The response's `tool_usage.web_search.num_requests` counts
  the searches OpenAI charges for (1 in both captured streams). AI Gateway's log `cost` is tokens
  only.
- `usage.input_tokens`: o1 8,728 (1 search), o2 8,447 (1 search), o4 12,721 (2 searches), for a
  prompt of about 4,620 with the tool. w1 (2026-11-25): 167,508 with 1 search, for a prompt of
  about 154,500. So the count is the prompt plus what each search read (about 4,000 to 13,000
  tokens), and not the prompt once for each internal step.

### Follow-ups the review bots asked about, 2026-11-25 (1 run each, unless it says otherwise)

- **A Claude follow-up that cites an earlier search and runs none** (`thinking`, `text` with one
  citation). The next request returned 200 in each form: both responses as sent; the follow-up
  in pi's form, without its citation (what the code sends, since it keeps a response only when
  it ran a search); the follow-up as sent after the search it cites had left the transcript;
  and both as sent with the tool not declared.
- **w1, OpenAI above 128,000 tokens.** A request of about 154,500 tokens that declared the tool
  completed, ran one search and answered from it.
- **A reply that searched, sent back without its thinking** (2 runs). The next request returned
  200 with the reply as sent, as sent without its thinking, and in pi's form without its
  thinking. No code drops a reply's thinking today: the pass that did left main on 2026-11-25.
- **g1, OpenAI at the effort `minimal`** (the admin's Test of `gpt-5` before it is added, through
  the gateway, with the tool). "No level set", Low, Medium and High answered. Minimal returned
  400: "The following tools cannot be used with reasoning.effort 'minimal': web_search." With
  the tool left off at that effort, all five answered. `gpt-6-luna` answered with the tool at
  Off and at Low.

### Cost, from the logged costs and token counts

- The summed input is what is billed: a2's logged cost, $0.0016109, is 15,454 × $0.10 per
  million plus 131 × $0.50 per million (Haiku 5.5). a4's was $0.0020762.
- So one search inside a response re-reads its results in every later step of that response.
  On a $2 per million chat model (Sonnet 5.5 in pi's catalog): one search adds about 13,000
  tokens, $0.026, plus the $0.01 fee. Five searches one after another (p3) billed 203,297 input
  tokens, $0.41, plus $0.05 in fees.
- The first design's request for one search: the $0.01 fee plus a Haiku request like a2 or a4, $0.0016 to
  $0.0021.

### From the 2026-11-23 runs (same gateway)

- The first design's second request: 10 to 18 s per search on Anthropic, 6 to 13 s on OpenAI.
- Canary URL named in the query: OpenAI live 2 of 2 fetched it; OpenAI cache-only 0 of 8;
  Anthropic 0 of 6.
