---
name: add-workshop-setting
description: Use when adding, changing, or making live a user setting in the reworked Workshop app (packages/workshop-app): a row on the Settings page, a "Coming soon" setting that becomes real, or anything that should also be changeable from the ⌘K search palette. Covers the shared SettingDefinition, the page row and palette entry adapters, lazy server reads, connection handling, and tests.
---

# Adding a setting to workshop-app

Read `packages/workshop-app/AGENTS.md` first (the layers, "The Settings page" and "Settings from
search"), and load `frontend-conventions`. This skill is the checklist; the AGENTS file is the why.

## The model

⌘K is a control panel as well as a way to go places. A setting must not be written twice, once for
the Settings page and once for search, so the simple ones are **defined once** and each surface
draws its own adapter:

```text
settings/settingDefinition.ts      the type: ToggleSetting | ChoiceSetting | TextSetting
settings/use*Settings.ts           definitions, from a hook (or a pure builder; see below)
settings/SettingDefinitionRow.tsx  page adapter for a toggle or a choice
settings/search/settingEntry.tsx   palette adapter for all three kinds
settings/search/useSettingsSearchEntries.ts   the one list search is built from
blocks/SearchDialog.tsx            the palette itself: entries, pages (SearchPage), keepOpen
routes/-AppSearch.tsx              mounts it, wires navigation, passes `open` as `enabled`
```

A definition carries its `title`, `description`, `section` (which also names its palette group),
`icon`, `keywords`, `remote`, `soon`, its current value and `set`. Search derives everything else:
a toggle flips in place and stays open, shown as a switch at the end of its row (`SearchEntry.on`, only
drawn, as the row is the control: never put a real `Switch` in an entry); a choice goes on to a page of its options (their names are
found by search without being listed as keywords); text goes on to a typing page.

## Which path?

1. **Toggle, choice or one line of text** → write a definition (steps below). Both surfaces follow.
2. **Anything else** (a form, a dialog, a list, a one-off action, a file picker, a popup) → page row
   as usual, and a bespoke entry in `settings/search/` only if it can honestly be done in a
   palette. If not, the existing `sectionEntries` already lead to the part of the page; add the
   part to its `SECTIONS` list the first time it has a live setting. Examples of each already here:
   - `accountEntries.tsx`: sign out and reset, each asked twice with a `confirmPage` (a list page
     with the one thing to do and a Cancel). Anything that cannot be taken back is asked twice.
   - `useNotificationEntries.tsx`, `useUsageEntries.tsx`, `usePictureEntries.tsx`: server-backed
     entries and list pages built from the user's data.
   - Why the picture is a link to Profile: a file picker or popup needs the click's user activation
     and a way to see it through. Do not `await` before opening one.
3. **Connections are not settings.** Search has an entry for each, "Connections › Google", with its
   status at the end of the row (`connections/connectionEntries.tsx`), fed the sidebar's list
   through `AppSearch`'s `connections` prop. It goes to `/connections?open=<key>`, which shows its
   dialog (Manage or Connect). Do not connect from the palette itself: the dialog is where the
   user chooses what access to give.
4. **Admin parts** (`admin-*`) are not offered by search (they hold an audited capability).

## Adding a definition

1. **Page first.** Put the row in the part's file in `settings/` as that AGENTS section says.
   If it is not there yet, mark it `soon` and use `SoonControls`; do **not** define it yet.
2. **Where the definition lives**, by what it reads:
   - Kept on this device (`prefs/`): add to `usePreferenceSettings`. Read the value during render
     and call the hook's `changed()` after writing, as the existing ones do; `prefs/` stores have
     no subscription, and search re-renders when it opens so it sees fresh values.
   - Kept by the server: a hook like `useProfileSettings` (`useApi()`), `remote: true`, `set`
     rejects with why. When the page already holds the state (as `ModelSettings` does with
     `useModelSettings`), write a **pure builder** like `modelChoiceSettings(state, setters)` and
     call it from both the page and `useSettingsSearchEntries`. Pure builders are testable.
3. **Page adapter.** Toggle or choice: `<SettingDefinitionRow setting={…} attempt={attempt} />`
   (pass the part's `useAttempt` `attempt` for server-kept ones; it says "Couldn’t change the
   <title>" and checks the connection). Text: keep `SettingField` / `EditableTitle` and feed them
   from the definition (`value`, `placeholder`, `set`). Do not retype the description or labels.
4. **Palette.** Add the definition to the `definitions` array in `useSettingsSearchEntries`.
   Nothing else: `settingEntry` does the rest, and skips a `soon` definition or a choice with no
   options. To offer it before anything is typed, add it to `suggestedDefinitions` there (three
   at most, in the order wanted: they are listed under one "Settings" heading, below the pages, and
   the empty state is already about 11 rows). If its options come from the server, give the definition
   an `unavailable` state while they are being read, as `modelChoiceSettings` does, so that it is
   listed from the first frame and nothing jumps when they arrive.
5. **Making a `soon` setting live**: replace the `SoonControls` row with the real one, add the
   definition, drop `soon`. Remove the group-level `soon` only when every row in it is live.

## Rules that are easy to miss

- **Nothing is read from the server until search opens.** `AppSearch` is always mounted. A hook that
  loads data must take `enabled` (see `useModelSettings(enabled)`, `useUsage(enabled)`): no read
  while false, read again each time it becomes true, keep what was read while closing.
- **Connection.** The page's `useAttempt` already stops on `notice.blocked()`. In search, set
  `remote: true` on the definition (the adapter calls `useRequireConnection`), or call it yourself
  in a bespoke entry before touching the server. A thrown error shows under the field and leaves
  the palette open; do not swallow it.
- **Layering** (lint-enforced): `blocks/` and `components/` cannot import data folders. `SearchDialog`
  takes plain `SearchEntry`/`SearchPage` values; entries are built in `settings/`; `routes/` wires.
  Navigation goes in through `onOpenSection`, so `settings/` never imports the router.
- **Pages are one level each.** `SearchEntry.onSelect` may return a `SearchPage` (a `list` or a
  `text`) or a promise. Esc, Backspace in an empty list field, and the back arrow each go back one
  page and restore the earlier query; Esc at the root closes. Lists inside a page are not capped;
  groups at the root show eight.
- **Do it in one step where there is one thing to do.** The values of a setting are a page: one
  entry with the current value as `detail`, that opens the options (Theme, Animations, Default
  model). Things the user acts on directly (a connection, a workspace) are an entry each, titled
  as a breadcrumb where they are not obvious ("Connections › Google", "Settings › Profile") and
  saying their state at the end, so that Enter does it and nothing opens a submenu first. A switch
  flips in place. Do not make the user choose a thing and then choose what to do with it.
- **Entries found by a verb.** Where an entry's action depends on its state, put the word for it in
  its keywords and not the other's ("manage" on a connected account, "add" on one that is not), so
  that "manage google" and "add google" each find what they should and a bare "manage" lists what
  can be managed. Do not put a word that fits all of them on all of them: a group shows eight.
- **Name what finds a page's entry in its keywords, and let it carry on.** Give a choice's entry
  the names of its options as keywords. A search that found it by one of them goes on into the
  page and narrows it (`carriedInto`), so "dark" finds Theme and then Dark. A search that found it
  by its own title leaves no option to match and starts the page over, which is what is wanted.
- **What is read for search is read while it is open.** The models, the usage and the library are
  each read with a key or `enabled` that is true only while search is open (`useLibrary(open ? 'search' : null)`),
  and kept while it is shut. Something found by typing that is still being read says "Looking…"
  (`SearchDialog`'s `reading`) rather than that nothing matches.
- **Context only adds.** What a page adds to search (a new chat in the workspace, inviting people) is
  also found by typing, comes first among equals, and never takes anything away: anything found
  with no context is found in every context, and the empty state offers nothing that typing could not
  find. Leave out what is already there: no new chat on the page that starts one. A setting that a
  page reads once, as `useDefaultModel` does, must hear of a change made from search
  (`preferredModelChanged`), or the page it is offered on ignores it.
- **Titles rank.** Search ranks a title that starts with the typed word first, so an entry should
  begin with the word people will type for it. A group shows eight, so what is many (every service
  connection) is cut for a word that fits them all ("connections"), and narrowed by typing a name.
- **Words.** Plain, second person, "Couldn’t …" for failures; curly apostrophes as the rest of the
  app has them.
- **No RPC stubs in `useState`**, and dispose stubs (root `AGENTS.md`). The existing hooks use
  `useApi().api` calls that return plain values.
- **Gallery.** If you change `SearchDialog` (pages, `keepOpen`, errors), update
  `gallery/SearchPreview.tsx` so each state can be seen without a backend.

## Tests and checks

There are no component tests in this package; test the plain parts.

- Definition builders and entry mapping: see `settings/modelChoiceSettings.test.ts` and
  `settings/search/settingEntry.test.ts` (vitest, no DOM). Cover the rules you added: fallbacks,
  what `set` is called with, that a `remote` change is refused while disconnected and a local one is
  not, that `soon` is left out.
- Run from `packages/workshop-app`: `npx tsc --noEmit -p tsconfig.json`, `npx vitest run`, and from
  `public/`: `pnpm exec vp lint packages/workshop-app/src`.
- UI that needs the running app (the page row, the palette flow) is checked in a browser; the
  gallery's Search section runs the palette without a backend. Say what you did not check.
- Update `packages/workshop-app/AGENTS.md` ("The Settings page" / "Settings from search") when the
  rules change, not just when a setting is added.
