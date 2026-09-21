# Workshop Frontend

This package is the Workshop single-page application. It uses React, TanStack Router, Tailwind,
and Kumo. Follow the repository-wide guidance in `../../AGENTS.md` in addition to this file.

## Architecture

Organize new code by product ownership first and implementation type second.

```text
src/
  routes/       TanStack route declarations and route-level wiring
  pages/        Substantial route-level screens that compose one or more features
  features/     Product features and their owned UI, hooks, and logic
  components/   UI and application primitives shared across unrelated features
  hooks/        Hooks shared across unrelated features
  utils/        Feature-independent utilities
```

The existing tree predates this convention. Apply it to new code and to code being substantially
reworked; do not migrate unrelated files opportunistically.

### Features

Feature directories own product behavior. A feature may contain components, hooks, tests, and
utilities that belong to that behavior.

Start a feature directory flat:

```text
features/chat/composer/
  ChatComposer.tsx
  ComposerAddMenu.tsx
  ComposerAddMenu.test.tsx
  useComposerDraft.ts
  composerTokens.ts
```

Do not create `components/`, `hooks/`, `helpers/`, or `tests/` subdirectories merely to classify
files by implementation type. File names already communicate those types, and tests should usually
remain beside their subject.

Introduce a subdirectory when a coherent internal subsystem has several files or the flat directory
becomes difficult to scan. Name it after its responsibility, such as `draft/`, `tokens/`,
`attachments/`, or `slash-commands/`; avoid generic `helpers/` buckets.

Organize by the reason files change together. Feature-based organization does not replace the
one-component-per-file model.

### Components

Create a separate component file when the component has at least one of these properties:

- It owns meaningful state, effects, or interaction behavior.
- It is independently testable or reusable.
- It represents a distinct UI responsibility.
- Keeping it inline makes the parent difficult to understand.
- It has grown supporting types or logic that obscure the parent's main flow.

Keep small stateless rendering helpers private in their parent's file when they are only used there
and remain easy to understand. Extract them beside the parent when they develop their own behavior
or tests.

Use PascalCase filenames for components and camelCase filenames for hooks and non-component
modules. Prefer direct imports; do not add a barrel file solely to shorten paths.

### Pages And Routes

Files under `src/routes/` define routes. Keep them focused on route concerns: parameters, search
validation, loaders, navigation, and composing the route's page.

A page is a composition boundary, not necessarily a feature. A page may combine several features,
and a feature may appear on several pages.

A small page may remain in its route file. Move a substantial page implementation to
`src/pages/<page>/`, where it can compose feature components. Components and hooks meaningful only
to that page stay in the page directory rather than global `components/` or `hooks/`. Apply the same
flat-first and responsibility-based subdivision rules used for features. Keeping page support code
outside `src/routes/` also keeps it out of TanStack Router's file scanning.

Name every route-level screen component under `src/pages/` with a `Page.tsx` suffix, such as
`HomePage.tsx` or `WorkspacePage.tsx`. Supporting components keep names that describe their own
responsibility, such as `HomeTaskSuggestions.tsx`.

Do not move product behavior into a page merely because the page currently consumes it. Behavior
with independent product meaning or use across pages belongs to `src/features/<feature>/`.

Default uncertain code to the page and promote it when ownership broadens. The current Home page is
an example of code that predates this rule: `components/AppShell/HomeTaskSuggestions.tsx` and
`components/MeshBackground.tsx` have `routes/index.tsx` as their only production consumer. They are
Home-specific composition and presentation rather than shared AppShell primitives, so their target
organization would be:

```text
pages/home/
  HomePage.tsx
  HomeTaskSuggestions.tsx
  MeshBackground.tsx
```

If task suggestions later become an independently meaningful workflow used by other pages, promote
that code to a feature such as `features/task-suggestions/`. Do not begin there based only on
speculative reuse.

Do not edit `src/routeTree.gen.ts`; it is generated.

### Shared Code

`src/components/` and `src/hooks/` are shared application infrastructure, not default destinations.
Code should begin under the feature that owns its behavior.

Reuse alone does not make code generic:

- If multiple parts of one feature use an item, move it to their nearest common feature directory.
- If another feature consumes a concept still owned by the original feature, keep it exported from
  that feature.
- Promote an item to global `components/` or `hooks/` only when unrelated features use the same
  feature-independent abstraction and its API no longer depends on its original feature.
- Do not merge components merely because they look similar. Avoid generic prop-heavy abstractions
  that erase important domain behavior.

Move code only as high in the hierarchy as its ownership requires. For example, a skill pill shared
by the composer and chat history belongs to `features/chat/`, while a generic application icon
button belongs to `components/`.

### Component APIs And Composition

Represent props that are valid only together as one object or a discriminated union. Do not permit
partial configurations:

```tsx
// Avoid: callers can provide a count with no way to dismiss it.
count?: number;
onDismiss?: () => void;

// Prefer: the capability is either complete or absent.
notice?: { count: number; onDismiss: () => void };
```

A controlled value requires a change callback. Otherwise, the component owns the value. Do not copy
a controlled prop into local state with an Effect:

```tsx
// Controlled
value: string;
onValueChange: (value: string) => void;

// Uncontrolled
initialValue?: string;
```

