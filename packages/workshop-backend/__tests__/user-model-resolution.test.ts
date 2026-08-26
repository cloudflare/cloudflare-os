import {describe, expect, it} from "vitest";
import {UserDurableObject, type UserAiModelRecord} from "../src/user.js";

const COLLIDING_MODEL_ID = "gpt-5.6-sol";

function makeUser(model: UserAiModelRecord): UserDurableObject {
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env: {
      CF_AI_GATEWAY: "platform-gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      CF_AI_GATEWAY_PROVIDERS: "openai",
    },
    storage: {
      profile: {get: () => ({type: "user", id: "user", name: "User"})},
      aiModels: {get: (id: string) => id === model.profile.id ? model : undefined},
    },
  });
  return user;
}

describe("UserDurableObject.getChatContext", () => {
  it("does not replace a persisted incompatible model with a colliding Gateway model", async () => {
    const user = makeUser({
      profile: {type: "agent", id: COLLIDING_MODEL_ID, name: "Private model"},
      config: {
        provider: "openai-compatible",
        model: COLLIDING_MODEL_ID,
        apiToken: "private-token",
        apiUrl: "https://models.example.com/v1",
        contextWindow: 128_000,
        outputLimit: 8_192,
      },
    });

    await expect(user.getChatContext(COLLIDING_MODEL_ID)).rejects.toThrow(
        "OpenAI-compatible models are not available in AI Gateway mode.");
  });
});
