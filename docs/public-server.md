# Running Gadgets as a public, multi-user service

By default the Workshop uses built-in username/password accounts (or Cloudflare Access) and gives
every user unlimited AI usage — ideal for self-hosting. It can optionally run as a public,
multi-user service instead: users sign in with Google, GitHub, or Cloudflare, every account gets a
free daily allowance of AI usage, and once that runs out they connect their own Cloudflare account
and top up credits in the Cloudflare dashboard (their account is then billed for further usage).

Sign-in is provided by **authentication gatekeepers**: each auth-capable gatekeeper (Google, GitHub,
Cloudflare) uses its single OAuth app both to authenticate the user (by verified email) and to
connect the account's capabilities. There's no single switch — the pieces turn on independently:

| Configure | Effect |
| --- | --- |
| `AUTH_GATEKEEPERS=cloudflare,google,github` | Allowlists which connected gatekeepers may be used to sign in. Each shows a "Continue with …" button alongside username/password. |
| Each gatekeeper's OAuth credentials (on the gatekeeper Worker) | Required for that gatekeeper to actually authenticate. In dev, seeded from `GOOGLE_*` / `GITHUB_*` / `CLOUDFLARE_OAUTH_*` shell vars (see `run-dev-server.ts`). |
| `ENABLE_CLOUDFLARE_LIMITS=true` | Enables the free daily limit + Cloudflare-credits top-up flow. Billing reads a token from the connected Cloudflare gatekeeper. |
| `DISABLE_PASSWORD_AUTH=true` | Hides username/password, leaving gatekeeper sign-in only (ignored unless `AUTH_GATEKEEPERS` is non-empty, to avoid lockout). |

The primary account key is always the user's **verified email**: signing in with any allowlisted
gatekeeper that yields the same verified email maps to the same account.

For local development, set the required variables in a root `.dev.vars` file (gitignored,
`KEY=VALUE` per line); `pnpm run dev-server` loads it automatically. A minimal example:

```
ENABLE_CLOUDFLARE_LIMITS=true
PUBLIC_BASE_URL=http://localhost:8787
AUTH_GATEKEEPERS=cloudflare,google,github

# Each gatekeeper's OAuth app (client id/secret). In dev these seed the gatekeeper Workers:
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
CLOUDFLARE_OAUTH_CLIENT_ID=...
CLOUDFLARE_OAUTH_CLIENT_SECRET=...

# Platform AI Gateway used for the free tier:
CF_AI_GATEWAY=your-gateway
# The providers that are always on. An admin can turn on others on the Models tab of /admin:
CF_AI_GATEWAY_PROVIDERS=anthropic,openai,google

# Required whenever CF_AI_GATEWAY is set:
CF_AI_GATEWAY_ACCOUNT_ID=...
# Required unless the WORKERS_AI binding carries gateway traffic (see below); always required
# for the google provider:
CF_AI_GATEWAY_API_TOKEN=...
```

Gateway mode always requires `CF_AI_GATEWAY_ACCOUNT_ID`, plus a transport for gateway requests.
When the `WORKERS_AI` binding is present, the binding is that transport by default: its requests
are pre-authenticated in-account, so inference and cost-log reads need no API token. This is only
valid when the Gateway lives in the Worker's **own** account — binding requests can't reach
another account's Gateway, and the Worker cannot verify where the Gateway lives at runtime — so
deployments whose Gateway is in a different account must set `CF_AI_GATEWAY_USE_BINDING=false` to
opt out and route over HTTPS instead. Keep `WORKERS_AI` bound when you do: it is also what the
webFetch tool's document-to-Markdown conversion runs on, so unbinding it opts out of far more than
the gateway transport. Without the binding transport, set
`CF_AI_GATEWAY_API_TOKEN` — a token with AI Gateway Run and Read permissions so Gadgets can
execute models and report their costs (over HTTPS the Gateway may live in the Worker's own
account or a different one). The token stays required for the `google` provider regardless of the
binding (the model SDK adapter refuses the binding's fetch — note the platform config above enables
it, so the platform server itself still needs the token). Every provider, Workers AI included,
routes through the same Gateway.

