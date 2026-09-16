import { expect, it } from "vitest";
import { scriptedChatCompletions } from "../src/mock-model.js";

it("returns scripted OpenAI tool and text responses while recording each request", async () => {
  const model = scriptedChatCompletions([
    { toolCall: { id: "call-1", name: "readValue", arguments: { id: "a" } } },
    { text: "Value: 42" },
  ]);
  const auxiliaryCases = [
    {
      kind: "thread-title",
      prompt: "Generate a brief, descriptive title for this chat",
      response: "Test chat",
    },
    {
      kind: "gadget-title",
      prompt: "Below is the log of a chat session that led to a coding agent writing code",
      response: "Test Gadget",
    },
    {
      kind: "binding-name",
      prompt: "Choose a short, meaningful JavaScript identifier in ALL_CAPS_WITH_UNDERSCORES",
      response: "TEST_BINDING",
    },
  ];
  for (const testCase of auxiliaryCases) {
    const request = new Request("https://example.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: testCase.prompt }] }),
    });
    const response = await model.handler(
        new URL(request.url), request.method, request.headers, request);
    if (response === null) throw new Error(`The scripted model declined ${testCase.kind}`);
    expect(await response.text()).toContain(`"content":"${testCase.response}"`);
  }
  expect(model.auxiliaryRequests.map(request => request.kind))
    .toEqual(auxiliaryCases.map(testCase => testCase.kind));
  expect(model.requests).toEqual([]);
  expect(model.remainingSteps()).toBe(2);
  const firstRequest = new Request("https://example.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      messages: [{
        role: "user",
        content: "Read it, then quote: Generate a brief, descriptive title",
      }],
    }),
  });
  const first = await model.handler(
      new URL(firstRequest.url), firstRequest.method, firstRequest.headers, firstRequest);
  if (first === null) throw new Error("The scripted model declined a chat-completion request");

  expect(await first.text()).toContain(
      '"tool_calls":[{"index":0,"id":"call-1","type":"function"');
  expect(model.requests).toEqual([{
    messages: [{
      role: "user",
      content: "Read it, then quote: Generate a brief, descriptive title",
    }],
  }]);
  expect(model.remainingSteps()).toBe(1);

  const secondRequest = new Request("https://example.com/chat/completions", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "tool", content: "42" }] }),
  });
  const second = await model.handler(
      new URL(secondRequest.url), secondRequest.method, secondRequest.headers, secondRequest);
  if (second === null) throw new Error("The scripted model declined a chat-completion request");

  expect(await second.text()).toContain('"content":"Value: 42"');
  expect(model.requests).toHaveLength(2);
  expect(model.remainingSteps()).toBe(0);
});
