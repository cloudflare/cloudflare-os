export type GadgetThemeMode = "light" | "dark";

export const GADGET_THEME_MESSAGE_TYPE = "workshop-gadget-theme";

export const GADGET_THEME_TOKEN_NAMES = [
  "--gadget-color-bg",
  "--gadget-color-panel",
  "--gadget-color-panel-muted",
  "--gadget-color-recessed",
  "--gadget-color-line",
  "--gadget-color-line-strong",
  "--gadget-color-text",
  "--gadget-color-text-strong",
  "--gadget-color-muted",
  "--gadget-color-disabled",
  "--gadget-color-accent",
  "--gadget-color-accent-hover",
  "--gadget-color-accent-text",
  "--gadget-color-focus",
  "--gadget-color-selection-bg",
  "--gadget-color-success",
  "--gadget-color-success-bg",
  "--gadget-color-warning",
  "--gadget-color-warning-bg",
  "--gadget-color-danger",
  "--gadget-color-danger-bg",
] as const;

export type GadgetThemeTokenName = typeof GADGET_THEME_TOKEN_NAMES[number];

export type GadgetThemeSnapshot = {
  mode: GadgetThemeMode;
  tokens: Partial<Record<GadgetThemeTokenName, string>>;
};

/**
 * Platform-owned styles available in every Gadget iframe and PDF export.
 *
 * Element defaults use :where() so a Gadget's existing CSS wins without needing !important.
 * Reusable classes are prefixed with `gadget-` to avoid colliding with application-specific CSS.
 */