Which models the Gateway offers is not an environment setting: a deployment admin manages it on the
**Models** tab of `/admin`. The tab lists the catalog this version ships (`SUGGESTED_MODELS` in
`packages/workshop-shared/src/api.ts`) for the providers that are on, which are the ones in
`CF_AI_GATEWAY_PROVIDERS` and the ones an admin turned on in the tab's **Providers** section
(described below), plus the models the deployment added, and gives each model one of three modes:

| Mode | Model pickers | Chats and gadget model bindings that already use the model |
| --- | --- | --- |
| **Enabled** | Offered. | Work. |
| **Hidden** | Not offered. | Keep working. |
| **Disabled** | Not offered. | Stop working. |

A chat on a disabled model fails to send, start or retry with `The "<name>" model is disabled on
this deployment by an administrator.`, which the chat shows with the failure, and a gadget model
binding made for the model fails with the same error at its next call. A chat that an external
message continues does not fail: it moves to the user's preferred model if that is offered, and
otherwise to the first model offered. Disabling revokes nothing that is stored, so chats and
bindings work again once the model is enabled or hidden. A disabled model's ID stays reserved: a
user can't add a model of their own under it.

Each model starts in its default mode, which the tab marks `(default)`: the catalog's for a catalog
model (**Hidden** for the ones a newer model supersedes, otherwise **Enabled**) and **Enabled** for
an added one. Only a mode that differs from the default is stored. A model left on its default
therefore follows the catalog when the deployment is upgraded, and choosing the default option
again drops the override. The tab marks a model `Changed` while its mode differs from the default
or it has a setting of its own.

Each model's row has a **Settings** section, closed until it is selected, with two settings for
that model alone. A setting that is left alone is not stored.

**Reasoning level** is how much reasoning the model is asked for on the agent's turns: **Off**,
**Minimal**, **Low**, **Medium**, **High**, **Extra high** or **Max**. The list has **Deployment
default (…)** and then the levels the model takes. **Deployment default** clears the model's own
level, and its parentheses name what applies instead: the deployment's default level, as in
**Deployment default (High)**, or, while the deployment sets none, what the model is then asked
for, as in **Deployment default (built-in: Adaptive)**. The level in effect can be one the model
lacks, the deployment's default for instance. Each request is then sent the next higher level the
model has, or else the next lower one, so **Off** on a model that cannot stop reasoning asks for
its lowest level. The fit is made when a request is made, so the row says that a level is missing
without naming the one that is sent. A model that takes no levels is offered none and is sent
none. The level applies to the agent's main turns only: one-shot calls (chat titles, compaction
summaries and what a gadget's model binding asks) ask for no level either way.

**Default reasoning level**, above the list of modes, is the level of every listed model that has
none of its own. It starts as **Built-in**, which sets no level: each such model is then asked the
way the Workshop asks it by default, which is not the same for every model. A level a model lacks
is fitted as above. It never applies to a model a user added.

While the default is **Built-in**, the **Settings** of each model that takes levels name what the
model is asked for while it has no level of its own, in the first option of its **Reasoning level**
list. The option reads one of three ways:

- **Deployment default (built-in: Adaptive)**: the request turns adaptive thinking on, and the
  model decides whether and how much to reason. This is how the Claude models that take adaptive
  thinking are asked, which in this version's catalog is every Claude model but Claude Haiku 4.5.
- **Deployment default (built-in: Medium)**: the request asks for the effort `medium`. This is how
  the OpenAI models that reason are asked, which is every OpenAI model in this version's catalog.
- **Deployment default (built-in: no level sent)**: the request names no level, and the provider's
  default applies. This is how every other model is asked: Claude Haiku 4.5, the Gemini models and
  the Workers AI models.

An added model that the model runtime knows is asked as the runtime describes it, so an added
OpenAI model that does no reasoning is sent no level; it takes no levels either, so it is offered
none. An added model that the runtime does not know is asked as the model it behaves like, where
**Behaves like** (described below) names one the runtime knows, and otherwise as an unknown model
of its provider. An unknown Anthropic model is not taken for one that takes adaptive thinking, so
it is sent no level. An unknown OpenAI model is taken for one that reasons, so it is asked for the
effort `medium`. A Google or a Workers AI model is sent no level whatever it behaves like.

The option says what the Workshop asks for, not what the model runtime adds to the request or
what the provider then does with it. DeepSeek V4 Pro is sent no level, and the runtime's request
format for that model then turns its thinking off. A Claude model whose effort the runtime
manages, Claude Opus 5.5 for one, is asked with adaptive thinking, and the runtime adds the effort
`high`: the request is then the one the level **High** sends.

