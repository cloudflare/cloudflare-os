# Cloudflare OS Fork — Seat Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Sign in with your Claude / ChatGPT subscription" to Cloudflare OS, so a user enrolls a seat from inside the product instead of running curl by hand.

**Architecture:** The seat proxy already does all the OAuth. This adds a thin path through Cloudflare OS: three RPC methods that forward to the proxy, and a React component that walks the user through consent and paste-back. On success the frontend calls the *existing* `addModel` with the handle as the API token, so no storage or inference code changes.

**Tech Stack:** TypeScript, React, capnweb RPC, vitest.

**Depends on:** the `seat-proxy` service on this branch. Nothing here works without it running.

## Global Constraints

- Repo root `C:\Developer\cloudflare-os`, branch `seat-proxy`.
- **Keep changes to existing files minimal.** Upstream is under heavy development and does not accept contributions, so every edited line in a churning file is permanent merge friction. New code goes in new files; existing files get one-line touchpoints. `api.ts` and `server.ts` are the two that matter most.
- **Never log or display a handle, code, or token.** The handle is a bearer credential.
- **The owner sent to the proxy must be lowercased.** The proxy rejects any `X-Seat-Owner` that is not already case-folded — this was a deliberate fix for a verified cross-user seat hijack. Cloudflare OS usernames are not guaranteed lowercase, so the backend must fold before sending or enrollment fails with an opaque 400.
- Do not modify anything under `seat-proxy/`.
- Verify with `pnpm --filter @gadgets/workshop-frontend types:check` and the package's `vitest run`. Never weaken an existing assertion.

### Interfaces already in the codebase (verified, do not guess)

- `AuthenticatedApi` — interface at `packages/workshop-shared/src/api.ts:289`, extends `RpcTarget`.
- `AuthenticatedApiImpl` — `packages/workshop-backend/src/server.ts:75`. Has `this.env` and
  `this.user.id.name` (the username). Delegating methods are one-liners; follow that style.
- `addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void>` — `server.ts:123`.
  `AiChatAuthorInfo` is `{type: "user"|"agent"|"gadget", id: string, name: string}` (`api.ts:1750`).
  `AiModelConfig` is `{provider, model, apiToken, accountId?, apiUrl?}` (`api.ts:931`).
- `AddModelModal` receives `authenticatedApi: RpcStub<AuthenticatedApi>` as a prop and imports UI
  from `@cloudflare/kumo` (`Dialog`, `Button`, `Input`, `SensitiveInput`, `Collapsible`,
  `useKumoToastManager`).
- Optional env vars are declared by hand in `packages/workshop-backend/src/env.d.ts` as `?: string`
  and passed through by `run-dev-server.js`'s `OPTIONAL_FEATURE_VARS` list.

### Proxy endpoints this consumes

- `POST {SEAT_PROXY_URL}/enroll/{provider}/start`, header `X-Seat-Owner`. Anthropic returns
  `{enroll_id, kind: "authorize_url", url}`; OpenAI returns
  `{enroll_id, kind: "device_code", user_code, verification_uri, interval}`.
- `POST {SEAT_PROXY_URL}/enroll/{provider}/complete` with `{enroll_id, code}` for Anthropic, or
  `{enroll_id}` for OpenAI which returns `{"status": "pending"}` until authorized. Success returns
  `{status: "complete", handle, models}`.
- `DELETE {SEAT_PROXY_URL}/enroll/{handle}`, header `X-Seat-Owner`.

---

### Task 1: Shared types and configuration plumbing

No behaviour, just the declarations everything else needs.

**Files:**
- Create: `packages/workshop-shared/src/seat-types.ts`
- Modify: `packages/workshop-backend/src/env.d.ts` (one line)
- Modify: `run-dev-server.js` (one line)

**Interfaces:**
- Produces: `SeatProvider`, `SeatStartResult`, `SeatCompleteResult`.

- [ ] **Step 1: Write the shared types**

```typescript
// packages/workshop-shared/src/seat-types.ts
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
```

- [ ] **Step 2: Declare the env var**

In `packages/workshop-backend/src/env.d.ts`, alongside the other optional vars, add:

```typescript
      // Base URL of the seat proxy, e.g. "http://localhost:8890". When unset, seat
      // sign-in is unavailable and the UI hides it.
      SEAT_PROXY_URL?: string;
```

- [ ] **Step 3: Pass it through in dev**

In `run-dev-server.js`, add `"SEAT_PROXY_URL"` to the `OPTIONAL_FEATURE_VARS` array (around line 241).

- [ ] **Step 4: Verify it compiles**

Run: `pnpm --filter @gadgets/workshop-shared types:check` (skip if that package has no such script), then `pnpm --filter @gadgets/workshop-backend types:check`
Expected: no new errors. Record any pre-existing errors separately so they are not mistaken for yours.

- [ ] **Step 5: Commit**

```bash
git add packages/workshop-shared/src/seat-types.ts packages/workshop-backend/src/env.d.ts run-dev-server.js
git commit -m "feat(seats): shared seat-enrollment types and proxy URL config"
```

---

### Task 2: Backend seat-auth module and RPC methods

**Files:**
- Create: `packages/workshop-backend/src/seat-auth.ts`
- Create: `packages/workshop-backend/src/seat-auth.test.ts`
- Modify: `packages/workshop-shared/src/api.ts` (three signatures on `AuthenticatedApi`)
- Modify: `packages/workshop-backend/src/server.ts` (three one-line delegates)

**Interfaces:**
- Produces: `startSeatAuth(env, owner, provider)`, `completeSeatAuth(env, owner, provider, enrollId, code)`, `revokeSeat(env, owner, handle)`, and `seatProxyUrl(env)`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/workshop-backend/src/seat-auth.test.ts
import { describe, it, expect, vi } from "vitest";
import { startSeatAuth, completeSeatAuth, revokeSeat } from "./seat-auth.js";

function envWith(url?: string) {
  return { SEAT_PROXY_URL: url } as any;
}

function fetchReturning(status: number, body: unknown, capture?: any) {
  return vi.fn(async (input: any, init: any) => {
    if (capture) { capture.url = String(input); capture.init = init; }
    return new Response(JSON.stringify(body), { status,
      headers: { "content-type": "application/json" } });
  });
}

describe("startSeatAuth", () => {
  it("lowercases the owner before sending it", async () => {
    const cap: any = {};
    const fetchImpl = fetchReturning(200,
      { enroll_id: "E", kind: "authorize_url", url: "https://x/y" }, cap);
    await startSeatAuth(envWith("http://p"), "Alice", "anthropic", fetchImpl);
    expect(cap.init.headers["X-Seat-Owner"]).toBe("alice");
  });

  it("maps an authorize_url response", async () => {
    const fetchImpl = fetchReturning(200,
      { enroll_id: "E", kind: "authorize_url", url: "https://x/y" });
    const out = await startSeatAuth(envWith("http://p"), "alice", "anthropic", fetchImpl);
    expect(out).toEqual({ enrollId: "E", kind: "authorize_url", url: "https://x/y" });
  });

  it("maps a device_code response", async () => {
    const fetchImpl = fetchReturning(200, { enroll_id: "E", kind: "device_code",
      user_code: "ABCD", verification_uri: "https://x", interval: 5 });
    const out = await startSeatAuth(envWith("http://p"), "alice", "openai", fetchImpl);
    expect(out).toEqual({ enrollId: "E", kind: "device_code", userCode: "ABCD",
      verificationUri: "https://x", interval: 5 });
  });

  it("throws a clean error when the proxy is not configured", async () => {
    await expect(startSeatAuth(envWith(undefined), "alice", "anthropic",
      fetchReturning(200, {}))).rejects.toThrow(/not configured/i);
  });

  it("throws without leaking the proxy response body", async () => {
    const fetchImpl = fetchReturning(500, { secret: "TOKEN-LEAK" });
    let message = "";
    try {
      await startSeatAuth(envWith("http://p"), "alice", "anthropic", fetchImpl);
    } catch (e: any) {
      message = String(e?.message ?? e);
    }
    expect(message).toMatch(/failed \(500\)/);
    expect(message).not.toContain("TOKEN-LEAK");
  });
});