export const GADGET_BASE_CSS = String.raw`
:root {
  color-scheme: light;
  --gadget-color-bg: #fcfcfb;
  --gadget-color-panel: #ffffff;
  --gadget-color-panel-muted: #f8f8f7;
  --gadget-color-recessed: #f3f3f1;
  --gadget-color-line: #e8e7e4;
  --gadget-color-line-strong: #cac8c3;
  --gadget-color-text: #1c1a18;
  --gadget-color-text-strong: #100f0d;
  --gadget-color-muted: #77736f;
  --gadget-color-disabled: #a7a39f;
  --gadget-color-accent: #ff4801;
  --gadget-color-accent-hover: #e03f00;
  --gadget-color-accent-text: #ffffff;
  --gadget-color-focus: #ff4801;
  --gadget-color-selection-bg: #ffe9e0;
  --gadget-color-success: #137333;
  --gadget-color-success-bg: #f0faf3;
  --gadget-color-warning: #8a5b00;
  --gadget-color-warning-bg: #fff9e8;
  --gadget-color-danger: #b42318;
  --gadget-color-danger-bg: #fff4f2;
  --gadget-font-sans: "FT Kunst Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --gadget-font-mono: "Apercu Mono Pro", "SF Mono", Menlo, Monaco, Consolas, monospace;
  --gadget-radius-sm: 5px;
  --gadget-radius-md: 7px;
  --gadget-radius-lg: 10px;
  --gadget-shadow-panel: 0 1px 2px rgb(16 15 13 / 0.04), 0 8px 24px rgb(16 15 13 / 0.04);
  --gadget-content-width: 1100px;
  --gadget-transition: 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

:root[data-mode="dark"] {
  color-scheme: dark;
  --gadget-color-bg: oklch(0.115 0.012 285);
  --gadget-color-panel: oklch(0.155 0.011 285);
  --gadget-color-panel-muted: oklch(0.18 0.016 285);
  --gadget-color-recessed: oklch(0.1 0.012 285);
  --gadget-color-line: oklch(0.34 0.022 285);
  --gadget-color-line-strong: oklch(0.44 0.035 285);
  --gadget-color-text: oklch(0.92 0.01 285);
  --gadget-color-text-strong: oklch(0.97 0.006 285);
  --gadget-color-muted: oklch(0.66 0.02 285);
  --gadget-color-disabled: oklch(0.58 0.025 285);
  --gadget-color-accent: #b84e00;
  --gadget-color-accent-hover: #a54200;
  --gadget-color-accent-text: #ffffff;
  --gadget-color-focus: #ff8a5c;
  --gadget-color-selection-bg: rgb(184 78 0 / 0.28);
  --gadget-color-success: oklch(0.792 0.209 151.711);
  --gadget-color-success-bg: oklch(0.25 0.06 150);
  --gadget-color-warning: oklch(0.828 0.189 84.429);
  --gadget-color-warning-bg: oklch(0.27 0.06 84.429);
  --gadget-color-danger: oklch(0.704 0.191 22.216);
  --gadget-color-danger-bg: oklch(0.25 0.065 25.331);
  --gadget-shadow-panel: 0 1px 2px rgb(0 0 0 / 0.18), 0 18px 40px rgb(0 0 0 / 0.2);
}

:where(*, *::before, *::after) { box-sizing: border-box; }
:where(html) { min-height: 100%; background: var(--gadget-color-bg); }
:where(body) {
  min-height: 100vh;
  margin: 0;
  background: var(--gadget-color-bg);
  color: var(--gadget-color-text);
  font: 14px/1.45 var(--gadget-font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
:where(button, input, textarea, select) { font: inherit; }
:where(button, input, textarea, select, a):focus-visible {
  outline: 2px solid var(--gadget-color-focus);
  outline-offset: 2px;
}
:where(a) { color: var(--gadget-color-accent); text-underline-offset: 3px; }
:where(button) {
  min-height: 34px;
  border: 1px solid color-mix(in srgb, var(--gadget-color-accent) 82%, black);
  border-radius: var(--gadget-radius-sm);
  padding: 7px 12px;
  background: var(--gadget-color-accent);
  color: var(--gadget-color-accent-text);
  font-weight: 650;
  cursor: pointer;
  transition: background var(--gadget-transition), border-color var(--gadget-transition), transform var(--gadget-transition);
}
:where(button:hover:not(:disabled)) { background: var(--gadget-color-accent-hover); }
:where(button:active:not(:disabled)) { transform: translateY(1px); }
:where(button:disabled) { cursor: not-allowed; opacity: 0.55; }
:where(input:not([type="checkbox"]):not([type="radio"]), textarea, select) {
  width: 100%;
  border: 1px solid var(--gadget-color-line-strong);
  border-radius: var(--gadget-radius-sm);
  padding: 8px 9px;
  background: var(--gadget-color-panel);
  color: var(--gadget-color-text);
}
:where(textarea) { min-height: 76px; resize: vertical; }
:where(input, textarea)::placeholder { color: var(--gadget-color-disabled); }
:where(table) { width: 100%; border-collapse: collapse; }
:where(th, td) { padding: 11px 14px; border-bottom: 1px solid var(--gadget-color-line); text-align: left; }
:where(th) { background: var(--gadget-color-panel-muted); color: var(--gadget-color-muted); font-size: 12px; font-weight: 600; }
:where(code, pre) { font-family: var(--gadget-font-mono); }
::selection { background: var(--gadget-color-selection-bg); }

.gadget-app { min-height: 100vh; background: var(--gadget-color-bg); color: var(--gadget-color-text); }
.gadget-topbar {
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px;
  border-bottom: 1px solid var(--gadget-color-line);
  background: var(--gadget-color-panel);
  color: var(--gadget-color-text-strong);
  font-weight: 650;
}
.gadget-mark { width: 22px; height: 22px; flex: 0 0 auto; border-radius: var(--gadget-radius-sm); background: var(--gadget-color-accent); }
.gadget-shell { min-height: calc(100vh - 52px); display: grid; grid-template-columns: 184px minmax(0, 1fr); }
.gadget-sidebar { padding: 18px 10px; border-right: 1px solid var(--gadget-color-line); background: var(--gadget-color-panel); }
.gadget-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 8px 10px;
  border-radius: var(--gadget-radius-sm);
  color: var(--gadget-color-muted);
  text-decoration: none;
}
.gadget-nav-item:hover { background: var(--gadget-color-panel-muted); color: var(--gadget-color-text); }
.gadget-nav-item.is-active { background: var(--gadget-color-recessed); color: var(--gadget-color-text-strong); font-weight: 600; }
.gadget-main { width: 100%; max-width: var(--gadget-content-width); margin: 0 auto; padding: 28px; }
.gadget-page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.gadget-page-title { margin: 0; color: var(--gadget-color-text-strong); font-size: 20px; line-height: 1.25; font-weight: 650; letter-spacing: -0.01em; }
.gadget-eyebrow { margin-bottom: 4px; color: var(--gadget-color-muted); font-size: 12px; font-weight: 600; }
.gadget-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.gadget-stack { display: grid; gap: 16px; }
.gadget-panel { overflow: hidden; border: 1px solid var(--gadget-color-line); border-radius: var(--gadget-radius-md); background: var(--gadget-color-panel); box-shadow: var(--gadget-shadow-panel); }
.gadget-panel-header { min-height: 42px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 14px; border-bottom: 1px solid var(--gadget-color-line); background: var(--gadget-color-panel-muted); color: var(--gadget-color-text-strong); font-size: 13px; font-weight: 650; }
.gadget-panel-body { padding: 16px 14px; }
.gadget-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.gadget-metric { min-width: 0; padding: 16px 14px; border-right: 1px solid var(--gadget-color-line); }
.gadget-metric:last-child { border-right: 0; }
.gadget-metric-value { display: block; color: var(--gadget-color-text-strong); font-size: 22px; line-height: 1.2; font-weight: 650; overflow-wrap: anywhere; }
.gadget-metric-label, .gadget-muted { color: var(--gadget-color-muted); font-size: 12px; }
.gadget-field { display: grid; gap: 6px; margin-bottom: 14px; }
.gadget-field > label { color: var(--gadget-color-text-strong); font-weight: 600; }
.gadget-field-help { color: var(--gadget-color-muted); font-size: 12px; }
.gadget-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; border: 1px solid color-mix(in srgb, var(--gadget-color-accent) 82%, black); border-radius: var(--gadget-radius-sm); padding: 7px 12px; background: var(--gadget-color-accent); color: var(--gadget-color-accent-text); font-weight: 650; text-decoration: none; cursor: pointer; }
.gadget-button:hover:not(:disabled) { background: var(--gadget-color-accent-hover); }
.gadget-button.is-secondary { border-color: var(--gadget-color-line-strong); background: var(--gadget-color-panel); color: var(--gadget-color-text); }
.gadget-button.is-secondary:hover:not(:disabled) { background: var(--gadget-color-panel-muted); }
.gadget-button.is-danger { border-color: var(--gadget-color-danger); background: var(--gadget-color-danger); color: #fff; }
.gadget-table-wrap { width: 100%; overflow: auto; }
.gadget-table { width: 100%; border-collapse: collapse; }
.gadget-table th, .gadget-table td { padding: 11px 14px; border-bottom: 1px solid var(--gadget-color-line); text-align: left; }
.gadget-table th { background: var(--gadget-color-panel-muted); color: var(--gadget-color-muted); font-size: 12px; font-weight: 600; white-space: nowrap; }
.gadget-table tr:last-child td { border-bottom: 0; }
.gadget-badge { display: inline-flex; align-items: center; min-height: 22px; border: 1px solid var(--gadget-color-line); border-radius: 999px; padding: 2px 8px; background: var(--gadget-color-panel-muted); color: var(--gadget-color-muted); font-size: 12px; line-height: 1.3; }
.gadget-badge.is-success { border-color: color-mix(in srgb, var(--gadget-color-success) 34%, var(--gadget-color-line)); background: var(--gadget-color-success-bg); color: var(--gadget-color-success); }
.gadget-badge.is-warning { border-color: color-mix(in srgb, var(--gadget-color-warning) 34%, var(--gadget-color-line)); background: var(--gadget-color-warning-bg); color: var(--gadget-color-warning); }
.gadget-badge.is-danger { border-color: color-mix(in srgb, var(--gadget-color-danger) 34%, var(--gadget-color-line)); background: var(--gadget-color-danger-bg); color: var(--gadget-color-danger); }
.gadget-chip { display: inline-flex; align-items: center; min-height: 24px; border: 1px solid var(--gadget-color-line); border-radius: 999px; padding: 2px 8px; background: var(--gadget-color-panel-muted); color: var(--gadget-color-text); font-size: 12px; }
.gadget-empty { padding: 44px 20px; color: var(--gadget-color-muted); text-align: center; }
.gadget-callout { border: 1px solid var(--gadget-color-line); border-radius: var(--gadget-radius-md); padding: 14px 16px; background: var(--gadget-color-panel); }
.gadget-callout.is-warning { background: var(--gadget-color-warning-bg); color: var(--gadget-color-warning); }
.gadget-callout.is-danger { background: var(--gadget-color-danger-bg); color: var(--gadget-color-danger); }
.gadget-skeleton { border-radius: var(--gadget-radius-sm); background: linear-gradient(90deg, var(--gadget-color-recessed), var(--gadget-color-panel-muted), var(--gadget-color-recessed)); background-size: 200% 100%; animation: gadget-shimmer 1.4s ease-in-out infinite; }
@keyframes gadget-shimmer { to { background-position: -200% 0; } }

@media (max-width: 700px) {
  .gadget-shell { display: block; }
  .gadget-sidebar { display: none; }
  .gadget-main { padding: 18px; }
  .gadget-page-header { display: block; }
  .gadget-actions { justify-content: flex-start; margin-top: 14px; }
  .gadget-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .gadget-metric { border-bottom: 1px solid var(--gadget-color-line); }
  .gadget-metric:nth-child(2n) { border-right: 0; }
}

@media print {
  :root { color-scheme: light; }
  :where(body), .gadget-app { background: #fff; color: #111; }
  .gadget-sidebar, .gadget-actions, .gadget-button { display: none !important; }
  .gadget-shell { display: block; min-height: auto; }
  .gadget-main { max-width: none; padding: 0; }
  .gadget-panel, .gadget-callout { break-inside: avoid; box-shadow: none; }
}
`.trim();

