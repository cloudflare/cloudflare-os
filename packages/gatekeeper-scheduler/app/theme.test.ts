import { afterEach, describe, expect, it } from "vitest";
import { applyAppTheme } from "./theme";

describe("applyAppTheme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-mode");
    document.documentElement.removeAttribute("style");
  });

  it("applies the host mode and accent and can restore the base accent", () => {
    applyAppTheme({ mode: "dark", accentColor: "#3b82f6" });

    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--color-kumo-brand"))
      .toContain("#3b82f6");

    applyAppTheme({ mode: "light", accentColor: null });

    expect(document.documentElement.dataset.mode).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--color-kumo-brand")).toBe("");
  });
});
