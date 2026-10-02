import { describe, expect, it, vi } from "vitest";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import { completeText, httpStatusFromError } from "../src/ai-invoke.js";
import { getModel } from "../src/ai-models.js";

describe("httpStatusFromError", () => {
  it("reads the status a provider SDK's message begins with", () => {
    expect(httpStatusFromError("401 Incorrect API key provided.", undefined)).toBe(401);
    expect(httpStatusFromError('400 {"error":{"message":"bad"}}', undefined)).toBe(400);
    expect(httpStatusFromError("  503: upstream unavailable", undefined)).toBe(503);
  });

  it("reads the status from the wording of pi's OpenAI adapter", () => {
    expect(httpStatusFromError('OpenAI API error (401): {"message":"bad key"}', undefined))
        .toBe(401);
    expect(httpStatusFromError("OpenAI API error (529): 529 overloaded", undefined)).toBe(529);
  });

  it("takes no digits from elsewhere in the message for a status", () => {
    for (let message of [
      "Request 123 failed with 500",
      '{"error":{"code":401,"message":"API key not valid."}}',
      "4010 tokens is over the limit",
      "The upstream said: OpenAI API error (500): overloaded",
      "OpenAI API error (5000): overloaded",
      "OpenAI API error: 500 overloaded",
    ]) {
      expect(httpStatusFromError(message, undefined), message).toBeUndefined();
    }
  });

  it("falls back on the status of the response the handle observed", () => {
    expect(httpStatusFromError("Request was aborted mid-stream", { status: 502 })).toBe(502);
    // A status the message opens with is that of the request that failed.
    expect(httpStatusFromError("429 Too many requests", { status: 200 })).toBe(429);
    expect(httpStatusFromError("OpenAI API error (429): slow down", { status: 200 })).toBe(429);
    expect(httpStatusFromError("Connection error.", undefined)).toBeUndefined();
  });
});

describe("completeText", () => {
  const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  // A handle on a gateway whose Workers AI binding answers every request with "OK", and the
  // headers and bodies of the requests it received.
  function answering(config: Partial<AiModelConfig> = {}) {
    const sent: Headers[] = [];
    const bodies: Record<string, unknown>[] = [];
    const event = (choice: object) => `data: ${JSON.stringify({
      id: "completion", object: "chat.completion.chunk", created: 0, model: MODEL,
      choices: [{ index: 0, ...choice }],
    })}\n\n`;
    const fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push(request.headers);
      bodies.push(await request.json());
      return new Response(
          event({ delta: { role: "assistant", content: "OK" }, finish_reason: null }) +
          event({ delta: {}, finish_reason: "stop" }) + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } });
    });
    const handle = getModel({
      CF_AI_GATEWAY: "platform-gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_PROVIDERS: "cloudflare",
      WORKERS_AI: { fetch },
    } as unknown as Cloudflare.Env,
        { provider: "cloudflare", model: MODEL, apiToken: "", ...config },
        { type: "user", id: "user-123", name: "User" });
    return { handle, sent, bodies };
  }

  it("sends a request's own headers beside the handle's", async () => {
    const { handle, sent } = answering();
    expect(await completeText(handle, {
      prompt: "hello", headers: { "cf-aig-skip-cache": "true" },
    })).toBe("OK");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("cf-aig-skip-cache")).toBe("true");
    expect(JSON.parse(sent[0]!.get("cf-aig-metadata")!)).toStrictEqual({ user: "user-123" });
    expect(sent[0]!.get("cf-aig-authorization")).toMatch(/^Bearer /);
  });

  it("sends only the handle's headers when given none", async () => {
    const { handle, sent } = answering();
    expect(await completeText(handle, { prompt: "hello" })).toBe("OK");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.has("cf-aig-skip-cache")).toBe(false);
    expect(JSON.parse(sent[0]!.get("cf-aig-metadata")!)).toStrictEqual({ user: "user-123" });
    expect(sent[0]!.get("cf-aig-authorization")).toMatch(/^Bearer /);
  });

  // A handle with a reasoning level names that level on the requests that ask for thinking. On
  // the others, pi names the effort GLM 5.2 calls no reasoning.
  it("asks for thinking only when told to", async () => {
    const { handle, bodies } = answering({ model: "@cf/zai-org/glm-5.2", reasoning: "high" });
    expect(await completeText(handle, { prompt: "hello" })).toBe("OK");
    expect(await completeText(handle, { prompt: "hello", thinking: false })).toBe("OK");
    expect(await completeText(handle, { prompt: "hello", thinking: true })).toBe("OK");
    expect(bodies.map(body => body.reasoning_effort)).toEqual(["none", "none", "high"]);
  });
});
