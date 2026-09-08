import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => {
  function Autocomplete() {}
  function Field() {}
  function Section() {}
  return {
    Autocomplete,
    Field,
    Section,
    h: (component: { name?: string } | string, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type: typeof component === "string" ? component : component.name,
      props: props ?? {},
      children,
    }),
  };
});

type RenderNode = { type?: string; props?: Record<string, unknown>; children?: unknown[] };

describe("Jira configurator render behavior", () => {
  it("requests the default project once across pending project-picker rerenders", async () => {
    const projectConfigurator = (await import("../src/configurator/jira-project-configurator-ui")).default;
    const deferred = Promise.withResolvers<{ value: string; title: string } | null>();
    const ui = {
      listProjects: vi.fn(async () => []),
      getDefaultProject: vi.fn(() => deferred.promise),
      setDefaultProject: vi.fn(async () => null),
    };
    const values = { ...projectConfigurator.initial };
    const setValues = vi.fn((patch: Partial<typeof values> & Record<string, string | undefined>) => Object.assign(values, patch));

    projectConfigurator.render({ values, setValues, ui });
    projectConfigurator.render({ values, setValues, ui });

    expect(ui.getDefaultProject).toHaveBeenCalledTimes(1);
    expect(values.defaultProjectLoadState).toBe("pending");
    expect(findAutocomplete(projectConfigurator.render({ values, setValues, ui }), "projectUrl")?.props?.disabled).toBe(true);

    deferred.resolve({ value: "https://one.atlassian.net/projects/ENG", title: "Engineering" });
    await deferred.promise;
    expect(values).toMatchObject({ defaultProjectLoadState: "loaded", projectUrl: "https://one.atlassian.net/projects/ENG" });
  });

  it("does not clear an existing default when loading it fails and the user makes no default change", async () => {
    const siteConfigurator = (await import("../src/configurator/jira-site-configurator-ui")).default;
    const ui = {
      listSites: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      getDefaultProject: vi.fn(async () => { throw new Error("temporarily unavailable"); }),
      setDefaultProject: vi.fn(async () => null),
    };
    const values = { ...siteConfigurator.initial, siteUrl: "https://one.atlassian.net" };
    const setValues = vi.fn((patch: Partial<typeof values> & Record<string, string | null | undefined>) => Object.assign(values, patch));

    siteConfigurator.render({ values, setValues, ui });
    await ui.getDefaultProject.mock.results[0].value.catch(() => undefined);
    expect(values.defaultProjectLoadState).toBe("failed");

    await expect(siteConfigurator.resourceUrl({ values, ui })).resolves.toBe("https://one.atlassian.net");
    expect(ui.setDefaultProject).not.toHaveBeenCalled();
  });

  it("persists the default only after an explicit user change", async () => {
    const siteConfigurator = (await import("../src/configurator/jira-site-configurator-ui")).default;
    const ui = {
      listSites: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      getDefaultProject: vi.fn(async () => ({ value: "https://one.atlassian.net/projects/OLD", title: "Old" })),
      setDefaultProject: vi.fn(async () => ({ value: "https://one.atlassian.net/projects/ENG", title: "Engineering" })),
    };
    const values = { ...siteConfigurator.initial, siteUrl: "https://one.atlassian.net", defaultProjectLoadState: "loaded" as const, defaultProjectUrl: "https://one.atlassian.net/projects/OLD" };
    const setValues = vi.fn((patch: Partial<typeof values> & Record<string, string | null | undefined>) => Object.assign(values, patch));

    await siteConfigurator.resourceUrl({ values, ui });
    expect(ui.setDefaultProject).not.toHaveBeenCalled();

    const autocomplete = findAutocomplete(siteConfigurator.render({ values, setValues, ui }), "defaultProjectUrl");
    const onChange = autocomplete?.props?.onChange;
    if (typeof onChange !== "function") throw new Error("Default project picker is missing its change handler.");
    onChange("https://one.atlassian.net/projects/ENG");

    await siteConfigurator.resourceUrl({ values, ui });
    expect(ui.setDefaultProject).toHaveBeenCalledWith("https://one.atlassian.net/projects/ENG");
  });
});

function findAutocomplete(node: unknown, name: string): RenderNode | undefined {
  if (!node || typeof node !== "object") return undefined;
  const current = node as RenderNode;
  if (current.type === "Autocomplete" && current.props?.name === name) return current;
  for (const child of current.children ?? []) {
    const found = findAutocomplete(child, name);
    if (found) return found;
  }
  return undefined;
}
