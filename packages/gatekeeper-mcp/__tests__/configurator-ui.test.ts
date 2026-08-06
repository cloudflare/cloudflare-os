import { describe, expect, it, vi } from "vite-plus/test";

// The real `h` and the controls throw: the sandbox runtime supplies them at load time. These tests
// exercise how a resource URL is read and written, not the markup.
vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) =>
    ({ component, props, children }),
  Section: "Section",
  Field: "Field",
  CheckboxList: "CheckboxList",
  RadioCards: "RadioCards",
}));

async function loadSpec() {
  vi.resetModules();
  return (await import("../src/configurator/server-configurator-ui.js")).default;
}

function propsFor(node: unknown, component: string): Record<string, unknown> {
  const item = node as { component?: unknown; props?: Record<string, unknown>; children?: unknown[] };
  if (item?.component === component) return item.props ?? {};
  for (const child of item?.children ?? []) {
    try { return propsFor(child, component); } catch {}
  }
  throw new Error(`${component} not found`);
}

const ui = { getEndpoint: async () => "https://mcp.acme.com/mcp" } as never;

describe("a grant whose tool list is empty", () => {
  const url = "https://mcp.acme.com/mcp#tool=&tool=";

  it("reopens pinned and empty rather than as a grant over everything", async () => {
    const spec = await loadSpec();
    const values = spec.initialValuesFromResourceUrl({ resourceUrl: url } as never);
    expect(values.mode).toBe("choose");
    expect(values.tools).toBeNull();
  });

  it("cannot be submitted until tools are actually chosen", async () => {
    const spec = await loadSpec();
    const values = spec.initialValuesFromResourceUrl({ resourceUrl: url } as never);
    expect(spec.isReady({ values } as never)).toBe(false);
    expect(spec.isReady({ values: { ...values, tools: " , , " } } as never)).toBe(false);
    expect(spec.isReady({ values: { ...values, tools: "send" } } as never)).toBe(true);
  });

  it("serializes to a scope allowing nothing, never to the bare endpoint", async () => {
    // Unreachable while `isReady` holds, but this is the line that decides how being wrong fails.
    const spec = await loadSpec();
    const built = await spec.resourceUrl(
      { values: { mode: "choose", tools: ",,," }, ui } as never);
    expect(built).toBe("https://mcp.acme.com/mcp#tool=");
    expect(built).not.toBe("https://mcp.acme.com/mcp");
  });
});

describe("an ordinary grant", () => {
  it("shows every tool as a disabled preview for an all-tools grant", async () => {
    const spec = await loadSpec();
    const rendered = JSON.stringify(spec.render({
      values: { mode: "all", tools: null },
      setValues: vi.fn(),
      ui: { listToolOptions: vi.fn() },
    } as never));
    expect(rendered).toContain("CheckboxList");
    expect(rendered).toContain('"disabled":true');
    expect(rendered).toContain('"allSelected":true');
  });

  it("round-trips the tools it names", async () => {
    const spec = await loadSpec();
    const built = await spec.resourceUrl(
      { values: { mode: "choose", tools: "send,list" }, ui } as never);
    expect(built).toBe("https://mcp.acme.com/mcp#tool=send&tool=list");

    const values = spec.initialValuesFromResourceUrl({ resourceUrl: built } as never);
    expect(values.mode).toBe("choose");
    expect(values.tools).toBe("send,list");
  });

  it("round-trips tool names containing delimiters", async () => {
    const spec = await loadSpec();
    const values = spec.initialValuesFromResourceUrl({
      resourceUrl: "https://mcp.acme.com/mcp#tool=a%2Cb&tool=percent%25name",
    } as never);
    expect(values.tools).toBe("a%2Cb,percent%25name");
    await expect(spec.resourceUrl({ values, ui } as never)).resolves.toBe(
      "https://mcp.acme.com/mcp#tool=a%2Cb&tool=percent%25name");
  });

  it("encodes server tool names before passing them to CheckboxList", async () => {
    const spec = await loadSpec();
    const rendered = spec.render({
      values: { mode: "choose", tools: null }, setValues: vi.fn(),
      ui: { listToolOptions: async () => [{ value: "a,b", title: "A, B" }] },
    } as never);
    const loadOptions = propsFor(rendered, "CheckboxList").loadOptions as () => Promise<unknown[]>;
    await expect(loadOptions()).resolves.toEqual([{ value: "a%2Cb", title: "A, B" }]);
  });

  it("reads a bare endpoint as the whole server", async () => {
    const spec = await loadSpec();
    const values = spec.initialValuesFromResourceUrl(
      { resourceUrl: "https://mcp.acme.com/mcp" } as never);
    expect(values.mode).toBe("all");
    expect(spec.isReady({ values } as never)).toBe(true);
  });
});

describe("a resource URL the form cannot decode", () => {
  // `decodeURIComponent("%")` throws. This runs before anything renders, so the configurator would
  // show nothing at all and the grant could not even be repaired by hand.
  it("opens instead of throwing", async () => {
    const spec = await loadSpec();
    const values = spec.initialValuesFromResourceUrl(
      { resourceUrl: "https://mcp.acme.com/mcp#tool=%" } as never);
    expect(values.mode).toBe("choose");
    expect(values.tools).toBe("%25");
  });

  it("keeps a well-formed neighbour of a malformed name", async () => {
    const spec = await loadSpec();
    const values = spec.initialValuesFromResourceUrl(
      { resourceUrl: "https://mcp.acme.com/mcp#tool=%&tool=send" } as never);
    expect(values.tools).toBe("%25,send");
    expect(spec.isReady({ values } as never)).toBe(true);
  });
});
