// Runtime light/dark theming for the sandboxed Context Library app.
//
// This app runs in an opaque-origin, network-isolated iframe, so it can't read the Workshop's stored
// theme choice (localStorage) the way workshop-frontend does. Instead the host pushes the resolved
// mode over the RPC bridge (see main.tsx / SandboxedGatekeeperApp.tsx), and we apply it to <html>
// via `data-mode`, matching workshop-frontend's convention so Kumo's semantic tokens and our
// `[data-mode="dark"]` palette (styles.css) resolve consistently.
//
// A subscription is exposed so imperative widgets that can't rely on CSS variables — the CodeMirror
// editor and the emoji picker — can react when the mode changes at runtime.

import {
  applyAccentColor,
  type GatekeeperAppTheme,
} from "@gadgets/workshop-shared/theme";

// The two concrete modes the host resolves `light`/`dark`/`system` down to before pushing it here.
export type ResolvedThemeMode = "light" | "dark";

// Seed from the pre-paint `data-mode` the bootstrap script in index.html set from the OS preference,
// so imperative widgets that read getThemeMode() before the host's RPC arrives start correct.
let current: ResolvedThemeMode =
  document.documentElement.getAttribute("data-mode") === "dark" ? "dark" : "light";
const listeners = new Set<(mode: ResolvedThemeMode) => void>();

export function getThemeMode(): ResolvedThemeMode {
  return current;
}

// Apply a resolved mode to <html> and notify subscribers. Idempotent per value.
export function applyThemeMode(mode: ResolvedThemeMode): void {
  const root = document.documentElement;
  root.setAttribute("data-mode", mode);
  root.style.colorScheme = mode;
  if (mode === current) return;
  current = mode;
  for (const listener of listeners) listener(mode);
}

export function applyAppTheme(theme: GatekeeperAppTheme): void {
  applyThemeMode(theme.mode);
  applyAccentColor(document.documentElement.style, theme.accentColor);
}

// Subscribe to mode changes. Returns an unsubscribe function.
export function subscribeThemeMode(
  listener: (mode: ResolvedThemeMode) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
