// Vite+ per-package settings: the shared configurator `build` and `build:configurator` tasks, plus
// the shared two-pass `test` task, in Node and then in workerd.
export { withWorkerdTests as default } from "@gadgets/scripts/gatekeeper-configurator";
