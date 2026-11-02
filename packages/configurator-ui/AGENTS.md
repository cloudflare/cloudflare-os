# Configurator UI

The authoring API (`src/index.ts`, type-only stubs) for optional gatekeeper resource configurator UI
modules, the sandbox runtime that renders them (`src/runtime/`: Kumo components on `preact/compat`),
and the build that bundles both into each configurator's frame (`build/`).

- Gatekeeper configurator UI modules are compiled by `scripts/build-gatekeeper-configurator.ts` as
  part of package builds. Each frame is one self-contained HTML document: the minified runtime, its
  Tailwind/Kumo CSS, and the module, under a content security policy that admits only those scripts
  by hash and allows no network access.
- Kumo and Base UI support only React, so the browser suite (`vitest.browser.config.ts`, Chromium) is
  what catches an upgrade that stops working on Preact; `build/frame.test.ts` drives a generated
  frame over the real Cap'n Web host protocol.
- `pnpm dev-server` rebuilds a gatekeeper's frames when its `src/configurator/` or the runtime's
  `src/runtime/` changes; restart it after editing `build/`, which the watcher has already loaded.
