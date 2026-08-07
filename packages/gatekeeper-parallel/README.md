# Gatekeeper Parallel

This package adds read-only web search and URL extraction to Cloudflare OS using the
[Parallel API](https://docs.parallel.ai/).

The deployment supplies one `PARALLEL_API_KEY`. Cloudflare OS then offers an optional,
auto-provisioned Parallel account to each user. The account contributes a `PARALLEL` agent binding;
the API key stays inside the Gatekeeper Worker and is never returned to an agent or Gadget.

## Agent API

- `search(objective, searchQueries, options?)` searches the live web and returns ranked,
  LLM-optimized excerpts.
- `extract(urls, objective?, options?)` retrieves relevant excerpts from up to 20 public URLs.

Both operations are read-only. Results are released only after the Gatekeeper records an
observation with Cloudflare OS.

## Configuration

Create an API key in the [Parallel platform](https://platform.parallel.ai/) and set it as a Worker
secret named `PARALLEL_API_KEY`.

For local development, add the key to the root `.dev.vars` file:

```dotenv
PARALLEL_API_KEY=your_api_key
```

The default API base URL is `https://api.parallel.ai`. Tests or private deployments can override it
with `PARALLEL_API_BASE_URL`.
