import type { RpcTarget } from "capnweb";

/** The complete appearance state sent from Workshop to a sandboxed gatekeeper app. */
export interface GatekeeperAppTheme {
  /** The concrete light or dark mode resolved by Workshop. */
  mode: "light" | "dark";
  /** The deployment accent seed, or null to use the app's base palette. */
  accentColor: string | null;
}

/** A sandboxed gatekeeper app capability that receives complete appearance updates. */
export interface GatekeeperAppThemeReceiver extends RpcTarget {
  /** Applies the latest Workshop appearance state. */
  setTheme(theme: GatekeeperAppTheme): void;
}

interface StylePropertyTarget {
  removeProperty(name: string): unknown;
  setProperty(name: string, value: string): unknown;
}

function accentVariables(seed: string): Record<string, string> {
  return {
    "--color-kumo-brand": `light-dark(${seed}, oklch(from ${seed} 0.45 c h))`,
    "--color-kumo-brand-hover": `light-dark(oklch(from ${seed} calc(l - 0.06) c h), oklch(from ${seed} 0.38 c h))`,
    "--color-accent-100": `light-dark(${seed}, oklch(from ${seed} 0.45 c h))`,
    "--color-accent-200": `light-dark(oklch(from ${seed} calc(l + 0.08) c h), oklch(from ${seed} 0.76 c h))`,
    "--text-color-kumo-brand": `light-dark(${seed}, oklch(from ${seed} 0.76 c h))`,
    "--text-color-kumo-link": `light-dark(${seed}, oklch(from ${seed} 0.76 c h))`,
    "--color-selection-bg": `light-dark(oklch(from ${seed} 0.94 calc(c * 0.35) h), oklch(from ${seed} 0.28 calc(c * 0.45) h))`,
    "--color-selection-text": `light-dark(oklch(from ${seed} calc(l - 0.06) c h), oklch(0.97 0.006 285))`,
  };
}

const accentVariableNames = Object.keys(accentVariables("#000"));

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/** Applies an accent seed, or clears the overrides when the seed is invalid or empty. */
export function applyAccentColor(
  target: StylePropertyTarget,
  color: string | null | undefined,
): void {
  if (!color || !isHexColor(color)) {
    for (const name of accentVariableNames) target.removeProperty(name);
    return;
  }

  for (const [name, value] of Object.entries(accentVariables(color))) {
    target.setProperty(name, value);
  }
}
