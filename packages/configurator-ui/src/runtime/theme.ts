/**
 * Follows the host's theme. The Workshop sets `color-scheme` on the iframe element, which is what
 * `prefers-color-scheme` reports inside it; Kumo's tokens switch on `data-mode`.
 */
export const followHostTheme = (): void => {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const mode = query.matches ? "dark" : "light";
    document.documentElement.dataset.mode = mode;
    document.documentElement.style.colorScheme = mode;
  };
  apply();
  query.addEventListener("change", apply);
};
