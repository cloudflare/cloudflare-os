import { watch } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
// typescript6 = npm:typescript@6.0.3. The transpileModule compiler API this script relies on is not
// shipped by the TypeScript 7 package (it only exports version metadata); type-checking uses
// the workspace "typescript" (7.x, tsgo), build-time transpilers stay on the JS-based 6.x line.
import ts from "typescript6";
import { loadEnv } from "vite";

const packageDir = resolve(process.argv[2] ?? ".");
const watchMode = process.argv.includes("--watch");
const quietMode = process.argv.includes("--quiet");
const devMode = process.argv.includes("--dev");
const frontendReportingEnabled =
  loadEnv(watchMode || devMode ? "development" : "production", packageDir)
      .VITE_FRONTEND_ERROR_REPORTING === "true";
const configuratorDir = join(packageDir, "src", "configurator");
const generatedDir = join(packageDir, "src", "generated");
const vendorId = basename(packageDir).replace(/^gatekeeper-/, "");
const sourceBase = `app:///gatekeeper/${vendorId}/configurator`;
// Function constructor bodies start on line 3 of their synthetic function source.
const functionBodyLineOffset = 2;
const exceptionSerializerPath = resolve(
  import.meta.dirname, "../packages/error-reporting/src/serialize-exception.ts");

/** What one pass of {@link buildConfiguratorUIs} produced. */
type ConfiguratorBuildResult =
  | { ok: false }
  | { ok: true; total: number; writtenCount: number };

function logInfo(message: string): void {
  if (!quietMode) console.log(message);
}

async function writeFileIfChanged(path: string, contents: string): Promise<boolean> {
  try {
    if (await readFile(path, "utf8") === contents) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
  await writeFile(path, contents);
  return true;
}

let capnwebBundle: string | undefined;
let exceptionSerializerBundle: string | undefined;

async function getCapnwebBundle(): Promise<string> {
  if (capnwebBundle !== undefined) return capnwebBundle;
  capnwebBundle = await readFile(join(packageDir, "node_modules", "capnweb", "dist", "index.js"), "utf8");
  return capnwebBundle;
}

async function getExceptionSerializerBundle(): Promise<string> {
  if (exceptionSerializerBundle !== undefined) return exceptionSerializerBundle;
  const source = await readFile(exceptionSerializerPath, "utf8");
  exceptionSerializerBundle = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: exceptionSerializerPath,
  }).outputText;
  return exceptionSerializerBundle;
}

async function createExceptionSerializerImport(): Promise<string> {
  const source = `//# sourceURL=${sourceBase}/serialize-exception.js\n${await getExceptionSerializerBundle()}`;
  const base64 = Buffer.from(source, "utf8").toString("base64");
  return `import { serializeException } from "data:text/javascript;charset=utf-8;base64,${base64}";`;
}