**Compaction budget** is the prompt size, in tokens, that a chat on the model compacts against: the
chat compacts once its prompt reaches 85% of the budget. Left blank, the model has its built-in
budget, which the field names, and **Reset** returns to it. A budget is a positive whole number, at
most the room the model's context window leaves for a prompt, which is the window less the space
reserved for the response. The tab refuses anything else, and so does the server, with `The
compaction budget of the "<name>" model must be a whole number of tokens from 1 to <maximum>.`
There is no lower bound: under 100,000 tokens the tab warns that a small budget makes a chat
compact very often, and saves it all the same. A budget can be raised only where the built-in one
is under that room, which in this version's catalog is the OpenAI models, whose built-in budget of
272000 is there to stay under OpenAI's long-context pricing. A model whose window leaves a prompt
no room has no budget field.

Each model's row also has a **Test** button, beside its modes and outside **Settings**, that finds
out whether the model answers the request its chats send. Above the lists the tab notes `Test sends
a model one request the way a chat turn would, with the reasoning level in effect for it, and shows
what came back. A test can use up to 2,048 output tokens.` The request goes to the model of the
row, as the admin who pressed the button, through the deployment's Gateway (also for an admin
whose own Cloudflare account pays for their chats):

- It asks for the reasoning level in effect for the model: the model's own, else the deployment's
  default, else what the model is asked for while neither sets one, as described above.
- An added model is asked in the request format of the model it behaves like, where **Behaves
  like** (described below) lends it one.
- The prompt is `Reply with OK.`, and the response is capped at 2,048 tokens, or at the model's own
  response cap where that is lower.
- It tells the Gateway not to answer from its cache (`cf-aig-skip-cache`), and waits up to 30
  seconds.

A test reads the settings as they are stored when it runs, and it changes none. It works on a model
in any mode, **Hidden** and **Disabled** included, so a model can be tried before it is enabled. A
model whose provider is off is not listed, so it has no **Test**: the provider's own **Test**
(described below) works on a provider that is off. Several models can be tested at once, and a test
does not hold up the rest of the tab. The result is shown in the row, above **Settings**:

- `Answered through the gateway.` when the model answered.
- `Failed (<status>): <message>` when the request failed and the model runtime reported the HTTP
  status of the response.
- `Failed: <message>` when it failed and no status was reported.
- `Couldn’t run the test: <reason>`, or `Couldn’t run the test.` with no reason to give, when the
  test could not be run at all.

The message and the status are what a provider's **Test** shows (described below): the message on
one line, cut at 300 characters, and no status for a failed Google request. A model that does not
answer in time gives `Failed: The model did not answer within 30 seconds.`, and a model of a
provider whose row has the token warning gives the refusal quoted below without sending a request.
The status is that of the response, so a request that fails after the gateway answered 200, while
the answer is streaming, shows as `Failed (200): <message>`. When the status is 401 or 403, the row
adds `The gateway may hold no key or credits for this provider, or CF_AI_GATEWAY_API_TOKEN may not
be allowed to run models.`, and as with a provider's **Test** it cannot tell the two apart.

The result stays in the row for as long as the tab stays open, until the model is tested again or
a change clears it. A change to the model, its mode or its settings, clears that model's result,
and a change to **Default reasoning level** clears every model's. A test that is still running
when such a change goes through keeps running, but its answer is not shown when it arrives; that
includes a test started while the change was being saved. Other changes on the tab leave the
results where they are, and none of this touches a provider's result.

A pass proves that the model answered that one request, once, with the settings stored at the
time. Any answer counts, since the test does not read what the model wrote. The request is one
short prompt in text with no tools, so a pass does not prove that tool calls, images or long
prompts work, or that a later request will. A Claude model that takes its reasoning level as a
token budget (Claude Haiku 4.5 in this version's catalog, and an added Anthropic model in the
older budget format described below) has the budget come out of the response cap, with 1,024
tokens of the cap left for the answer. Under the test's cap of 2,048 tokens every level but **Off**
is therefore sent as a budget of 1,024 tokens, which on Claude Haiku 4.5 is less than a chat sends
for every level above **Minimal**.

