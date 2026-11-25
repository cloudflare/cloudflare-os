// What a vision-capable model sees when the agent reads an image file from a worktree: the image
// itself, live and again when later turns replay the history.

import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import { scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor, waitForIdleChat } from "../src/rpc-client.js";

// A Workers AI model pi's catalog lists as taking images, so pi sends image parts to it (the
// scripted endpoint answers whatever model a request names).
const VISION_MODEL_ID = "@cf/meta/llama-4-scout-17b-16e-instruct";

// A 1x1 PNG.
const DOT_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const DOT = new Uint8Array(Buffer.from(DOT_BASE64, "base64"));

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const REQUEST = z.object({
  messages: z.array(z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
      image_url: z.object({ url: z.string() }).optional(),
    }))]).nullish(),
    tool_call_id: z.string().optional(),
  })),
});

// The tool message answering `toolCallId`, and the image URLs pi attaches after it in the user
// message it adds for a tool result's images.
function toolResult(request: unknown, toolCallId: string) {
  const messages = REQUEST.parse(request).messages;
  const index = messages.findIndex(m => m.role === "tool" && m.tool_call_id === toolCallId);
  if (index < 0) throw new Error(`No tool result for ${toolCallId}`);
  const next = messages.slice(index + 1).find(m => m.role !== "tool");
  const parts = Array.isArray(next?.content) ? next.content : [];
  return {
    text: messages[index]!.content,
    images: parts[0]?.text === "Attached image(s) from tool result:"
      ? parts.flatMap(part => part.image_url ? [part.image_url.url] : []) : [],
  };
}

it("shows a worktree image to the model, live and on replay", async () => {
  const model = models.script([
    { toolCall: { id: "look", name: "readFile",
                  arguments: { workpiece: "ATTACHMENTS", filename: "dot.png" } } },
    { toolCall: { id: "look-window", name: "readFile",
                  arguments: { workpiece: "ATTACHMENTS", filename: "dot.png", startLine: 1 } } },
    { text: "A dot." },
    { text: "Still a dot." },
  ]);
  const [username] = nextUsernames("imageread");
  using stack = new DisposableStack();
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  const { profile, config } = model.userModel;
  await api.addModel({ ...profile, id: VISION_MODEL_ID }, { ...config, model: VISION_MODEL_ID });
  await api.setQuickModel(null);
  const ws = stack.use(await api.newWorkspace());

  const upload = { oid: await ws.uploadBlob(DOT), mimeType: "image/png", name: "dot.png" };
  const chatId = await ws.newChat("What is this?", VISION_MODEL_ID, { attachments: [upload] });
  await waitFor("the first turn", async () => model.requests.length >= 3 || null);
  await waitForIdleChat(ws, chatId);

  const shown = {
    text: "dot.png: image/png, 1x1 pixels",
    images: [`data:image/png;base64,${DOT_BASE64}`],
  };
  expect(toolResult(model.requests[1], "look")).toEqual(shown);
  // An image has no lines to window.
  expect(toolResult(model.requests[2], "look-window").text).toContain("is an image, which has no lines");

  await ws.sendChatMessage(chatId, "And now?", VISION_MODEL_ID);
  await waitFor("the second turn", async () => model.requests.length >= 4 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.requests).toHaveLength(4);
  expect(toolResult(model.requests[3], "look")).toEqual(shown);
  expect(model.remainingSteps()).toBe(0);
});
