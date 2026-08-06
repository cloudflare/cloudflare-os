import { describe, it, expect } from "vite-plus/test";
import {
  canProceedWithRequest,
  hasMinimumBalance,
  MINIMUM_CLOUDFLARE_BALANCE,
} from "@gadgets/workshop-shared/limits";

describe("hasMinimumBalance", () => {
  it("rejects null/undefined balances", () => {
    expect(hasMinimumBalance(null)).toBe(false);
    expect(hasMinimumBalance(undefined)).toBe(false);
  });

  it("compares against the minimum threshold", () => {
    expect(hasMinimumBalance(MINIMUM_CLOUDFLARE_BALANCE)).toBe(true);
    expect(hasMinimumBalance(MINIMUM_CLOUDFLARE_BALANCE + 1)).toBe(true);
    expect(hasMinimumBalance(MINIMUM_CLOUDFLARE_BALANCE - 0.01)).toBe(false);
    expect(hasMinimumBalance(0)).toBe(false);
  });
});

describe("canProceedWithRequest", () => {
  it("uses the platform free tier when not connected and within the limit", () => {
    const r = canProceedWithRequest({ withinLimits: true, hasUserToken: false });
    expect(r.allowed).toBe(true);
    expect(r.shouldUseByok).toBe(false);
  });

  it("bills the user's gateway when connected + funded, even within the free tier", () => {
    const r = canProceedWithRequest({
      withinLimits: true,
      hasUserToken: true,
      balance: MINIMUM_CLOUDFLARE_BALANCE + 5,
    });
    expect(r.allowed).toBe(true);
    expect(r.shouldUseByok).toBe(true);
  });

  it("connected with $0 balance still uses the daily free tier", () => {
    const r = canProceedWithRequest({ withinLimits: true, hasUserToken: true, balance: 0 });
    expect(r.allowed).toBe(true);
    expect(r.shouldUseByok).toBe(false); // platform-funded, not the empty account
  });

  it("connected with $0 balance is blocked (add credits) once the free tier is exhausted", () => {
    const r = canProceedWithRequest({ withinLimits: false, hasUserToken: true, balance: 0 });
    expect(r.allowed).toBe(false);
    expect(r.shouldUseByok).toBe(true);
    expect(r.reason).toBeTruthy(); // "add credits" guidance
  });

  it("blocks (connect) when free tier is exhausted and no account is connected", () => {
    const r = canProceedWithRequest({ withinLimits: false, hasUserToken: false });
    expect(r.allowed).toBe(false);
    expect(r.shouldUseByok).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it("blocks when connected but balance below minimum and over the free tier", () => {
    const r = canProceedWithRequest({
      withinLimits: false,
      hasUserToken: true,
      balance: MINIMUM_CLOUDFLARE_BALANCE - 0.5,
    });
    expect(r.allowed).toBe(false);
    expect(r.shouldUseByok).toBe(true);
  });

  it("allows via BYOK when connected with sufficient balance and over the free tier", () => {
    const r = canProceedWithRequest({
      withinLimits: false,
      hasUserToken: true,
      balance: MINIMUM_CLOUDFLARE_BALANCE + 5,
    });
    expect(r.allowed).toBe(true);
    expect(r.shouldUseByok).toBe(true);
  });
});