**Add a model**, under **Added by this deployment**, provides a model the catalog doesn't list. It
takes a provider (one that is on, of the ones AI Gateway serves: `anthropic`, `openai`, `google`
or `cloudflare`), the model ID as the provider's API names it, a display name, the context
window in tokens, and optionally an output limit — both the response cap and the space reserved
for it in the window (Workers AI models default to 32768). The ID and the name may each be up to
200 characters, and the ID must be one that neither the catalog, under any provider, nor another
added model has. An added model starts **Enabled**, takes the three modes like a catalog model, and
is listed in pickers after its provider's catalog models. Users can't edit or delete a model the
deployment provides, in any mode. **Remove** takes an added model out again, along with its mode
and settings, and a chat that names it then fails with `No such model: <id>` until a model is added
under that ID again; a catalog model can't be removed, only hidden or disabled. An added model whose
provider is off is neither offered nor listed on the tab, but it stays stored and keeps its ID, and
it returns when the provider is on again.

The form's optional **Behaves like** field is for a model that this version's model runtime has no
entry for. Such a model otherwise runs with generic defaults for its provider, which a newer model
may not accept: an Anthropic model that takes only the adaptive thinking format is asked for a
reasoning level in the older budget format. The field lists the chosen provider's catalog models
that the runtime knows, after **None**, and is absent where there are none. The new model borrows
the chosen model's thinking format, its reasoning levels and the kinds of input it takes, such as
images. Its name, limits and cost are never borrowed, and its row names the model it behaves like.
The runtime's own entry always wins: once the deployment runs a version whose runtime knows the
model itself, the choice is no longer used, and the row says `Not used: this version knows this
model itself.` If instead a version stops knowing the chosen model, nothing is borrowed, and the
row says `This version no longer knows that model, so nothing is borrowed.` The choice is the
admin's claim. The server checks only that the runtime knows the chosen model under the same
provider, not that the two models take the same requests, so try the model after adding it.
Changing the provider clears the choice, and picking a suggestion does not make one.

The **Suggest models from models.dev** switch above the form makes the form's **Model ID** field
suggest models. It is off by default. While it is on, the admin's browser downloads the public model
list at `https://models.dev/api.json`, several megabytes, when the admin first turns to the **Model
ID** field, and once for each visit to the tab. The server never contacts models.dev, and no chat
depends on it. The field suggests the models the list has for the chosen provider, so only for
providers the Gateway enables, and of those only the ones listed as calling tools and answering in
text that are not marked deprecated and that the tab doesn't already list. Picking a suggestion
fills in the ID, the display name and the limits, all of which stay editable. A Workers AI
suggestion leaves the output limit blank so that the default of 32768 applies, and a Workers AI
model whose context window is no larger than that default is not suggested. Changing the provider
clears a picked suggestion from the form.
Nothing is added until **Add model** is selected, and the server checks the model as it checks one
typed by hand. If the list can't be loaded the form says so and still works by hand. A suggestion is
not proof that the Gateway can run the model, so try a model after adding it.

The **Users may add their own models** switch on the tab decides whether the deployment's models are
the only ones. It is on by default: a user can add a model of their own on their **Providers** page,
under any ID the deployment's models don't have, and it runs through the deployment's Gateway. With
the switch off, only the models the tab lists can be used. The **Providers** page and onboarding
stop offering to add a model, adding or editing one is refused with `Adding your own models is
disabled on this deployment by an administrator.`, and the models users already added leave their
model pickers. A chat on one of those fails to send, start or retry with `The "<name>" model can't
be used: adding your own models is disabled on this deployment by an administrator.`, and a chat
that an external message continues moves to an offered model as it does off a disabled one. A
gadget model binding for a model that is not on the list, whether a user added it or the deployment
added and since removed it, fails with the same error at its next call. Nothing is deleted: the
models users added work again, configured as they were, once the switch is back on.

The tab's **Providers** section, above the lists of models, decides which providers are on. It has
a row with a switch for each provider AI Gateway serves: Cloudflare Workers AI, Anthropic, OpenAI
and Google. `CF_AI_GATEWAY_PROVIDERS` is a floor, which the section adds to and takes nothing from.
A provider the variable lists is always on: its switch is locked, with the note `Set by
CF_AI_GATEWAY_PROVIDERS`, and the server refuses to turn it off with `Provider "<provider>" is
enabled by CF_AI_GATEWAY_PROVIDERS and can only be turned off there.` An admin can turn any other
provider on, and off again. The variable may be empty, which leaves every provider to the section.
A provider that an admin turned on stays on when the variable later lists it and then drops it.

