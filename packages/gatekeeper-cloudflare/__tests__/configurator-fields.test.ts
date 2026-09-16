// `clearFields` in the sandbox runtime only deletes the autocomplete's typed query
// (`build-gatekeeper-configurator.mjs`: `delete queryByName[name]`) -- it does not touch `values`.
// So a dependent field has to be nulled through `setValues` as well, and forgetting the second half
// is invisible: `isReady` still passes and `resourceUrl` still builds, just pairing the new account
// with the old account's Worker. This test drives the real `render` against a recording JSX runtime
// so that omission fails here instead of producing a binding that queries the wrong resource.

import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => {
  const runtimeComponent = (name: string) => Object.assign(() => undefined, { componentName: name });
  return {
    h: (component: unknown, props: unknown, ...children: unknown[]) =>
      ({ component, props: props ?? {}, children: children.flat() }),
    Fragment: runtimeComponent("Fragment"),
    Section: runtimeComponent("Section"),
    Field: runtimeComponent("Field"),
    Autocomplete: runtimeComponent("Autocomplete"),
    CheckboxList: runtimeComponent("CheckboxList"),
  };
});

const { default: workerConfigurator } = await import(
  "../src/configurator/cloudflare-worker-configurator-ui.js");

type RenderedNode = { component: unknown; props: Record<string, unknown>; children: unknown[] };

function isNode(value: unknown): value is RenderedNode {
  return typeof value === "object" && value !== null && "props" in value && "children" in value;
}

/** Find the control the runtime would render for `name`, wherever it sits in the tree. */
function control(tree: unknown, name: string): Record<string, unknown> {
  if (!isNode(tree)) throw new Error(`No control named ${name} was rendered.`);
  if (tree.props.name === name) return tree.props;
  for (const child of tree.children) {
    try {
      return control(child, name);
    } catch {
      continue;
    }
  }
  throw new Error(`No control named ${name} was rendered.`);
}

/** Render at `values` and return the patches each control's `onChange` would apply. */
function renderWith(values: { accountId: string | null; workerName: string | null }) {
  const patches: Record<string, unknown>[] = [];
  const cleared: string[] = [];
  const tree = workerConfigurator.render({
    values,
    setValues: patch => void patches.push(patch),
    clearFields: (...names) => void cleared.push(...names),
    ui: new Proxy({}, {
      get() { throw new Error("render must not call the ui capability"); },
    }) as never,
  });
  return { tree, patches, cleared };
}

describe("worker configurator field dependencies", () => {
  it("clears the selected Worker when the account changes", () => {
    const { tree, patches, cleared } = renderWith({
      accountId: "0123456789abcdef0123456789abcdef",
      workerName: "old-worker",
    });

    (control(tree, "accountId").onChange as (value: string) => void)("ffffffffffffffffffffffffffffffff");

    // Both halves matter: the query text so the field looks empty, the value so it *is* empty.
    expect(cleared).toContain("workerName");
    expect(patches).toEqual([{
      accountId: "ffffffffffffffffffffffffffffffff",
      workerName: null,
    }]);
  });

  it("is not ready once the account changed, so the stale pair cannot be submitted", () => {
    // The patch is applied over the *previous* values, the way the runtime's `setValues` does
    // (`values = { ...values, ...patch }`). Spreading over a fresh blank state instead would make
    // this pass whether or not the Worker was nulled.
    const before = {
      accountId: "0123456789abcdef0123456789abcdef",
      workerName: "old-worker",
    };
    const { tree, patches } = renderWith(before);
    expect(workerConfigurator.isReady!({ values: before })).toBe(true);

    (control(tree, "accountId").onChange as (value: string) => void)("ffffffffffffffffffffffffffffffff");

    expect(workerConfigurator.isReady!({ values: { ...before, ...patches[0] } })).toBe(false);
  });

  it("only offers Workers once an account is chosen", () => {
    const { tree } = renderWith({ accountId: null, workerName: null });

    expect(control(tree, "workerName").disabled).toBe(true);
  });
});
