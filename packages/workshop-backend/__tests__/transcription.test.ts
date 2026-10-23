import { describe, expect, it, vi } from "vitest";
import { MAX_TRANSCRIPTION_AUDIO_BYTES } from "@gadgets/workshop-shared/api";
import { serializeAdminConfig } from "../src/admin-config.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage.js";
import { transcribeAudio } from "../src/transcription.js";

const USER = { toString: () => "user-do-id" } as DurableObjectId;

// An env whose Workers AI transcribes everything to the same padded text, and whose only KV
// content is the admin config.
function setup(overrides: Partial<Cloudflare.Env> = {}, transcriptionEnabled = true) {
  let run = vi.fn(async (..._args: unknown[]) =>
      ({ text: " Build me a gadget. ", transcription_info: { duration: 2.5 } }));
  let env = {
    BLUEPRINTS: {
      get: async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, transcriptionEnabled }),
    },
    WORKERS_AI: { run },
    ...overrides,
  } as unknown as Cloudflare.Env;
  return { env, run };
}

describe("transcribeAudio", () => {
  it("refuses while an admin has turned transcription off, without running the model", async () => {
    let { env, run } = setup({}, false);
    await expect(transcribeAudio(env, USER, new Uint8Array([1, 2, 3]))).rejects.toThrow(/turned off/);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a recording over the cap without running the model, and accepts one at it", async () => {
    let { env, run } = setup();
    await expect(transcribeAudio(env, USER, new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES + 1)))
        .rejects.toThrow(/too large/);
    expect(run).not.toHaveBeenCalled();
    await expect(transcribeAudio(env, USER, new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES)))
        .resolves.toBe("Build me a gadget.");
  });

  it("sends the recording's exact bytes with silence filtered, and returns the transcript trimmed",
      async () => {
    let { env, run } = setup();
    let audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff]);
    await expect(transcribeAudio(env, USER, audio)).resolves.toBe("Build me a gadget.");
    let input = run.mock.calls[0][1] as { audio: string; vad_filter?: boolean };
    expect(Uint8Array.fromBase64(input.audio)).toEqual(audio);
    // Without it, whisper hears "Thank you." in silence and noise.
    expect(input.vad_filter).toBe(true);
  });

  it("goes through the platform gateway without letting it log or cache the recording", async () => {
    let { env, run } = setup({ CF_AI_GATEWAY: "platform-gateway", CF_AI_GATEWAY_ACCOUNT_ID: "acct" });
    await transcribeAudio(env, USER, new Uint8Array([1]));
    expect(run.mock.calls[0][2])
        .toEqual({ gateway: { id: "platform-gateway", collectLog: false, skipCache: true } });
  });

  it.each([
    ["without a gateway", {}],
    ["when the gateway is in another account", {
      CF_AI_GATEWAY: "platform-gateway", CF_AI_GATEWAY_ACCOUNT_ID: "acct",
      CF_AI_GATEWAY_API_TOKEN: "token", CF_AI_GATEWAY_USE_BINDING: "false",
    }],
  ])("calls Workers AI directly %s", async (_case, overrides: Partial<Cloudflare.Env>) => {
    let { env, run } = setup(overrides);
    await transcribeAudio(env, USER, new Uint8Array([1]));
    expect(run.mock.calls[0][2]).toEqual({});
  });
});
