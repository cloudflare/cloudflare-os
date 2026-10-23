// Speech-to-text for dictated prompts (AuthenticatedApi.transcribeAudio). Nothing here is stored:
// the recording and its transcript exist only for the length of the call.

import { MAX_TRANSCRIPTION_AUDIO_BYTES } from "@gadgets/workshop-shared/api";
import { readAdminConfig } from "./admin-config.js";
import { getAiGatewayConfig } from "./ai-gateway.js";
import { createWorkshopLogger } from "./observability.js";

const logger = createWorkshopLogger("workshop.transcription");

// The model, and the shapes of its input and output.
const TRANSCRIPTION_MODEL = {
  id: "@cf/openai/whisper-large-v3-turbo",
  // Base64: the Workers AI binding refuses a ReadableStream input whenever `gateway` is set
  // (workerd src/cloudflare/internal/ai-api.ts), and refuses typed arrays. Once it streams through
  // the gateway, send `{body: <a stream over the bytes>, contentType}` instead, which copies and
  // encodes nothing but needs the recorder's MIME type back as a transcribeAudio() parameter.
  // Without voice activity detection, silence and noise come back as stock phrases ("Thank you.").
  input: (audio: Uint8Array) => ({ audio: audio.toBase64(), vad_filter: true }),
  text: (output: Ai_Cf_Openai_Whisper_Large_V3_Turbo_Output) => output.text.trim(),
} as const;

/** Transcribe a recording on behalf of `userId` (see AuthenticatedApi.transcribeAudio). */
export async function transcribeAudio(
    env: Cloudflare.Env, userId: DurableObjectId, audio: Uint8Array): Promise<string> {
  if (!(await readAdminConfig(env)).transcriptionEnabled) {
    throw new Error("Voice input is turned off on this deployment.");
  }
  if (audio.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
    throw new Error(
        `Recording too large to transcribe (max ${MAX_TRANSCRIPTION_AUDIO_BYTES / 2 ** 20} MiB).`);
  }
  // Through the platform gateway when the binding reaches it, as webFetch's toMarkdown is. The
  // gateway neither logs nor caches it, since the user may discard what they dictated.
  let gateway = getAiGatewayConfig(env)?.sameAccountGateway;
  let started = Date.now();
  let output = await env.WORKERS_AI.run(TRANSCRIPTION_MODEL.id, TRANSCRIPTION_MODEL.input(audio),
      gateway ? { gateway: { id: gateway, collectLog: false, skipCache: true } } : {});
  // The only record of who spent what, since the gateway logs nothing. Carries no content.
  logger.info("transcribed audio", {
    event: "transcription.run",
    durableObjectId: userId.toString(),
    modelId: TRANSCRIPTION_MODEL.id,
    size: audio.byteLength,
    audioSeconds: output.transcription_info?.duration,
    durationMs: Date.now() - started,
  });
  return TRANSCRIPTION_MODEL.text(output);
}
