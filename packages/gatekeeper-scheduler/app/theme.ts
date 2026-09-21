import {
  applyAccentColor,
  type GatekeeperAppTheme,
} from "@gadgets/workshop-shared/theme";

export type ResolvedThemeMode = "light" | "dark";

export function applyThemeMode(mode: ResolvedThemeMode): void {
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.colorScheme = mode;
}

export function applyAppTheme(theme: GatekeeperAppTheme): void {
  applyThemeMode(theme.mode);
  applyAccentColor(document.documentElement.style, theme.accentColor);
}
