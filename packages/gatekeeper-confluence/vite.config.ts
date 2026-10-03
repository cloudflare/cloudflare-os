// Vite+ per-package settings. Shared by all gatekeepers with a configurator UI and shipped as an
// export of `@gadgets/scripts`, alongside the builder it runs; `withTests` is that config plus the
// shared vitest `test` task.
export { withTests as default } from '@gadgets/scripts/gatekeeper-configurator'
