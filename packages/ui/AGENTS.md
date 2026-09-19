# Shared UI

`@gadgets/ui` is the shared runtime React UI layer for the Workshop and gatekeeper management apps.
Kumo owns low-level controls and semantic tokens; this package owns reusable Gadgets interaction
patterns and composed components.

## Ownership

- Add a component here when at least two independent frontends need the same feature-independent
  behavior or when consistency across those frontends is an explicit product requirement.
- Keep product data fetching, routing, RPC, permissions, and domain workflows in the consuming app.
- Check Kumo before adding a primitive. Do not wrap Kumo solely to restyle or rename it.
- Export source directly. This package has no publish or emitted-build step and is marked private.
- Keep React and Kumo as peer dependencies so consumers use one runtime and design-system version.
- A Tailwind consumer must include `packages/ui/src` as an `@source`, because the shared components'
  utility classes are compiled by the consuming app.

## APIs And Tests

- Prefer a headless behavior primitive plus a Kumo adapter when both are real consumers' needs.
- Keep the headless model free of presentation policy and styled-only fields where practical.
- Preserve accessibility and input parity across mouse, keyboard, touch, and hybrid devices.
- Colocate tests and test observable contracts rather than package boundaries or framework behavior.