Name callbacks `on<Action>` and pass domain values rather than React setters or browser events. For
example, expose `onModelChange(modelId)` rather than `setSelectedModel` or `onChange(event)`.

Add `children`, named slots, variants, `className`, DOM prop passthrough, or imperative refs only
when a current caller needs that control. Do not add them in anticipation of reuse.

Use context for application-wide values such as authentication, theme, and toasts. Pass
instance-specific feature data and actions through props; do not introduce context merely to avoid
passing them through one or two component levels.

Extract a component or hook when the extracted unit owns a complete concern, such as state and its
transitions, an Effect lifecycle and cleanup, an accessible interaction, or a pure transformation
that can be tested independently. Keep code together when the child would mostly forward markup or
would need the parent's refs, setters, and synchronization callbacks to function.

## Kumo And Styling

Use Kumo components and Kumo semantic design tokens by default. Check Kumo before creating a custom
control, interaction pattern, or visual primitive. Existing Workshop wrappers may be used when they
provide established application behavior that Kumo does not provide directly.

Custom colors and design tokens outside Kumo are prohibited unless the user explicitly requests
them. In particular, do not add:

- Hex, RGB, HSL, or OKLCH color literals in component styles.
- Arbitrary Tailwind color values.
- New application-specific color variables or token families.
- Feature-local replacements for Kumo surfaces, borders, text, status, focus, or interaction tokens.

Use Kumo semantic classes such as `bg-kumo-base`, `text-kumo-subtle`, and `border-kumo-line` rather
than palette colors. Global Kumo token theming is a deliberate application-level decision and must
not be introduced or changed as part of ordinary feature work.

Legacy custom tokens and color declarations in the current codebase are not precedent for new code.
Do not expand their use. Migrate them only as part of explicitly scoped cleanup.

Tailwind remains appropriate for structure: layout, spacing, sizing, positioning, responsive
behavior, and typography. Use custom CSS only for technical behavior that Kumo and utilities cannot
express, such as editor integration or measured overlays; custom CSS does not relax the color and
token rules.

When a Kumo component is unsuitable, record the concrete behavioral or accessibility gap before
adding a shared Workshop abstraction. Do not wrap Kumo solely to restyle it.

## React

- Define components and hooks as named `const` arrow functions by default. This keeps declarations
  before use and avoids relying on function-declaration hoisting. Type props directly rather than
  using `React.FC`. Ensure components wrapped in `memo`, `forwardRef`, or similar APIs retain an
  explicit name for React DevTools and stack traces, using `displayName` when inference is unclear.
- Treat Effects as an escape hatch for synchronizing React with an external system, not as a
  general state-management tool. Follow React's
  [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect) guidance.
- Do not use an Effect to derive render data from props or state. Calculate it during render instead.
- Do not use an Effect for logic caused by a user interaction. Run it in the event handler that
  knows what happened.
- Do not use an Effect to keep two pieces of React state synchronized. Prefer a single source of
  truth, derived values, controlled components, or lifting state.
- Prefer a component `key` when an identity change should reset the component's state.
- Prefer `useSyncExternalStore` for external store subscriptions when it fits.
- Effects that fetch or subscribe must clean up stale work and subscriptions. Components must remain
  correct when Effects are restarted or mounted again in development.
- Avoid chains of Effects that update state only to trigger another Effect.
- Keep state as close as possible to the behavior that owns it.
- Extract a hook when it represents a coherent behavior or is reused, not simply to shorten a file.
- Do not add `useMemo` or `useCallback` by default; use them when identity or expensive computation
  has a concrete effect, and follow existing compiler guidance.
- Preserve keyboard behavior, focus management, and accessible names when extracting interactive UI.
- RPC stubs must follow the disposal and React state rules in the repository-wide `AGENTS.md`.

## Comments

Prefer code that communicates its intent through names, types, and structure. Do not add comments
that narrate what the next line or block already says.

Comments are appropriate for gotchas, non-obvious invariants, external constraints, security or
performance reasoning, and deliberate departures from a convention. Explain why the surprising
choice is necessary, not the mechanics visible in the code. Remove or update comments when the
constraint they describe no longer exists.

## Tests

Colocate unit tests with their subject using `*.test.ts` or `*.test.tsx`. Use a feature-level
`__tests__/` directory only for scenarios that span several modules and have no single owner.

Tests should either protect behavior whose regression would be important, or verify real logic
introduced by the change. Do not test React, JavaScript, TypeScript, Kumo, or another framework's
own behavior merely because it appears in the implementation.

Test observable contracts, product rules, state transitions, accessibility behavior, race handling,
and failure paths. Avoid assertions coupled only to implementation details, trivial passthrough
markup, or behavior already guaranteed by types and the underlying platform. A test should have a
clear failure whose meaning matters to this application.

Behavior-preserving moves should keep tests unchanged apart from imports. Add focused coverage when
an extraction exposes important previously untested logic; do not add tests solely because a file
or component boundary now exists.

Useful commands from the public workspace root:

```bash
pnpm --filter @gadgets/workshop-frontend test:run
pnpm exec tsc -p packages/workshop-frontend/tsconfig.json
pnpm exec tsc -p packages/workshop-frontend/tsconfig.vite.json
pnpm exec vp run -F @gadgets/workshop-frontend build
```

Run `pnpm lint` from the public workspace root before pushing when the broader workspace state
allows it.
