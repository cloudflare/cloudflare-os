// The public face of the Webhooks gatekeeper: the HTTP endpoint third-party services POST to.
//
// The router forwards `/gatekeeper/webhook/*` here untouched, so this handler sees the whole
// request. It holds no policy of its own — it resolves the endpoint ID to an account, hands the
// request to that account's registry, and renders whatever the registry decides. Authentication,
// method checks, rate limiting, and queuing all live in the registry, where the endpoint's state is.

import { reportIssue } from "@gadgets/backend-utils/error-reporting";
import {
  MAX_BODY_BYTES,
  readBearer,
  sanitizeHeaders,
  sanitizeQuery,
  truncateBody,
} from "./endpoint-core.js";
import type { EndpointIndex } from "./endpoint-index.js";
import type { EndpointRegistry } from "./endpoint-registry.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.webhook.receiver",
  vendorId: "webhook",
});

/** Endpoint IDs are base64url of 16 random bytes: 22 characters, no padding. */
const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

type WorkerExports = {
  EndpointIndex: DurableObjectNamespace<EndpointIndex>;
  EndpointRegistry: DurableObjectNamespace<EndpointRegistry>;
};

/** Splits `<base>/e/<endpointId><subPath>` into its parts, or null when the path isn't an endpoint. */
export function parseEndpointPath(
  pathname: string,
  basePath: string,
): { endpointId: string; subPath: string } | null {
  const prefix = `${basePath.replace(/\/+$/, "")}/e/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const endpointId = slash === -1 ? rest : rest.slice(0, slash);
  if (!ENDPOINT_ID_PATTERN.test(endpointId)) return null;
  return { endpointId, subPath: slash === -1 ? "" : rest.slice(slash) };
}

function problem(status: number, message: string): Response {
  return Response.json(
    { ok: false, error: message },
    {
      status,
      // Endpoint URLs are pasted into third-party dashboards, never fetched from a browser page.
      headers: { "cache-control": "no-store" },
    },
  );
}

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const basePath = new URL(env.BASE_URL).pathname;
    const parsed = parseEndpointPath(url.pathname, basePath);
    if (!parsed) return problem(404, "Not found");

    return obsContext.with(
      { operation: "receive", endpointId: parsed.endpointId },
      async () => {
        const exports = ctx.exports as unknown as WorkerExports;
        const accountId = await exports.EndpointIndex.getByName(parsed.endpointId).resolve();
        if (!accountId) return problem(404, "Not found");

        // Read at most one byte past the cap, so an oversized body is detected without buffering it.
        let raw: string;
        try {
          raw = await readBoundedText(request);
        } catch (error) {
          logger.warn("webhook body read failed", { event: "receive.body.failed", error });
          return problem(400, "Could not read the request body");
        }
        const { body, truncated } = truncateBody(raw);

        const result = await exports.EndpointRegistry.getByName(accountId).receive({
          endpointId: parsed.endpointId,
          token: readBearer(request.headers.get("authorization")),
          method: request.method.toUpperCase(),
          subPath: parsed.subPath,
          query: sanitizeQuery(url.searchParams),
          headers: sanitizeHeaders(request.headers),
          body,
          truncated,
        });

        if (!result.accepted) {
          logger.info("webhook request rejected", {
            event: "receive.rejected",
            status: result.status,
          });
          const response = problem(result.status, result.message);
          // Tell a well-behaved client how to authenticate, without naming the endpoint.
          if (result.status === 401) {
            response.headers.set("www-authenticate", 'Bearer realm="webhook"');
          }
          return response;
        }

        return Response.json(
          { ok: true, deliveryId: result.deliveryId },
          { status: 202, headers: { "cache-control": "no-store" } },
        );
      },
    ).catch((error) => {
      logger.error("webhook receive failed", { event: "receive.failed", error });
      reportIssue("webhook.receive", error, { attributes: obsContext.get() });
      return problem(500, "Internal error");
    });
  },
} satisfies ExportedHandler<Cloudflare.Env>;

/**
 * Reads the body as text, stopping once one byte past the cap has arrived. A service that posts a
 * 50 MB payload gets its first 128 KiB delivered and truncated rather than filling this isolate.
 */
async function readBoundedText(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}
