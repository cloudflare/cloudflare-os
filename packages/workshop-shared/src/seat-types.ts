// Types for enrolling an AI subscription seat through the seat proxy.
//
// The proxy holds the real OAuth tokens; Cloudflare OS only ever sees an opaque
// handle, which it stores as an ordinary AiModelConfig.apiToken.

export type SeatProvider = "anthropic" | "openai";

// What the user must do next to authorize. Anthropic sends them to a consent page
// and shows them a code to paste back; OpenAI gives them a code to type into a
// device-authorization page while we poll.
export type SeatStartResult =
  | { enrollId: string, kind: "authorize_url", url: string }
  | { enrollId: string, kind: "device_code", userCode: string,
      verificationUri: string, interval: number };

// `pending` means the user has not finished authorizing yet (OpenAI only).
export type SeatCompleteResult =
  | { status: "pending" }
  | { status: "complete", handle: string, models: string[], apiUrl: string };
