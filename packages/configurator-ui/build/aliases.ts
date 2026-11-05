/**
 * The runtime is written against React's API, as Kumo and Base UI are, and runs on
 * `preact/compat`. Shared by the runtime bundle and the test configs, so tests run what ships.
 */
export const PREACT_ALIASES: Record<string, string> = {
  "react": "preact/compat",
  "react-dom": "preact/compat",
  "react-dom/client": "preact/compat/client",
  "react/jsx-runtime": "preact/compat/jsx-runtime",
  "react/jsx-dev-runtime": "preact/compat/jsx-dev-runtime",
};

/**
 * {@link PREACT_ALIASES} for Vite, whose string aliases also rewrite subpaths, so `react` would
 * capture `react/jsx-runtime` before its own entry could.
 */
export const preactViteAliases = (): { find: RegExp; replacement: string }[] =>
  Object.entries(PREACT_ALIASES).map(([specifier, replacement]) => ({
    find: new RegExp(`^${specifier.replaceAll("/", "\\/")}$`),
    replacement,
  }));