describe("completeSeatAuth", () => {
  it("returns pending unchanged", async () => {
    const fetchImpl = fetchReturning(200, { status: "pending" });
    const out = await completeSeatAuth(envWith("http://p"), "alice", "openai", "E",
      undefined, fetchImpl);
    expect(out).toEqual({ status: "pending" });
  });

  it("returns the handle and the per-provider apiUrl", async () => {
    const fetchImpl = fetchReturning(200,
      { status: "complete", handle: "H", models: ["m1"] });
    const out = await completeSeatAuth(envWith("http://p"), "alice", "anthropic", "E",
      "CODE", fetchImpl);
    expect(out).toEqual({ status: "complete", handle: "H", models: ["m1"],
      apiUrl: "http://p/anthropic" });
  });

  it("sends the code and lowercased owner", async () => {
    const cap: any = {};
    const fetchImpl = fetchReturning(200,
      { status: "complete", handle: "H", models: [] }, cap);
    await completeSeatAuth(envWith("http://p"), "Alice", "anthropic", "E", "CODE",
      fetchImpl);
    expect(JSON.parse(cap.init.body)).toEqual({ enroll_id: "E", code: "CODE" });
    expect(cap.init.headers["X-Seat-Owner"]).toBe("alice");
  });
});

describe("revokeSeat", () => {
  it("deletes the handle with the lowercased owner", async () => {
    const cap: any = {};
    const fetchImpl = fetchReturning(204, {}, cap);
    await revokeSeat(envWith("http://p"), "Alice", "H", fetchImpl);
    expect(cap.url).toBe("http://p/enroll/H");
    expect(cap.init.method).toBe("DELETE");
    expect(cap.init.headers["X-Seat-Owner"]).toBe("alice");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run src/seat-auth.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/workshop-backend/src/seat-auth.ts
// Thin forwarder to the seat proxy, which owns all provider OAuth.
//
// Cloudflare OS never sees a provider token: enrollment returns an opaque handle
// that is stored as an ordinary AiModelConfig.apiToken and sent where an API key
// would go. Everything here is one HTTP call and a shape translation.

import type { SeatProvider, SeatStartResult, SeatCompleteResult }
  from "@gadgets/workshop-shared/seat-types";

type FetchLike = typeof fetch;

export function seatProxyUrl(env: Env): string {
  const url = env.SEAT_PROXY_URL;
  if (!url) throw new Error("Seat sign-in is not configured on this server.");
  return url.replace(/\/+$/, "");
}

// The proxy rejects any owner that is not already case-folded: on a case-insensitive
// filesystem "Alice" and "alice" would be the same credential directory while the
// proxy's own lookup stayed case-sensitive, which was a real cross-user hijack.
// Cloudflare OS usernames are not guaranteed lowercase, so fold here.
function ownerHeader(owner: string): Record<string, string> {
  return { "X-Seat-Owner": owner.toLowerCase() };
}

async function readJson(response: Response, what: string): Promise<any> {
  if (!response.ok) {
    // Deliberately does not include the body: it comes from another service and
    // must not be echoed into a user-facing error.
    throw new Error(`Seat ${what} failed (${response.status}).`);
  }
  return await response.json();
}

export async function startSeatAuth(
    env: Env, owner: string, provider: SeatProvider,
    fetchImpl: FetchLike = fetch): Promise<SeatStartResult> {
  const base = seatProxyUrl(env);
  const response = await fetchImpl(`${base}/enroll/${provider}/start`, {
    method: "POST",
    headers: { ...ownerHeader(owner) },
  });
  const body = await readJson(response, "sign-in");
  if (body.kind === "device_code") {
    return {
      enrollId: body.enroll_id,
      kind: "device_code",
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      interval: body.interval,
    };
  }
  return { enrollId: body.enroll_id, kind: "authorize_url", url: body.url };
}

export async function completeSeatAuth(
    env: Env, owner: string, provider: SeatProvider, enrollId: string,
    code: string | undefined,
    fetchImpl: FetchLike = fetch): Promise<SeatCompleteResult> {
  const base = seatProxyUrl(env);
  const response = await fetchImpl(`${base}/enroll/${provider}/complete`, {
    method: "POST",
    headers: { ...ownerHeader(owner), "content-type": "application/json" },
    body: JSON.stringify(code === undefined
      ? { enroll_id: enrollId }
      : { enroll_id: enrollId, code }),
  });
  const body = await readJson(response, "sign-in");
  if (body.status === "pending") return { status: "pending" };
  return {
    status: "complete",
    handle: body.handle,
    models: body.models ?? [],
    // The relay mount matching the provider. The frontend stores this as the
    // model's apiUrl so inference is routed through the proxy.
    apiUrl: `${base}/${provider}`,
  };
}

export async function revokeSeat(
    env: Env, owner: string, handle: string,
    fetchImpl: FetchLike = fetch): Promise<void> {
  const base = seatProxyUrl(env);
  const response = await fetchImpl(`${base}/enroll/${handle}`, {
    method: "DELETE",
    headers: { ...ownerHeader(owner) },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Seat revocation failed (${response.status}).`);
  }
}
```

- [ ] **Step 4: Add the three signatures to the shared API**

In `packages/workshop-shared/src/api.ts`, inside the `AuthenticatedApi` interface, next to
`addModel`, add exactly:

```typescript
  // Seat sign-in. The proxy holds the OAuth tokens; these return only an opaque handle.
  startSeatAuth(provider: SeatProvider): Promise<SeatStartResult>;
  completeSeatAuth(provider: SeatProvider, enrollId: string,
                   code?: string): Promise<SeatCompleteResult>;
  revokeSeat(handle: string): Promise<void>;
```

and add the import at the top of that file:

```typescript
import type { SeatProvider, SeatStartResult, SeatCompleteResult } from "./seat-types.js";
```

Match the file's existing import style — check whether it uses `.js` suffixes and follow it.

- [ ] **Step 5: Add the three delegates to the server**

In `packages/workshop-backend/src/server.ts`, immediately after the `addModel` method in
`AuthenticatedApiImpl`, add:

```typescript
  startSeatAuth(provider: SeatProvider): Promise<SeatStartResult> {
    return startSeatAuth(this.env, this.user.id.name ?? "", provider);
  }
  completeSeatAuth(provider: SeatProvider, enrollId: string,
                   code?: string): Promise<SeatCompleteResult> {
    return completeSeatAuth(this.env, this.user.id.name ?? "", provider, enrollId, code);
  }
  revokeSeat(handle: string): Promise<void> {
    return revokeSeat(this.env, this.user.id.name ?? "", handle);
  }
```

with imports added to that file's existing import block. Add nothing else to `server.ts`.

- [ ] **Step 6: Run the tests and the type check**

Run: `pnpm --filter @gadgets/workshop-backend exec vitest run src/seat-auth.test.ts`
Expected: 9 passed.
Then: `pnpm --filter @gadgets/workshop-backend types:check`
Report any pre-existing errors separately from new ones.

- [ ] **Step 7: Commit**

```bash
git add packages/workshop-backend/src/seat-auth.ts packages/workshop-backend/src/seat-auth.test.ts packages/workshop-shared/src/api.ts packages/workshop-backend/src/server.ts
git commit -m "feat(seats): backend seat-auth forwarder and RPC methods"
```

---

### Task 3: Sign-in component

**Files:**
- Create: `packages/workshop-frontend/src/SeatSignInButtons.tsx`
- Create: `packages/workshop-frontend/src/SeatSignInButtons.test.tsx`
- Modify: `packages/workshop-frontend/src/AddModelModal.tsx` (mount only)

**Interfaces:**
- Produces: `<SeatSignInButtons authenticatedApi onEnrolled />`, where
  `onEnrolled(provider, handle, models, apiUrl)` fires once a seat is enrolled.

The component owns the whole walkthrough: pick a provider, open consent, paste the code back (or
wait while we poll for OpenAI), then hand the result up. It must never render the handle.

- [ ] **Step 1: Read the existing tests for conventions**

Read `packages/workshop-frontend/src/FeatureFlagsContext.test.tsx` first and follow whatever
testing library and setup it uses. Do not introduce a different one.

- [ ] **Step 2: Write the failing test**

Write `SeatSignInButtons.test.tsx` covering, with a stub `authenticatedApi`:
- Both provider buttons render.
- Clicking the Anthropic button calls `startSeatAuth("anthropic")` and then shows the returned
  authorize URL as a link plus an input for the code.
- Submitting a pasted code calls `completeSeatAuth("anthropic", enrollId, code)` and then calls
  `onEnrolled` with the handle, models and apiUrl.
- **The handle is never rendered.** After a successful enrollment, assert the handle string does
  not appear anywhere in the container's text content. This is the test that matters most.
- A rejected code shows an error and leaves the user able to retry.
- For OpenAI, the user code and verification URI are shown, and `completeSeatAuth` is polled until
  it stops returning `pending`. Use fake timers rather than real waiting.

Use the exact assertions you need; the point is the behaviours above, not particular wording.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @gadgets/workshop-frontend exec vitest run src/SeatSignInButtons.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 4: Write the component**

Build it with `@cloudflare/kumo` components already used in `AddModelModal.tsx` (`Button`,
`Input`, `SensitiveInput`) so it matches the surrounding UI. Requirements:

- Two buttons: "Sign in with Claude subscription" and "Sign in with ChatGPT subscription".
- After `startSeatAuth`, for `authorize_url`: render the URL as a link that opens in a new tab,
  and an input labelled so the user knows to paste the whole value **including the `#` and
  everything after it** — Anthropic shows `code#state` and dropping the suffix breaks the exchange.
- For `device_code`: show the user code and verification URI, and poll `completeSeatAuth` on the
  returned `interval` (seconds) until it returns `complete`. Stop polling when the component
  unmounts.
- On completion call `onEnrolled(provider, handle, models, apiUrl)`. Never render the handle.
- On error show a short message and allow another attempt.
- Add a brief note that the consent screen will say "Claude Code" — users otherwise reasonably
  wonder whether they are being phished.

- [ ] **Step 5: Mount it in the Add Model dialog**

In `AddModelModal.tsx`, render `<SeatSignInButtons>` above the existing provider `Select`, wired so
`onEnrolled` fills in the model list and pre-fills `apiToken` with the handle and `apiUrl` with the
returned value — then the user picks a model and submits through the existing `handleSubmit`
unchanged. Keep the edit to the smallest number of lines that achieves this; do not restructure the
component.

- [ ] **Step 6: Run tests and type check**

Run: `pnpm --filter @gadgets/workshop-frontend exec vitest run`
Then: `pnpm --filter @gadgets/workshop-frontend types:check`
Report exact results.

- [ ] **Step 7: Commit**

```bash
git add packages/workshop-frontend/src/SeatSignInButtons.tsx packages/workshop-frontend/src/SeatSignInButtons.test.tsx packages/workshop-frontend/src/AddModelModal.tsx
git commit -m "feat(seats): sign-in buttons in the Add Model dialog"
```

---

### Task 4: Onboarding entry point and end-to-end check

**Files:**
- Modify: `packages/workshop-frontend/src/OnboardingWizard.tsx` (mount only)

- [ ] **Step 1: Find the model-setup step**

Read `OnboardingWizard.tsx` and locate the step that offers to add an AI provider (around the copy
"Plug in personal API tokens from any provider"). Report what you find before editing.

- [ ] **Step 2: Mount the component there**

Add `<SeatSignInButtons>` to that step with the same `onEnrolled` behaviour as the Add Model
dialog. If onboarding does not have a natural place to pick a model afterwards, have it enroll and
then add the seat's first model automatically, and say in your report that you did so.

- [ ] **Step 3: Verify the whole frontend still builds**

Run: `pnpm --filter @gadgets/workshop-frontend types:check`
Then: `pnpm --filter @gadgets/workshop-frontend exec vitest run`
Then: `pnpm --filter @gadgets/workshop-frontend exec vite build`
All three must succeed. Report exact output.

- [ ] **Step 4: Commit**

```bash
git add packages/workshop-frontend/src/OnboardingWizard.tsx
git commit -m "feat(seats): offer seat sign-in during onboarding"
```

---

## Out of scope

Running the flow against a live subscription seat, which needs a human. Removing the dead
CLI-era code in `seat-proxy` (`providers.CONFIG_DIR_ENV`, `LOGIN_COMMAND`, the unreachable OpenAI
branch of `oauth.exchange_code`, and the "re-run the CLI login" messages) is tracked in that
plan's ledger.
