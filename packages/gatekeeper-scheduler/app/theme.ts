export type ResolvedThemeMode = "light" | "dark";

const appliedAccentVariables = new Set<string>();

export function applyThemeMode(mode: ResolvedThemeMode): void {
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.colorScheme = mode;
}

export function applyAccentVariables(values: Record<string, string> | null): void {
  const root = document.documentElement;
  for (const variable of appliedAccentVariables) root.style.removeProperty(variable);
  appliedAccentVariables.clear();
  for (const [variable, value] of Object.entries(values ?? {})) {
    root.style.setProperty(variable, value);
    appliedAccentVariables.add(variable);
  }
}