async function createConfiguratorHtml(configuratorUIModuleSource: string): Promise<string> {
  const capnwebBase64 = Buffer.from(`//# sourceURL=${sourceBase}/capnweb.js\n${await getCapnwebBundle()}`, "utf8").toString("base64");
  const exceptionSerializerImport = frontendReportingEnabled
    ? await createExceptionSerializerImport()
    : "";
  const runtime = `//# sourceURL=${sourceBase}/runtime.js
import { RpcTarget, newMessagePortRpcSession } from "data:text/javascript;charset=utf-8;base64,${capnwebBase64}";
${exceptionSerializerImport}

const frontendReportingEnabled = ${frontendReportingEnabled};
function reportFrontendIssue(failureSite, caught, options = {}) {
  if (!frontendReportingEnabled) return;
  try {
    window.parent.postMessage({
      type: "gadgets.frontend-error.v1",
      report: {
        failureSite,
        severity: options.severity ?? "error",
        handled: options.handled ?? true,
        captureMechanism: options.captureMechanism || "explicit",
        exception: serializeException(caught),
      },
    }, "*");
  } catch {}
}

if (frontendReportingEnabled) {
  window.addEventListener("error", event => {
    if (event.error == null) return;
    reportFrontendIssue("configurator.window-error", event.error,
      { handled: false, captureMechanism: "window.error" });
  });
  window.addEventListener("unhandledrejection", event => reportFrontendIssue(
    "configurator.unhandled-rejection", event.reason,
    { handled: false, captureMechanism: "unhandledrejection" },
  ));
}

const MAX_OPTIONS = 200;
const root = document.getElementById("root");
let host;
let ui;
let spec;
let values = {};
let queryByName = {};
let validationErrorByName = {};
let touchedInputs = {};
// Loaded once per list name and never invalidated, so a configurator that needs a fresh list must
// vary the name (the gateway's tool list is keyed by the chosen server for exactly this reason).
//
// These outlive nothing: the host mints a new iframe whenever the account or resource pattern
// changes, and the sandbox has no allow-same-origin, so each realm starts empty. That is what keeps
// one account's options from appearing in another's picker -- if SandboxedResourceConfigurator ever
// stops being remounted on a fresh key, these must be cleared explicitly instead.
let checkboxOptionsByName = {};
let checkboxFilterByName = {};
let renderedCheckboxNames = new Set();
let isRendering = false;
let suppressAutocompleteFocusRefresh = false;
let renderGeneration = 0;
let parentViewport = { iframeTop: 0, viewportHeight: 0 };
let Section;
let Field;
let TextInput;
let RadioCards;
let CheckboxList;
let Autocomplete;

function childrenArray(children) {
  const items = Array.isArray(children) ? children : [children];
  return items.flat().filter(child => child !== null && child !== undefined && child !== false);
}

function Fragment({ children }) {
  return childrenArray(children);
}

function h(component, props, ...children) {
  if (typeof component === "string") return el(component, props ?? {}, childrenArray(children));
  return component({ ...(props ?? {}), children });
}

let lastPostedHeight = -1;
let lastPostedLayoutHeight = -1;
function postHeight() {
  const docTop = document.documentElement.getBoundingClientRect().top;
  const layoutRoot = document.getElementById("layout-root");
  const layoutBottom = layoutRoot ? layoutRoot.getBoundingClientRect().bottom - docTop : 0;
  const floatingBottom = Math.max(0, ...[...document.querySelectorAll("[data-floating-popup]")]
    .filter(node => node instanceof HTMLElement && node.style.display !== "none")
    .map(node => node.getBoundingClientRect().bottom - docTop));
  const height = Math.ceil(Math.max(layoutBottom, floatingBottom) + 8);
  const layoutHeight = Math.ceil(layoutBottom + 4);
  // Avoid flooding the parent with duplicate resize messages.
  if (height === lastPostedHeight && layoutHeight === lastPostedLayoutHeight) return;
  lastPostedHeight = height;
  lastPostedLayoutHeight = layoutHeight;
  host?.resize(height, layoutHeight);
}

let postHeightScheduled = false;
function postHeightAfterLayout() {
  if (postHeightScheduled) return;
  postHeightScheduled = true;
  requestAnimationFrame(() => {
    postHeightScheduled = false;
    postHeight();
  });
}

function getFocusState() {
  return document.activeElement instanceof HTMLInputElement ? {
    name: document.activeElement.getAttribute("data-configurator-input"),
    start: document.activeElement.selectionStart,
    end: document.activeElement.selectionEnd,
    direction: document.activeElement.selectionDirection,
  } : null;
}

let lastPostedReady;
function hasBlockingCheckboxFailure(entries) {
  return Object.values(entries).some(entry => entry.status === "failed" && !entry.disabled);
}

function pruneCheckboxEntries(entries, renderedNames) {
  for (const name of Object.keys(entries)) if (!renderedNames.has(name)) delete entries[name];
}

function postSelectionState() {
  if (typeof spec?.isReady !== "function") return;
  const ready = !hasBlockingCheckboxFailure(checkboxOptionsByName)
    && Boolean(spec.isReady({ values }));
  if (ready === lastPostedReady) return;
  lastPostedReady = ready;
  host?.setSelectionReady(ready);
}

function setValues(patch) {
  const active = getFocusState();
  values = { ...values, ...patch };
  postSelectionState();
  render(active);
}

function clearFields(...names) {
  for (const name of names.flat()) delete queryByName[name];
}

function el(tag, props = {}, children = []) {
  const node = tag === "svg" || tag === "path"
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "htmlFor") node.setAttribute("for", String(value));
    else if (key === "text") node.textContent = value;
    else if (key === "style" && value && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function optionText(value) {
  return typeof value === "string" ? value.slice(0, 240) : undefined;
}

// The overflow policy is per control, and deliberately has no default. "truncate" suits a
// suggestion list, where stopping early is an inconvenience. "refuse" suits a list that states what
// a grant covers, where silently dropping entries would misstate it.
function sanitizeOptions(options, overflow) {
  if (!Array.isArray(options)) return [];
  if (options.length > MAX_OPTIONS) {
    if (overflow === "refuse") {
      throw new Error("Configurator controls support at most " + MAX_OPTIONS + " options.");
    }
    options = options.slice(0, MAX_OPTIONS);
  }
  return options.flatMap(option => {
    if (!option || typeof option !== "object") return [];
    const value = optionText(option.value);
    const title = optionText(option.title);
    if (!value || !title) return [];
    return [{ value, title, subtitle: optionText(option.subtitle), meta: optionText(option.meta) }];
  });
}

// Configurator values are flat strings, so multi-select state travels as a comma-separated list.
function splitList(value) {
  if (typeof value !== "string") return [];
  return value.split(",").map(entry => entry.trim()).filter(Boolean);
}

function checkboxSelection(options, value, allSelected) {
  return new Set(allSelected ? options.map(option => option.value) : splitList(value));
}

function withUnavailableOptions(options, value) {
  const available = new Set(options.map(option => option.value));
  return [...options, ...splitList(value)
    .filter(selected => !available.has(selected))
    .map(selected => ({ value: selected, title: selected + " (unavailable)" }))];
}

const components = {
  Section({ title = null, children }) {
    return el("section", { className: "section" }, [
      title ? el("h2", { className: "section-title", text: title }) : null,
      ...childrenArray(children),
    ]);
  },

  Field({ label, description, optional, children }) {
    return el("section", { className: "field" }, [
      el("div", { className: "field-header" }, [
        el("label", { className: "field-label", text: label }),
        optional ? el("span", { className: "field-optional", text: "Optional" }) : null,
      ]),
      description ? el("p", { className: "field-description", text: description }) : null,
      childrenArray(children)[0],
    ]);
  },

  TextInput({ name, value, placeholder, onChange, optional, disabled }) {
    const showError = validationErrorByName[name] && touchedInputs[name];
    const input = el("input", {
      className: showError ? "input no-icon invalid" : "input no-icon",
      "data-configurator-input": name,
      value: value || "",
      placeholder,
      disabled,
      autocomplete: "off",
      onblur: () => {
        if (isRendering) return;
        touchedInputs[name] = true;
        render(null);
      },
      oninput: event => {
        touchedInputs[name] = false;
        const nextValue = event.currentTarget.value;
        onChange(nextValue || (optional ? null : ""));
      },
    });
    return el("div", { className: "text-input", "data-name": name }, [
      input,
      showError ? el("p", { className: "input-error", text: validationErrorByName[name] }) : null,
    ]);
  },

  RadioCards({ value, options, onChange }) {
    return el("div", { className: "radio-cards" }, options.map(option => {
      const selected = option.value === value;
      return el("button", { type: "button", className: selected ? "radio-card selected" : "radio-card", onclick: () => onChange(option.value) }, [
        el("span", { className: "radio-title", text: option.title }),
        el("span", { className: "radio-description", text: option.description }),
      ]);
    }));
  },

  CheckboxList({ name, value, loadOptions, onChange, allSelected, disabled }) {
    renderedCheckboxNames.add(name);
    // First render for this list: kick off the one-time load and re-render when it lands.
    if (!checkboxOptionsByName[name]) {
      checkboxOptionsByName[name] = { status: "loading", options: [] };
      Promise.resolve()
        .then(() => loadOptions())
        .then(loaded => {
          checkboxOptionsByName[name] = {
            status: "ready", options: sanitizeOptions(loaded, "refuse"),
          };
        })
        .catch(error => {
          reportFrontendIssue("configurator.checkbox-list-load", error);
          checkboxOptionsByName[name] = {
            status: "failed",
            options: [],
            message: error?.message || String(error),
          };
        })
        .then(() => {
          if (!isRendering) render(null);
        });
    }

    checkboxOptionsByName[name].disabled = Boolean(disabled);
    const { status, options, message } = checkboxOptionsByName[name];
    const selected = checkboxSelection(options, value, allSelected);

    const notice = text => el("div", { className: "checkbox-list", "data-name": name }, [
      el("p", { className: "checkbox-empty", text }),
    ]);
    if (status === "loading") return notice("Loading...");
    if (status === "failed") return notice(message);
    const shownOptions = withUnavailableOptions(options, value);
    if (shownOptions.length === 0) return notice("This server published no tools.");

    // The filter only earns its space once the list is long enough to scroll.
    const filterName = \`\${name}__filter\`;
    const showFilter = shownOptions.length > 6;
    const filter = showFilter ? (checkboxFilterByName[name] || "") : "";
    const needle = filter.trim().toLowerCase();
    const matches = needle ? shownOptions.filter(option =>
      option.value.toLowerCase().includes(needle)
      || option.title.toLowerCase().includes(needle)
      || (option.subtitle || "").toLowerCase().includes(needle)) : shownOptions;

    const emit = next => {
      const ordered = shownOptions.map(option => option.value).filter(option => next.has(option));
      onChange(ordered.length > 0 ? ordered.join(",") : null);
    };

    const children = [];

    if (showFilter) {
      children.push(el("div", { className: "checkbox-filter" }, [
        el("span", { className: "search-icon" }, [
          el("svg", { viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": "true" }, [
            el("path", {
              d: "M7 2.25a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5ZM1.25 7a5.75 5.75 0 1 1 10.21 3.63l3.2 3.2a.59.59 0 0 1-.83.83l-3.2-3.2A5.75 5.75 0 0 1 1.25 7Z",
              fill: "currentColor",
            }),
          ]),
        ]),
        el("input", {
          className: "input",
          "data-configurator-input": filterName,
          value: filter,
          placeholder: "Filter tools...",
          disabled,
          autocomplete: "off",
          type: "search",
          "aria-label": "Filter tools...",
          oninput: event => {
            checkboxFilterByName[name] = event.currentTarget.value;
            render(getFocusState());
          },
        }),
      ]));
    }

    // Toolbar: how many are chosen on the left, bulk actions on the right. Bulk actions apply to
    // what is currently visible, so filtering then "select all" is a deliberate, narrow gesture.
    const allMatchesSelected = matches.length > 0
      && matches.every(option => selected.has(option.value));
    const bulk = [];
    if (matches.length > 0 && !allMatchesSelected) {
      bulk.push(el("button", {
        type: "button",
        className: "checkbox-action",
        disabled,
        text: needle ? \`Select \${matches.length} shown\` : "Select all",
        onclick: () => {
          const next = new Set(selected);
          for (const option of matches) next.add(option.value);
          emit(next);
        },
      }));
    }
    // Clearing a filtered list must leave hidden selections alone.
    const clearable = matches.filter(option => selected.has(option.value));
    if (clearable.length > 0) {
      bulk.push(el("button", {
        type: "button",
        className: "checkbox-action",
        disabled,
        text: needle ? \`Clear \${clearable.length} shown\` : "Clear",
        onclick: () => {
          const next = new Set(selected);
          for (const option of clearable) next.delete(option.value);
          emit(next);
        },
      }));
    }

    children.push(el("div", { className: "checkbox-toolbar" }, [
      el("span", {
        className: selected.size > 0 ? "checkbox-count selected" : "checkbox-count",
        text: selected.size > 0
          ? \`\${selected.size} of \${shownOptions.length} selected\`
          : \`None of \${shownOptions.length} selected\`,
      }),
      bulk.length > 0 ? el("span", { className: "checkbox-actions" }, bulk) : null,
    ]));

    if (matches.length === 0) {
      children.push(el("p", { className: "checkbox-empty", text: \`Nothing matches "\${filter.trim()}".\` }));
      return el("div", { className: "checkbox-list", "data-name": name }, children);
    }

    const rows = matches.map(option => {
      const isSelected = selected.has(option.value);
      return el("label", {
        className: isSelected ? "checkbox-row selected" : "checkbox-row",
      }, [
        el("input", {
          type: "checkbox",
          checked: isSelected,
          disabled,
          onchange: () => {
            const next = new Set(selected);
            if (next.has(option.value)) next.delete(option.value);
            else next.add(option.value);
            emit(next);
          },
        }),
        el("span", { className: "checkbox-text" }, [
          el("span", { className: "checkbox-heading" }, [
            el("span", { className: "checkbox-title", text: option.title }),
            option.meta ? el("span", { className: "checkbox-meta", text: option.meta }) : null,
          ]),
          option.subtitle
            ? el("span", { className: "checkbox-subtitle", text: option.subtitle })
            : null,
        ]),
      ]);
    });

    children.push(el("div", { className: "checkbox-rows", "data-internal-scroller": "" }, rows));
    return el("div", { className: "checkbox-list", "data-name": name }, children);
  },

  Autocomplete({ name, value, placeholder, loadOptions, onChange, optional, onClear, disabled }) {
    const queryName = name || placeholder;
    if (disabled && !value) queryByName[queryName] = "";
    const wrapper = el("div", { className: "autocomplete" });
    const inputWrapper = el("div", { className: "input-wrapper" });
    inputWrapper.append(el("span", { className: "search-icon" }, [
      el("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true" }, [
        el("path", { d: "M7 2.25a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5ZM1.25 7a5.75 5.75 0 1 1 10.21 3.63l3.2 3.2a.59.59 0 0 1-.83.83l-3.2-3.2A5.75 5.75 0 0 1 1.25 7Z", fill: "currentColor" }),
      ]),
    ]));
    const input = el("input", {
      className: "input",
      "data-configurator-input": queryName,
      value: queryByName[queryName] || "",
      placeholder,
      disabled,
      autocomplete: "off",
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": "false",
      "aria-haspopup": "listbox",
    });
    const popup = el("div", { className: "autocomplete-popup", role: "listbox", "data-floating-popup": "", "data-internal-scroller": "", style: { display: "none" } });
    let requestId = 0;
    let debounceTimer;
    const generation = renderGeneration;

    function closePopup() {
      popup.style.display = "none";
      input.setAttribute("aria-expanded", "false");
      postHeightAfterLayout();
    }

    function applyPopupMaxHeight() {
      const POPUP_DEFAULT_MAX = 240;
      const POPUP_MIN = 96;
      const POPUP_MARGIN = 12;
      if (!parentViewport.viewportHeight) {
        popup.style.maxHeight = POPUP_DEFAULT_MAX + "px";
        return;
      }
      const inputRect = input.getBoundingClientRect();
      const inputBottomInParent = parentViewport.iframeTop + inputRect.bottom;
      const available = parentViewport.viewportHeight - inputBottomInParent - POPUP_MARGIN;
      const clamped = Math.max(POPUP_MIN, Math.min(POPUP_DEFAULT_MAX, available));
      popup.style.maxHeight = clamped + "px";
      postHeightAfterLayout();
    }

    popup.addEventListener("__viewport-changed", applyPopupMaxHeight);
    popup.addEventListener("__force-close", () => {
      closePopup();
      input.blur();
    });

    function renderPopup({ loading = false, error = null, options = [] }) {
      if (generation !== renderGeneration) return;
      popup.replaceChildren();
      popup.style.display = "block";
      input.setAttribute("aria-expanded", "true");
      applyPopupMaxHeight();
      if (loading) {
        popup.append(el("div", { className: "autocomplete-empty", text: "Loading..." }));
      } else if (error) {
        popup.append(el("div", { className: "autocomplete-empty", text: error }));
      } else if (options.length === 0) {
        popup.append(el("div", { className: "autocomplete-empty", text: "No matches." }));
      } else {
        for (const option of options) {
          popup.append(el("button", {
            type: "button",
            role: "option",
            className: "autocomplete-option",
            onmousedown: event => event.preventDefault(),
            onclick: () => {
              queryByName[queryName] = option.title;
              input.value = option.title;
              suppressAutocompleteFocusRefresh = true;
              onChange(option.value);
              closePopup();
            },
          }, [
            el("span", { className: "autocomplete-option-main" }, [
              el("span", { className: "autocomplete-option-title", text: option.title }),
              option.subtitle ? el("span", { className: "autocomplete-option-subtitle", text: option.subtitle }) : null,
            ]),
            option.meta ? el("span", { className: "autocomplete-option-meta", text: option.meta }) : null,
          ]));
        }
      }
      postHeightAfterLayout();
    }

    async function refreshNow() {
      if (generation !== renderGeneration || disabled) return;
      const currentRequest = ++requestId;
      renderPopup({ loading: true });
      try {
        const options = sanitizeOptions(await loadOptions(input.value), "truncate");
        if (currentRequest !== requestId) return;
        renderPopup({ options });
      } catch (error) {
        if (currentRequest !== requestId) return;
        reportFrontendIssue("configurator.autocomplete-load", error);
        renderPopup({ error: error?.message || "Could not load options." });
      }
    }

    function refresh() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refreshNow, 180);
    }

    input.addEventListener("input", () => {
      if (disabled) return;
      queryByName[queryName] = input.value;
      if (value) onChange(null);
      refresh();
    });
    input.addEventListener("focus", () => {
      if (suppressAutocompleteFocusRefresh) {
        suppressAutocompleteFocusRefresh = false;
        return;
      }
      refreshNow();
    });
    input.addEventListener("blur", () => setTimeout(closePopup, 120));
    inputWrapper.append(input);
    if ((value || queryByName[queryName]) && !disabled) {
      inputWrapper.append(el("button", {
        type: "button",
        className: "clear-button",
        "aria-label": "Clear",
        onclick: () => {
          queryByName[queryName] = "";
          input.value = "";
          suppressAutocompleteFocusRefresh = true;
          if (onClear) onClear();
          else onChange(null);
          closePopup();
        },
      }, "×"));
    }
    wrapper.append(inputWrapper, popup);
    return wrapper;
  },
};

Section = components.Section;
Field = components.Field;
TextInput = components.TextInput;
RadioCards = components.RadioCards;
CheckboxList = components.CheckboxList;
Autocomplete = components.Autocomplete;

function render(focusState = undefined) {
  if (!root || !spec) return;
  if (focusState === undefined) focusState = getFocusState();
  renderGeneration++;
  renderedCheckboxNames = new Set();
  isRendering = true;
  root.replaceChildren(el("div", { id: "layout-root" }, [
    spec.render({ ui, values, setValues, clearFields, components }),
  ]));
  isRendering = false;
  pruneCheckboxEntries(checkboxOptionsByName, renderedCheckboxNames);
  if (focusState?.name) {
    const input = root.querySelector('[data-configurator-input="' + CSS.escape(focusState.name) + '"]');
    if (input instanceof HTMLInputElement) {
      input.focus();
      if (focusState.start !== null && focusState.end !== null) {
        input.setSelectionRange(Math.min(focusState.start, input.value.length), Math.min(focusState.end, input.value.length), focusState.direction ?? "none");
      }
    }
  }
  postSelectionState();
  postHeightAfterLayout();
}

class ResourceConfiguratorIframe extends RpcTarget {
  async collectResourceUrl() {
    if (hasBlockingCheckboxFailure(checkboxOptionsByName)) {
      throw new Error("Configurator options did not load.");
    }
    const resourceUrl = await spec?.resourceUrl?.({ values, ui });
    if (typeof resourceUrl !== "string" || resourceUrl.length === 0) {
      throw new Error("Configurator did not provide a resource URL.");
    }
    return resourceUrl;
  }

  updateViewport(iframeTop, viewportHeight) {
    if (typeof iframeTop !== "number" || typeof viewportHeight !== "number") return;
    parentViewport = { iframeTop, viewportHeight };
    for (const popup of document.querySelectorAll("[data-floating-popup]")) {
      if (popup instanceof HTMLElement && popup.style.display !== "none") {
        popup.dispatchEvent(new Event("__viewport-changed"));
      }
    }
  }

  windowResized() {
    for (const popup of document.querySelectorAll("[data-floating-popup]")) {
      if (popup instanceof HTMLElement && popup.style.display !== "none") {
        popup.dispatchEvent(new Event("__force-close"));
      }
    }
  }
}

// Fallback URL -> values mapping: extract URLPattern named groups from the resource's pattern and
// seed any values whose keys match a group name (e.g. ".../area/:areaId" -> { areaId }). Used when
// the spec doesn't define initialValuesFromResourceUrl. Numeric/wildcard groups (e.g. "0") are
// ignored.
function defaultValuesFromResourceUrl(resourceUrl, resourceUrlPattern) {
  if (!resourceUrlPattern || resourceUrlPattern === "https://*") return null;
  if (typeof URLPattern === "undefined") return null;
  try {
    const match = new URLPattern(resourceUrlPattern).exec(resourceUrl);
    const groups = match?.pathname?.groups ?? {};
    const out = {};
    for (const [key, value] of Object.entries(groups)) {
      if (typeof value === "string" && value.length > 0 && !/^[0-9]+$/.test(key)) {
        out[key] = decodeURIComponent(value);
      }
    }
    return out;
  } catch (error) {
    return null;
  }
}

// Seed initial form values from a concrete resource URL provided by the host (e.g. an AI agent's
// connection request), so the form opens pre-filled and editable.
async function seedInitialValues() {
  let initialResource = null;
  try {
    initialResource = await host.getInitialResource();
  } catch (error) {
    reportFrontendIssue("configurator.initial-resource-load", error);
    return;
  }
  if (!initialResource || !initialResource.resourceUrl) return;

  let seeded;
  try {
    seeded = typeof spec.initialValuesFromResourceUrl === "function"
      ? await spec.initialValuesFromResourceUrl({
          resourceUrl: initialResource.resourceUrl,
          resourceUrlPattern: initialResource.resourceUrlPattern,
          ui,
        })
      : defaultValuesFromResourceUrl(initialResource.resourceUrl, initialResource.resourceUrlPattern);
  } catch (error) {
    reportFrontendIssue("configurator.initial-values-load", error);
    return;
  }
  if (!seeded || typeof seeded !== "object") return;

  for (const [key, value] of Object.entries(seeded)) {
    if (value === undefined) continue;
    values[key] = value;
    // Autocomplete inputs display the typed query (queryByName), not the value, so seed it too;
    // TextInput/RadioCards read \`values\` directly and ignore queryByName.
    if (typeof value === "string" && value.length > 0) queryByName[key] = value;
  }
}

async function main() {
  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  host = newMessagePortRpcSession(port1, new ResourceConfiguratorIframe());
  ui = host.gatekeeper;

  Object.assign(globalThis, { h, Fragment, Section, Field, TextInput, RadioCards, CheckboxList, Autocomplete });
  spec = new Function(${JSON.stringify(configuratorUIModuleSource)})();
  if (!spec) throw new Error("Configurator UI module did not define a configurator UI.");
  values = { ...(spec.initial || {}) };
  await seedInitialValues();
  postSelectionState();
  render();
}

main().catch(error => {
  reportFrontendIssue("configurator.startup", error, {
    handled: false, severity: "fatal",
  });
  root?.replaceChildren(el("div", { className: "error", text: error?.stack || String(error) }));
  postHeightAfterLayout();
});

new ResizeObserver(postHeight).observe(document.documentElement);

// Forward wheel/touch scrolls to the parent so the user can scroll the host modal even when the
// cursor is over the iframe. Events that something inside the iframe can consume itself are left
// alone, so a scrollable control scrolls rather than moving the modal underneath it.
//
function hasInternalScroller(target, deltaX, deltaY) {
  const scroller = target instanceof Element ? target.closest("[data-internal-scroller]") : null;
  if (!scroller) return false;
  // ponytail: configurator controls mark their own scroller; add the marker to future controls.
  if (deltaY < 0 && scroller.scrollTop > 0) return true;
  if (deltaY > 0 && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1) return true;
  if (deltaX < 0 && scroller.scrollLeft > 0) return true;
  return deltaX > 0 && scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
}

window.addEventListener("wheel", event => {
  // Returning leaves the event to the browser, which already scrolls the right element inside the
  // iframe -- including trackpad momentum, which a manual scrollBy would lose.
  if (hasInternalScroller(event.target, event.deltaX, event.deltaY)) return;
  forwardScroll(event.deltaX, event.deltaY);
}, { passive: true });

let pendingScrollX = 0;
let pendingScrollY = 0;
let scrollForwardScheduled = false;
function forwardScroll(deltaX, deltaY) {
  pendingScrollX += deltaX;
  pendingScrollY += deltaY;
  if (scrollForwardScheduled) return;
  scrollForwardScheduled = true;
  requestAnimationFrame(() => {
    scrollForwardScheduled = false;
    const deltaX = pendingScrollX;
    const deltaY = pendingScrollY;
    pendingScrollX = 0;
    pendingScrollY = 0;
    if (deltaX || deltaY) host?.forwardScroll(deltaX, deltaY);
  });
}

let lastTouchY = 0;
let lastTouchX = 0;
window.addEventListener("touchstart", event => {
  const touch = event.touches[0];
  if (!touch) return;
  lastTouchY = touch.clientY;
  lastTouchX = touch.clientX;
}, { passive: true });
window.addEventListener("touchmove", event => {
  const touch = event.touches[0];
  if (!touch) return;
  // A drag up the screen scrolls content down, matching wheel's sign convention.
  const deltaY = lastTouchY - touch.clientY;
  const deltaX = lastTouchX - touch.clientX;
  lastTouchY = touch.clientY;
  lastTouchX = touch.clientX;
  if (hasInternalScroller(event.target, deltaX, deltaY)) return;
  forwardScroll(deltaX, deltaY);
}, { passive: true });
`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; script-src data: 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'; navigate-to 'none';">
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --color-kumo-base: #fcfcfb;
      --color-kumo-elevated: #f8f8f7;
      --color-kumo-tint: #f3f3f1;
      --color-kumo-line: #1411100f;
      --color-kumo-ring: #cac8c3;
      --color-kumo-default: #1c1a18;
      --color-kumo-subtle: oklch(52% 0.006 60);
      --color-kumo-inactive: oklch(66% 0.005 60);
      --color-kumo-danger: oklch(63.7% 0.237 25.331);
      --color-kumo-danger-tint: #fff1f2;
      --color-kumo-danger-line: #fecdd3;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --color-kumo-base: oklch(0.115 0.012 285);
        --color-kumo-elevated: oklch(0.155 0.011 285);
        --color-kumo-tint: oklch(0.225 0.025 285);
        --color-kumo-line: oklch(0.34 0.022 285);
        --color-kumo-ring: oklch(0.52 0.065 285);
        --color-kumo-default: oklch(0.92 0.01 285);
        --color-kumo-subtle: oklch(0.66 0.02 285);
        --color-kumo-inactive: oklch(0.58 0.025 285);
        --color-kumo-danger: oklch(70.4% 0.191 22.216);
        --color-kumo-danger-tint: oklch(0.25 0.065 25.331);
        --color-kumo-danger-line: oklch(0.4 0.1 25.331);
      }
    }
    html, body { margin: 0; overflow: visible; background: transparent; color: var(--color-kumo-default, #2f261f); font-size: 13px; }
    * { box-sizing: border-box; }
    #root { padding: 2px 2px 4px; }
    .section { display: grid; gap: 12px; }
    .section-title { margin: 0; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--color-kumo-default, #2f261f); }
    .field { display: grid; gap: 0; position: relative; }
    .field-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 2px; }
    .field-label { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--color-kumo-default, #2f261f); }
    .field-optional { font-size: 12px; line-height: 16px; font-weight: 400; color: var(--color-kumo-subtle, #7d746c); }
    .field-description { margin: 0 0 6px; font-size: 12px; line-height: 16px; font-weight: 400; color: var(--color-kumo-subtle, #7d746c); }
    .input-wrapper { position: relative; }
    .search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; color: var(--color-kumo-inactive, #a59b92); pointer-events: none; line-height: 0; }
    .input { display: block; width: 100%; height: 36px; border: 1px solid var(--color-kumo-line, #ded7d0); border-radius: 8px; padding: 8px 10px 8px 30px; background: var(--color-kumo-base, #fff); color: inherit; outline: none; font: inherit; font-size: 13px; line-height: 18px; letter-spacing: -0.25px; }
    .input.no-icon { padding-left: 10px; }
    .input-wrapper:has(.clear-button) .input { padding-right: 34px; }
    .input:focus { border-color: var(--color-kumo-ring, #ff6a00); box-shadow: 0 0 0 2px rgb(255 106 0 / 12%); }
    .input.invalid { border-color: var(--color-kumo-danger, #c2410c); box-shadow: 0 0 0 2px rgb(194 65 12 / 10%); }
    .input:disabled { background: var(--color-kumo-elevated, #f8f5f1); color: var(--color-kumo-subtle, #7d746c); cursor: not-allowed; }
    .input-error { margin: 4px 0 0; font-size: 12px; line-height: 16px; color: var(--color-kumo-danger, #c2410c); }
    .clear-button { position: absolute; right: 9px; top: 50%; transform: translateY(-55%); display: flex; height: 18px; width: 18px; align-items: center; justify-content: center; border: 0; background: transparent; color: var(--color-kumo-subtle, #7d746c); font: inherit; font-size: 16px; font-weight: 300; line-height: 16px; cursor: pointer; opacity: 0.72; }
    .autocomplete { position: relative; }
    .autocomplete-popup { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 10; max-height: 240px; overflow: auto; border: 1px solid var(--color-kumo-line, #ded7d0); border-radius: 8px; background: var(--color-kumo-base, #fff); box-shadow: 0 2px 6px rgb(0 0 0 / 6%); }
    .autocomplete-empty { padding: 8px 10px; font-size: 12px; line-height: 16px; color: var(--color-kumo-subtle, #7d746c); }
    .autocomplete-option { display: flex; min-height: 32px; width: 100%; align-items: center; gap: 8px; border: 0; border-top: 1px solid var(--color-kumo-line, #ded7d0); padding: 6px 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .autocomplete-option:first-child { border-top: 0; }
    .autocomplete-option:hover { background: var(--color-kumo-elevated, #f8f5f1); }
    .autocomplete-option-main { display: flex; min-width: 0; flex: 1; align-items: baseline; gap: 6px; }
    .autocomplete-option-title { min-width: 0; max-width: 72%; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .autocomplete-option-subtitle, .autocomplete-option-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-kumo-subtle, #7d746c); font-size: 12px; }
    .autocomplete-option-subtitle { flex: 1; }
    .autocomplete-option-meta { flex-shrink: 0; }
    .radio-cards { display: grid; gap: 8px; }
    .radio-card { display: grid; gap: 2px; width: 100%; border: 1px solid var(--color-kumo-line, #ded7d0); border-radius: 10px; padding: 10px; background: var(--color-kumo-base, #fff); color: inherit; text-align: left; cursor: pointer; }
    .radio-card:hover { background: var(--color-kumo-elevated, #f8f5f1); }
    .radio-card.selected { border-color: var(--color-kumo-ring, #ff6a00); background: var(--color-kumo-tint, #fff3eb); }
    .checkbox-list { display: grid; gap: 8px; }
    .checkbox-filter { position: relative; display: flex; align-items: center; }
    .checkbox-filter .search-icon { position: absolute; left: 9px; display: flex; color: var(--color-kumo-subtle, #7d746c); pointer-events: none; }
    .checkbox-filter .input { padding-left: 28px; }
    .checkbox-filter .input::-webkit-search-cancel-button { -webkit-appearance: none; }
    .checkbox-toolbar { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .checkbox-count { color: var(--color-kumo-subtle, #7d746c); font-size: 12px; }
    .checkbox-count.selected { color: inherit; font-weight: 500; }
    .checkbox-actions { display: flex; flex-shrink: 0; gap: 10px; }
    .checkbox-action { border: 0; background: none; padding: 0; color: var(--color-kumo-ring, #ff6a00); font: inherit; font-size: 12px; cursor: pointer; }
    .checkbox-action:hover { text-decoration: underline; }
    .checkbox-action:disabled { color: var(--color-kumo-subtle, #7d746c); cursor: not-allowed; text-decoration: none; }
    .checkbox-rows { display: grid; gap: 3px; max-height: 264px; overflow-y: auto; padding: 1px; }
    .checkbox-row { display: flex; align-items: flex-start; gap: 9px; width: 100%; border: 1px solid transparent; border-radius: 7px; padding: 7px 9px; background: var(--color-kumo-base, #fff); color: inherit; text-align: left; cursor: pointer; }
    .checkbox-row:hover { background: var(--color-kumo-elevated, #f8f5f1); }
    .checkbox-row.selected { border-color: var(--color-kumo-ring, #ff6a00); background: var(--color-kumo-tint, #fff3eb); }
    .checkbox-row:has(input:focus-visible) { outline: 2px solid var(--color-kumo-ring, #ff6a00); outline-offset: 1px; }
    .checkbox-row:has(input:disabled) { cursor: not-allowed; opacity: .55; }
    .checkbox-row input { flex-shrink: 0; width: 14px; height: 14px; margin: 2px 0 0; accent-color: var(--color-kumo-ring, #ff6a00); }
    .checkbox-text { display: grid; gap: 1px; min-width: 0; flex: 1; }
    .checkbox-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .checkbox-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .checkbox-meta { flex-shrink: 0; margin-left: auto; border-radius: 4px; background: var(--color-kumo-elevated, #f8f5f1); padding: 1px 5px; color: var(--color-kumo-subtle, #7d746c); font-size: 10.5px; letter-spacing: .01em; white-space: nowrap; }
    .checkbox-row.selected .checkbox-meta { background: var(--color-kumo-base, #fff); }
    .checkbox-subtitle { overflow: hidden; color: var(--color-kumo-subtle, #7d746c); font-size: 12px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
    .checkbox-empty { margin: 0; color: var(--color-kumo-subtle, #7d746c); font-size: 12px; }
    .radio-title { font-weight: 600; }
    .radio-description { color: var(--color-kumo-subtle, #7d746c); font-size: 12px; line-height: 16px; }
    .error { white-space: pre-wrap; color: var(--color-kumo-danger); border: 1px solid var(--color-kumo-danger-line); border-radius: 10px; padding: 10px; background: var(--color-kumo-danger-tint); }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="data:text/javascript;charset=utf-8,${encodeURIComponent(runtime)}"></script>
</body>
</html>`.trim();
}

function blankCode(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

function prepareConfiguratorModule(outputText: string): string {
  return outputText
    .replace(/^import\s+[^;]+from\s+["']@gadgets\/configurator-ui["'];\s*\n?/gm, blankCode)
    .replace(/^import\s+type\s+[^;]+;\s*\n?/gm, blankCode)
    .replace(/^export\s+{};\s*\n?/gm, blankCode)
    .replace(/^\/\/# sourceMappingURL=.*$/gm, blankCode)
    .replace(/export[\t ]+default[\t ]+/, match => "return".padEnd(match.length));
}

async function buildConfiguratorUIs(): Promise<ConfiguratorBuildResult> {
  let configuratorUIs: string[];
  try {
    configuratorUIs = (await readdir(configuratorDir))
      .filter(name => name.endsWith(".tsx"))
      .toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { ok: false };
    throw error;
  }

  await mkdir(generatedDir, { recursive: true });

  let writtenCount = 0;
  for (const configuratorUI of configuratorUIs) {
    const source = await readFile(join(configuratorDir, configuratorUI), "utf8");
    const diagnostics = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.React,
        jsxFactory: "h",
        jsxFragmentFactory: "Fragment",
        removeComments: false,
        sourceMap: frontendReportingEnabled,
        inlineSources: frontendReportingEnabled,
      },
      fileName: configuratorUI,
      reportDiagnostics: true,
    });
    if (diagnostics.diagnostics?.length) {
      const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics.diagnostics, {
        getCanonicalFileName: fileName => fileName,
        getCurrentDirectory: () => packageDir,
        getNewLine: () => "\n",
      });
      throw new Error(formatted);
    }

    const moduleName = basename(configuratorUI, ".tsx");
    const outputName = moduleName + ".txt";
    const moduleCode = prepareConfiguratorModule(diagnostics.outputText);
    if (/^\s*import\s/m.test(moduleCode) || /^\s*export\s+.*\sfrom\s/m.test(moduleCode)) {
      throw new Error(
        `${configuratorUI} generated unsupported import or re-export statements. ` +
        `Configurator UI modules must be self-contained after generation.`);
    }

    const sourceMapReference = frontendReportingEnabled
      ? `\n//# sourceMappingURL=${sourceBase}/${moduleName}.js.map`
      : "";
    const configuratorUIModuleSource =
      `${moduleCode}\n//# sourceURL=${sourceBase}/${moduleName}.js${sourceMapReference}`;
    const outputPath = join(generatedDir, outputName);
    const html = await createConfiguratorHtml(configuratorUIModuleSource);
    const artifactPath = join(generatedDir, `${moduleName}.js`);
    const mapPath = join(generatedDir, `${moduleName}.js.map`);
    if (frontendReportingEnabled && diagnostics.sourceMapText) {
      const artifactContent =
        `${"\n".repeat(functionBodyLineOffset)}${configuratorUIModuleSource}\n`;
      await writeFileIfChanged(artifactPath, artifactContent);
      const sourceMap = JSON.parse(diagnostics.sourceMapText);
      sourceMap.file = `${moduleName}.js`;
      sourceMap.sources = [`${sourceBase}/${configuratorUI}`];
      sourceMap.mappings = ";".repeat(functionBodyLineOffset) + sourceMap.mappings;
      const mapContent = JSON.stringify(sourceMap);
      await writeFileIfChanged(mapPath, mapContent);
    } else {
      await Promise.all([rm(artifactPath, { force: true }), rm(mapPath, { force: true })]);
    }
    const newContent =
      `<!-- Generated by scripts/build-gatekeeper-configurator.ts from src/configurator/${configuratorUI}. Do not edit. -->\n` +
      html;

    // Skip writes when content is unchanged so editors / file watchers don't see spurious changes.
    if (await writeFileIfChanged(outputPath, newContent)) writtenCount++;
  }

  return { ok: true, total: configuratorUIs.length, writtenCount };
}

const initial = await buildConfiguratorUIs();
if (!initial.ok) process.exit(0);

if (initial.writtenCount > 0) {
  console.log(`generated ${initial.writtenCount} configurator UI module${initial.writtenCount === 1 ? "" : "s"}: ${packageDir}`);
} else {
  logInfo(`configurator UI up-to-date (${initial.total} module${initial.total === 1 ? "" : "s"}): ${packageDir}`);
}

if (!watchMode) process.exit(0);

let timer: NodeJS.Timeout | undefined;
watch(configuratorDir, { persistent: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    buildConfiguratorUIs().then(result => {
      if (result.ok && result.writtenCount > 0) {
        console.log(`generated ${result.writtenCount} configurator UI module${result.writtenCount === 1 ? "" : "s"}: ${packageDir}`);
      }
    }).catch(error => {
      console.error(`failed to generate configurator UI modules: ${packageDir}`);
      console.error(error);
    });
  }, 50);
});

logInfo(`watching configurator UI modules: ${configuratorDir}`);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
