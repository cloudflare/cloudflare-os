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
- Consumers today are `workshop-app` and the Context Library's app (`gatekeeper-context/app`).
  A change to a shared component is made here, for both.
- Keep React and Kumo as peer dependencies so consumers use one runtime and design-system version.
- A Tailwind consumer must include `packages/ui/src` as an `@source`, because the shared components'
  utility classes are compiled by the consuming app.

## Icons

Icons are Hugeicons, the free set. `icons/hugeIcon.tsx` (exported) makes a component of one, which
the apps' own icon modules use; this package's components draw theirs from `icons/icons.ts`.

## Styles And App-Provided State

`styles.css` carries the Gadgets design tokens (Kumo overrides as `light-dark()` pairs, control and
menu sizes, `.appears`, `.chat-fade`). A consumer imports `@gadgets/ui/styles.css` after Tailwind.
Motion level and list-view storage come from the app (`provideMotionLevel`, `watchMotionLevel`,
`MotionProvider`, `ListViewPrefsContext`); without them the components use the system's
reduced-motion setting and keep a list's view only for the visit.

## APIs And Tests

- Prefer a headless behavior primitive plus a Kumo adapter when both are real consumers' needs.
- Keep the headless model free of presentation policy and styled-only fields where practical.
- Preserve accessibility and input parity across mouse, keyboard, touch, and hybrid devices.
- Colocate tests and test observable contracts rather than package boundaries or framework behavior.
