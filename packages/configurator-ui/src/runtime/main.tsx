import { newMessagePortRpcSession } from "capnweb";
import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { ResourceConfiguratorHost } from "@gadgets/workshop-shared/gatekeeper";
import type { ConfiguratorUISpec } from "../index.ts";
import { Autocomplete } from "./Autocomplete.tsx";
import { Button } from "./Button.tsx";
import { CheckboxList } from "./CheckboxList.tsx";
import { ConfiguratorRoot, ErrorNotice } from "./ConfiguratorRoot.tsx";
import { Field } from "./Field.tsx";
import { ConfiguratorFrame, reportSize } from "./frame.ts";
import { HierarchyPicker } from "./HierarchyPicker.tsx";
import { CONFIGURATOR_MODULE_GLOBAL } from "./moduleGlobal.ts";
import { Notice } from "./Notice.tsx";
import { prefill } from "./prefill.ts";
import { RadioCards } from "./RadioCards.tsx";
import { installGlobalErrorReporting, reportFrontendIssue } from "./reporting.ts";
import { forwardScrolls } from "./scrollForwarding.ts";
import { Section } from "./Section.tsx";
import { createSession } from "./session.ts";
import { createConfiguratorStore } from "./store.ts";
import { TextInput } from "./TextInput.tsx";
import { followHostTheme } from "./theme.ts";

/**
 * What a configurator module's `@gadgets/configurator-ui` imports resolve to. Modules are compiled
 * one file at a time with those imports stripped, so they reach these as globals.
 */
const MODULE_GLOBALS = {
  h: createElement,
  Fragment,
  Section,
  Field,
  TextInput,
  RadioCards,
  CheckboxList,
  Autocomplete,
  HierarchyPicker,
  Button,
  Notice,
};

const loadModule = (): ConfiguratorUISpec<unknown> => {
  Object.assign(globalThis, MODULE_GLOBALS);
  const define = (globalThis as Record<string, unknown>)[CONFIGURATOR_MODULE_GLOBAL];
  if (typeof define !== "function") throw new Error("Configurator UI module did not load.");
  const spec = define() as ConfiguratorUISpec<unknown> | undefined;
  if (!spec) throw new Error("Configurator UI module did not define a configurator UI.");
  return spec;
};

installGlobalErrorReporting();
followHostTheme();

const container = document.getElementById("root")!;
const root = createRoot(container);
const frame = new ConfiguratorFrame();
const { port1, port2 } = new MessageChannel();
window.parent.postMessage({ type: "handshake" }, "*", [port2]);
const host = newMessagePortRpcSession<ResourceConfiguratorHost>(port1, frame);
reportSize(host);
forwardScrolls(host);

/**
 * The types the host accepts a URL of, or undefined from a Workshop too old to have the method. Not
 * reported: a gatekeeper's new frames reach tabs still running the Workshop they were built after.
 */
const loadAcceptedResourceUrlPatterns = async (): Promise<readonly string[] | undefined> => {
  try {
    return await host.getAcceptedResourceUrlPatterns();
  } catch {
    return undefined;
  }
};

const start = async () => {
  const spec = loadModule();
  const context = { ui: host.gatekeeper, acceptedResourceUrlPatterns: await loadAcceptedResourceUrlPatterns() };
  const { values, queries } = await prefill(spec, context, () => host.getInitialResource());
  const session = createSession({
    spec,
    ...context,
    store: createConfiguratorStore(values, queries),
    // A plain promise for the module, rather than the RPC promise a stub method returns.
    ensureResources: async patterns => await host.ensureResources(patterns),
  }, ready => host.setSelectionReady(ready));
  ConfiguratorFrame.attach(frame, session);
  // Base UI dismisses a popup when focus moves elsewhere in this document; moving to the host is
  // not seen as such, so the popup would otherwise stay open over the host's controls.
  window.addEventListener("blur", () => session.store.requestPopupClose());
  root.render(<ConfiguratorRoot session={session} />);
};

start().catch(error => {
  host.setSelectionReady(false);
  reportFrontendIssue("configurator.startup", error, { handled: false, severity: "fatal" });
  root.render(<div id="layout-root"><ErrorNotice error={error} /></div>);
});