Turning a provider on does what listing it in the variable does: its catalog models appear, in
their default modes unless modes were stored for them earlier, models can be added under it, and
users can add their own under it while **Users may add their own models** is on. Turning it off
takes its models off the tab and out of the model pickers, and deletes nothing: the modes and
settings of its models, and the models added under it, stay stored and return with it. While it is
off, a chat that names one of those models fails with `No such model: <id>`, except that a chat an
external message continues moves to another model, as it does for a disabled one. Adding or
editing a user's own model under the provider is refused with `Provider "<provider>" is not
available in AI Gateway mode.` Off does not stop what users already have: a model a user already
added under the provider still runs, and so does a gadget model binding already made for one of
the provider's models. **Users may add their own models** is the switch that stops them.

A row warns `Needs CF_AI_GATEWAY_API_TOKEN: requests to this provider fail until the deployment
sets it.` while the provider's requests need the token and the deployment has none, whether the
provider is on or off. In this version that can only be Google's row: Google's requests cannot ride
the `WORKERS_AI` binding, so they need the token even where the binding carries every other
provider's traffic. Listing `google` in `CF_AI_GATEWAY_PROVIDERS` without the token is an invalid
environment setting, and the tab then holds its notice instead of the models. Turning Google on in
the section without the token is allowed: the row warns, and each request to a Google model
through the deployment's Gateway fails with `Provider "google" cannot use the Workers AI binding
transport, and no CF_AI_GATEWAY_API_TOKEN is configured for the HTTPS one.` A turn billed to a
user's own Cloudflare account does not go through the deployment's Gateway, so it needs no such
token. The warning is about the token alone, and says nothing of the provider keys.

Provider keys or credits are stored in the gateway, where the Worker cannot see them, so each row
has a **Test** button that finds out whether the provider answers. A test sends one small request
to the provider's first catalog model, as the admin who pressed the button, through the
deployment's Gateway (also for an admin whose own Cloudflare account pays for their chats). It asks
for at most 16 output tokens, tells the Gateway not to answer from its cache (`cf-aig-skip-cache`),
and waits up to 15 seconds. It works on a provider that is off, whatever mode the model has, and it
changes no setting. Several providers can be tested at once, and a test does not hold up the rest
of the tab. The result stays in the row until the provider is tested again, for as long as the tab
stays open:

- `<model> answered through the gateway.` when the model answered, `<model>` being its ID.
- `Failed (<status>): <message>` when the request failed and the model runtime reported the HTTP
  status of the response.
- `Failed: <message>` when it failed and no status was reported.

The message is what the provider or the gateway answered, or why no answer came, on one line and
cut at 300 characters. A model that does not answer in time gives `Failed: The model did not answer
within 15 seconds.`, and a row with the token warning gives the refusal quoted above without
sending a request. The model runtime reports no status for a failed Google request, so a failed
Google test always takes the `Failed: <message>` form, whatever status the message itself names. If
the test could not be run at all, the row says so, as `Couldn’t run the test: <reason>` when there
is a reason to give.

When the status is 401 or 403, the row adds `The gateway may hold no key or credits for this
provider, or CF_AI_GATEWAY_API_TOKEN may not be allowed to run models.` A test cannot tell the two
apart: in gateway mode the Worker sends no provider key of its own and cannot list what the gateway
holds. A failed Google test has no status, so it never shows the hint. A pass proves that one model
answered once, not that the provider's other models work or that a later request will. Each press
is a real request and costs a few tokens.

The two tests differ in what they ask. A provider's **Test** asks the provider's first catalog
model, with a quick request that takes none of the model's settings, for at most 16 output tokens
within 15 seconds. A model's **Test** asks the model of its row, with the request a chat turn would
send under the model's settings, for up to 2,048 output tokens within 30 seconds, so it costs more.

This applies in AI Gateway mode only. Without `CF_AI_GATEWAY` each user adds their own models on
their **Providers** page, and the tab holds a notice saying so; it holds the same notice when the
gateway's environment settings are invalid. The Gateway's transport and credentials stay
environment and gateway settings: `CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID`,
`CF_AI_GATEWAY_API_TOKEN` and `CF_AI_GATEWAY_USE_BINDING` are set in the environment, and the
provider keys or credits are stored in the gateway. Of the providers, the environment sets only
the floor: the ones `CF_AI_GATEWAY_PROVIDERS` lists are always on, and an admin can turn on the
rest.

The modes, the providers and the switch decide what the deployment offers, and have limits:

- **Disabled alone is not a spend control while users may add their own models.** A user can still
  add a model of their own from any provider that is on, under any ID the deployment's models
  don't have, and it runs through the deployment's Gateway as the deployment's own models do. Turn
  **Users may add their own models** off to make the listed models the only ones.
- **Turning a provider off is not a spend control either, while users may add their own models.**
  The models users already added under the provider still run, and so do the gadget model bindings
  already made for its models, even for a model that was disabled: a binding carries its own
  provider and model name, and while the provider is off no listed model has them. Turn **Users
  may add their own models** off to stop both.
- **An admin session can turn on any provider the Gateway serves.** `CF_AI_GATEWAY_PROVIDERS`
  names the providers that are always on and does not limit the others, so whoever holds an admin
  session, a stolen one included, can turn on `anthropic`, `openai`, `google` or `cloudflare` and
  spend on the keys or credits the gateway holds for it. Sign-in settings (`AUTH_GATEKEEPERS`,
  `DISABLE_PASSWORD_AUTH`) stay environment settings, which no admin session can change.
- **Nothing limits tests but the admin check.** Each **Test** is a real request, paid from the
  keys or credits the gateway holds, and a model's can use up to 2,048 output tokens. Only an
  admin can run one, and the tab ignores a press of a button that reads **Testing…**, but the
  server sets no rate limit: whoever holds an admin session can send tests one after another, of
  any listed model in any mode and of any provider the Gateway serves, on or off.
- **Turning “Users may add their own models” off also applies to users who pay for their own
  usage.** With `ENABLE_CLOUDFLARE_LIMITS`, a user whose connected Cloudflare account is funded is
  billed through that account instead of the deployment's Gateway (see
  [docs/ai-gateway-billing.md](ai-gateway-billing.md)). With it off they too can add no model of
  their own and can run only the listed ones.
- **Disabling does not interrupt a turn in progress.** A model is checked when a turn starts and
  when a gadget's model binding is called, so an agent turn already running on the model finishes
  on it.
- **Removing a model does not shut it off.** It frees the model's ID, and a gadget model binding
  made for the model carries its own provider and model name, so while users may add their own
  models it runs again once the model is removed, even if the model was disabled. It stops only
  while **Users may add their own models** is off. To shut a model off, disable it and leave it in
  place.
- **A suggested model is not a tested one.** Suggestions from models.dev are chosen by provider
  and by what a model is listed as able to do, not by what the deployment's Gateway can run. Try a
  model in a chat after adding it, and remove it if it fails.
- **A change is not instant everywhere.** Chats and gadgets read a mirrored copy of the admin
  settings, so a change can take a short time to reach every location.
- **The title model is outside the modes.** Titles are generated by a fixed Workers AI model that no
  mode applies to.

When using `CF_AI_GATEWAY*` in local development, start the server with
`pnpm run dev-server -- --use-workers-ai-binding` so the server has a `WORKERS_AI` binding for
the webFetch tool's document-to-Markdown conversion and for the gateway transport above (without
it, gateway traffic falls back to HTTPS with `CF_AI_GATEWAY_API_TOKEN`). If your dev Gateway
lives in a different account than the binding, also set `CF_AI_GATEWAY_USE_BINDING=false` — keep
`--use-workers-ai-binding` on, since the Markdown conversion still needs the binding.

Each gatekeeper's OAuth app must be registered with that gatekeeper's redirect URI (replace the host
with `PUBLIC_BASE_URL`):

- GitHub: `${PUBLIC_BASE_URL}/gatekeeper/github/oauth`
- Google: `${PUBLIC_BASE_URL}/gatekeeper/google/oauth`
- Cloudflare: `${PUBLIC_BASE_URL}/gatekeeper/cloudflare/oauth`

See [docs/oauth-signin.md](oauth-signin.md) and [docs/ai-gateway-billing.md](ai-gateway-billing.md)
for the full list of options, the free-tier / top-up behavior, and the storage bindings involved.
