# Server-managed models

By default every user brings their own model credentials: each person adds a provider and API key
in **Settings → Providers** before they can chat. That is the right default for a deployment whose
users have their own accounts, but not for one where the operator wants to fund inference centrally
— an internal LLM proxy, a corporate gateway, or a self-hosted model server.

`SERVER_MODELS` lets a deployment offer models to everyone, with credentials that stay in the
environment. Users select them from the picker like any other model, never see the token, and
cannot edit or delete them.

## Relationship to AI Gateway mode

[AI Gateway mode](ai-gateway-billing.md) solves the same problem for Cloudflare-hosted
inference: `CF_AI_GATEWAY` routes a curated set of `SUGGESTED_MODELS` through a Cloudflare AI
Gateway, with the platform paying.

`SERVER_MODELS` is the self-hosted counterpart. It points at any endpoint the existing providers
can speak to, including models that have no `SUGGESTED_MODELS` entry.

|  | AI Gateway mode | `SERVER_MODELS` |
| --- | --- | --- |
| Endpoint | Cloudflare AI Gateway | any URL you supply |
| Models | `SUGGESTED_MODELS` for enabled providers | anything the provider's API accepts |
| Credentials | `CF_AI_GATEWAY_API_TOKEN` | per-model `apiToken` |
| Cost logging | via Gateway logs | none |

The two are independent and can be used together; server models are never re-routed through a
Gateway, since that would discard the endpoint and credentials they were configured with.

## Configuration

`SERVER_MODELS` is a JSON array. It holds credentials, so set it as a secret
(`wrangler secret put SERVER_MODELS`), not as a plaintext var.

```json
[
  {
    "id": "house-sonnet",
    "name": "Sonnet (internal)",
    "provider": "anthropic",
    "model": "claude-sonnet-5",
    "apiUrl": "https://llm.internal.example.com",
    "apiToken": "sk-...",
    "contextWindow": 1000000
  },
  {
    "provider": "ollama",
    "model": "qwen3-coder",
    "apiUrl": "http://ollama.internal:11434"
  }
]
```

| Field | Required | Meaning |
| --- | --- | --- |
| `provider` | yes | `openai`, `anthropic`, `google`, `cloudflare` or `ollama` — which API dialect the endpoint speaks |
| `model` | yes | Model name as the endpoint expects it |
| `id` | no | Stable id used in stored preferences and chat records. Defaults to `model` |
| `name` | no | Display name in the picker. Defaults to `id` |
| `apiUrl` | no | Endpoint. Defaults to the provider's public API |
| `apiToken` | no | Sent as the provider's credential. Omit for an endpoint that needs none |
| `accountId` | no | Required by `cloudflare`, whose REST endpoint is account-scoped |
| `contextWindow` | no | Total token window. Defaults to 128,000 |
| `outputLimit` | no | Response reservation, withheld from the prompt budget |

Set `contextWindow` for any large-context model: without it a 1M-token model is treated as 128k and
conversations are compacted far earlier than necessary.

Choosing `provider` is about the **API dialect, not the vendor**. Any OpenAI-compatible
chat-completions endpoint works with `ollama`, which is the provider that speaks that dialect (the
`openai` provider uses the newer Responses API, which many compatible endpoints do not implement).

Malformed configuration throws at startup rather than silently offering no models, and the error
names the offending entry — `SERVER_MODELS[1]: "model" is required.`

## Behaviour

- Server models appear in every user's picker, in configured order, before their own models.
- A user cannot add a model whose id collides with a server model, or delete one.
- A server model can be chosen as the quick model used for lightweight tasks like title generation.
- Removing an entry from `SERVER_MODELS` removes it from every picker. Users who had it selected
  fall back to their next available model.
- Changing an entry's `id` is equivalent to removing one model and adding another, so prefer
  setting `id` explicitly if you may later change the underlying `model` name.
