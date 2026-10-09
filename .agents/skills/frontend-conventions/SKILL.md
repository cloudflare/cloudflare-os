---
name: frontend-conventions
description: Use for creating, modifying, moving, or reviewing React frontend code anywhere in packages/*, including Workshop pages, gatekeeper management apps, shared UI, components, hooks, forms, interactions, styling, accessibility, and frontend tests.
---

# Frontend Conventions

Apply these conventions to the Workshop SPA, gatekeeper management SPAs, and `@gadgets/ui`.
Package-level `AGENTS.md` files add product-specific rules but do not replace this guidance.

## Ownership And Organization

Organize code by product ownership before implementation type. Feature directories own product
behavior and may contain components, hooks, tests, and utilities that change for the same reason.

Start directories flat. Do not introduce `components/`, `hooks/`, `helpers/`, or `tests/`
subdirectories merely to classify files. Introduce a responsibility-named subsystem directory only
when several files form a coherent unit or the flat directory becomes difficult to scan.

Use PascalCase filenames for components and camelCase filenames for hooks and non-component
modules. Colocate `*.test.ts(x)` files with their subject. Feature organization does not replace
the one-component-per-file model.

Keep product behavior with its product even when another feature consumes it. Promote code only as
high as its ownership requires:

- Code shared within one feature belongs at the nearest common feature directory.
- Feature-independent code shared across unrelated areas of one app may live in that app's
  `components/` or `hooks/` directory.
- Runtime UI shared by independent frontends belongs in `@gadgets/ui`.
- Do not merge components merely because they look similar. Avoid generic prop-heavy abstractions
  that erase domain behavior.

## Components And Hooks

Create a separate component when it owns meaningful state, effects, interactions, accessibility
behavior, or reusable responsibility; represents a distinct UI concern; or obscures its parent's
main flow. Keep small stateless render helpers private until they develop an independent concern.

Extract a hook when it owns a coherent behavior or external synchronization lifecycle, not simply
to shorten a file. Keep code together when an extracted child would mostly forward markup or depend
on the parent's refs, setters, and synchronization callbacks.

Prefer named arrow-function components and hooks. Type props directly rather than using `React.FC`.
Give wrappers such as `memo` and `forwardRef` stable DevTools names.

## Component APIs

Represent props that are valid only together as an object or discriminated union. A controlled
value requires a change callback; otherwise expose an uncontrolled initial value. Do not copy a
controlled prop into local state with an Effect.

Name callbacks `on<Action>` and pass domain values rather than React setters or browser events.
Add `children`, slots, variants, `className`, DOM passthrough, and imperative refs only for current
callers, not speculative reuse.

Use context for genuinely application-wide values such as authentication, theme, and toasts. Pass
instance-specific feature data and actions through props.

## Kumo And Styling

Use Kumo components and semantic tokens by default. Check Kumo and `@gadgets/ui` before creating a
control or interaction pattern. A shared Gadgets component should compose Kumo behavior, not merely
rename or restyle a primitive.

Do not add custom color literals, arbitrary Tailwind colors, feature-local token systems, or local
replacements for Kumo surfaces, borders, text, status, focus, and interaction tokens unless the user
explicitly requests them. Existing legacy colors are not precedent.

Tailwind is appropriate for structure, spacing, sizing, positioning, responsive behavior, and
typography. Use custom CSS only for technical behavior Kumo and utilities cannot express. Global
Kumo token theming is an application-level decision and must not be changed during ordinary feature
work.

When Kumo is unsuitable, identify the concrete behavioral or accessibility gap before introducing
a shared abstraction.

## React

Treat Effects as synchronization with external systems, not as derived-state machinery or a way to
sequence user interactions. Calculate render data during render, keep state near its owner, prefer a
component `key` for identity resets, and use `useSyncExternalStore` for suitable external stores.

Effects that fetch or subscribe must clean up stale work and remain correct when restarted. Avoid
chains of Effects and do not synchronize two pieces of React state when one can be derived.

Do not add `useMemo` or `useCallback` without a concrete identity or performance need. Preserve
keyboard behavior, focus management, accessible names, announcements, and mouse/touch/hybrid input
parity. RPC stubs must follow the disposal and React state rules in the root `AGENTS.md`.

## Comments

Prefer names and types that communicate intent. Comments should explain non-obvious constraints,
security or performance reasons, and deliberate departures from conventions. Do not narrate the
next line. Remove or update comments when their constraint changes.

## Tests

Tests should protect observable behavior, product rules, accessibility, state transitions, races,
and failure paths. Do not test React, JavaScript, Kumo, or another framework's own behavior merely
for coverage. Avoid assertions coupled only to implementation details or trivial passthrough.

Behavior-preserving moves should keep tests unchanged apart from imports. Add focused coverage only
when an extraction exposes important previously untested logic.
