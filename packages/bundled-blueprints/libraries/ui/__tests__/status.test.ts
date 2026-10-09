import { describe, expect, it } from "vitest";

import { statusIndicator } from "../src/status.ts";

describe("statusIndicator", () => {
  it("starts saved unless told otherwise", () => {
    const status = statusIndicator();
    expect(status.element.className).toBe("status");
    expect(status.element.hasAttribute("title")).toBe(false);
    const [dot, label] = Array.from(status.element.children);
    expect(dot!.className).toBe("dot saved");
    expect(label!.textContent).toBe("Saved");
  });

  it("takes an initial state and a title", () => {
    const status = statusIndicator({ kind: "offline", text: "Connecting…", title: "Save status" });
    expect(status.element.title).toBe("Save status");
    expect(status.element.firstElementChild!.className).toBe("dot offline");
    expect(status.element.textContent).toBe("Connecting…");
  });

  it("set changes the dot's class and the text", () => {
    const status = statusIndicator();
    status.set("saving", "Saving…");
    expect(status.element.firstElementChild!.className).toBe("dot saving");
    expect(status.element.lastElementChild!.textContent).toBe("Saving…");
    status.set("bad", "Image failed");
    expect(status.element.firstElementChild!.className).toBe("dot bad");
    expect(status.element.lastElementChild!.textContent).toBe("Image failed");
  });

  it("leaves the DOM alone when the state repeats", () => {
    const status = statusIndicator();
    const label = status.element.lastElementChild!;
    const textNode = label.firstChild!;
    status.set("saved", "Saved");
    expect(label.firstChild).toBe(textNode);
    status.set("saved", "Saved again");
    expect(label.firstChild).not.toBe(textNode);
  });
});
