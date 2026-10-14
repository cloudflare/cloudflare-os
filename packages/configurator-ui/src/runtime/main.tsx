import { newMessagePortRpcSession } from "capnweb";
import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { ResourceConfiguratorHost } from "@gadgets/workshop-shared/gatekeeper";
import type { ConfiguratorUISpec } from "../index.ts";
import { Autocomplete } from "./Autocomplete.tsx";
import { CheckboxList } from "./CheckboxList.tsx";
import { ConfiguratorRoot, ErrorNotice } from "./ConfiguratorRoot.tsx";
import { Field } from "./Field.tsx";
import { ConfiguratorFrame, forwardScrolls, reportSize } from "./frame.ts";
import { HierarchyPicker } from "./HierarchyPicker.tsx";
import { CONFIGURATOR_MODULE_GLOBAL } from "./moduleGlobal.ts";
import { prefill } from "./prefill.ts";
import { RadioCards } from "./RadioCards.tsx";
import { installGlobalErrorReporting, reportFrontendIssue } from "./reporting.ts";
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

const start = async () => {
  const ui = host.gatekeeper;
  const spec = loadModule();
  const { values, queries } = await prefill(spec, ui, () => host.getInitialResource());
  const session = createSession({ spec, ui, store: createConfiguratorStore(values, queries) },
    ready => host.setSelectionReady(ready));
  ConfiguratorFrame.attach(frame, session);
  root.render(<ConfiguratorRoot session={session} />);
};

start().catch(error => {
  host.setSelectionReady(false);
  reportFrontendIssue("configurator.startup", error, { handled: false, severity: "fatal" });
  root.render(<div id="layout-root"><ErrorNotice error={error} /></div>);
});