/** Return JavaScript that installs the platform stylesheet and keeps its theme synchronized. */
export function createGadgetThemeBootstrapSource(initialTheme: GadgetThemeSnapshot): string {
  let theme = {
    mode: initialTheme.mode === "dark" ? "dark" : "light",
    tokens: initialTheme.tokens,
  } satisfies GadgetThemeSnapshot;

  return String.raw`
const __workshopThemeTokenNames = new Set(${JSON.stringify(GADGET_THEME_TOKEN_NAMES)});
const __workshopThemeStyle = ${JSON.stringify(GADGET_BASE_CSS)};
if ("adoptedStyleSheets" in document && typeof CSSStyleSheet !== "undefined" &&
    "replaceSync" in CSSStyleSheet.prototype) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(__workshopThemeStyle);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
} else {
  const style = document.createElement("style");
  style.dataset.workshopGadgetTheme = "";
  style.textContent = __workshopThemeStyle;
  document.documentElement.prepend(style);
}
function __workshopApplyTheme(theme) {
  if (!theme || (theme.mode !== "light" && theme.mode !== "dark") ||
      !theme.tokens || typeof theme.tokens !== "object") return;
  const root = document.documentElement;
  root.dataset.mode = theme.mode;
  root.style.colorScheme = theme.mode;
  for (const name of __workshopThemeTokenNames) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(theme.tokens)) {
    if (__workshopThemeTokenNames.has(name) && typeof value === "string" && value.length <= 512) {
      root.style.setProperty(name, value);
    }
  }
}
__workshopApplyTheme(${JSON.stringify(theme)});
window.addEventListener("message", event => {
  if (event.source === window.parent && event.data?.type === ${JSON.stringify(GADGET_THEME_MESSAGE_TYPE)}) {
    __workshopApplyTheme(event.data.theme);
  }
});
`;
}
