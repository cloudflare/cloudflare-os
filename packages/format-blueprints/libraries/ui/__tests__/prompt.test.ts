import { afterEach, describe, expect, it } from "vitest";

import { PROMPT_STYLES, promptInline } from "../src/prompt.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function open(...args: Parameters<typeof promptInline>) {
  const result = promptInline(...args);
  const overlay = document.body.querySelector(".prompt-overlay") as HTMLElement;
  const input = overlay.querySelector("input") as HTMLInputElement;
  const buttons = Array.from(overlay.querySelectorAll("button")) as HTMLButtonElement[];
  return { result, overlay, input, cancel: buttons[0]!, ok: buttons[1]! };
}

describe("promptInline", () => {
  it("builds the dialog, seeds and focuses the field, and resolves with the text on OK", async () => {
    const { result, overlay, input, ok, cancel } = open("Link to", "https://a.example", "https://");
    expect(overlay.querySelector(".prompt-card .muted")!.textContent).toBe("Link to");
    expect(input.value).toBe("https://a.example");
    expect(input.placeholder).toBe("https://");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(ok.textContent).toBe("OK");
    expect(ok.className).toBe("text-btn primary");
    expect(ok.type).toBe("button");
    expect(cancel.textContent).toBe("Cancel");
    expect(cancel.className).toBe("text-btn");
    expect(overlay.querySelector(".composer-actions")!.children.length).toBe(2);

    input.value = "https://b.example";
    ok.click();
    await expect(result).resolves.toBe("https://b.example");
    expect(document.body.querySelector(".prompt-overlay")).toBeNull();
  });

  it("resolves with the text on Enter", async () => {
    const { result, input } = open("Rename sheet:", "Sheet1");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await expect(result).resolves.toBe("Sheet1");
  });

  it("resolves null on Cancel, Escape, or a mousedown on the backdrop", async () => {
    const first = open("Q");
    first.cancel.click();
    await expect(first.result).resolves.toBeNull();

    const second = open("Q");
    second.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(second.result).resolves.toBeNull();

    const third = open("Q");
    third.overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await expect(third.result).resolves.toBeNull();
    expect(document.body.querySelector(".prompt-overlay")).toBeNull();
  });

  it("keeps the dialog open for a mousedown inside the card", () => {
    const { overlay, input } = open("Q");
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(overlay.isConnected).toBe(true);
  });

  it("takes the placeholder alone or with the OK label as options", () => {
    const plain = open("Enter URL:", "", { placeholder: "https://", okLabel: "Insert" });
    expect(plain.input.placeholder).toBe("https://");
    expect(plain.ok.textContent).toBe("Insert");
    plain.cancel.click();
    const defaults = open("Q");
    expect(defaults.input.placeholder).toBe("");
    expect(defaults.input.value).toBe("");
    expect(defaults.ok.textContent).toBe("OK");
  });

  it("shows the message as text, not markup", () => {
    const { overlay } = open("<b>bold</b>");
    expect(overlay.querySelector(".muted b")).toBeNull();
    expect(overlay.querySelector(".muted")!.textContent).toBe("<b>bold</b>");
  });
});

describe("PROMPT_STYLES", () => {
  it("styles only the dialog's own classes", () => {
    const selectors = PROMPT_STYLES.split("\n").filter(Boolean).map((rule) => rule.slice(0, rule.indexOf("{")).trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector).toMatch(/^\.prompt-(overlay|card)\b/);
    const style = document.createElement("style");
    style.textContent = PROMPT_STYLES;
    document.head.appendChild(style);
    expect((style.sheet as CSSStyleSheet).cssRules.length).toBe(selectors.length);
    style.remove();
  });
});
