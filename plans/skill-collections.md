# Skill collections in workshop-app

## Did Balint's version lose them?

On purpose, as a concept on screen. It never lost the data. The scaffold's `SkillStore` kept
skills in memory, and its own comment says "what used to be the collection a skill was in is a tag
on it". Balint flattened collections into one list with a tag on each skill. Our port then put the
real Context Library under that tag: each collection the user can read is a tag, and the user's
own `My skills` collection shows as no tag. That kept every skill, but it lost everything you do
to a collection as a whole. Collections are the Context Library's only unit of sharing, so
sharing went with them.

## What main has

Main's Workshop has no skills UI of its own. Its `/context` page is a "coming soon" mock. Skills
live in the Context Library's sandboxed management app (`/gatekeepers/context`,
`gatekeeper-context/app/skills/`), the Skills Navigator. There:

- Collections form a tree, with their skills under them. Each collection is labelled Private,
  Shared, Shared with you (with your role), or Organization.
- A collection can be created (title, description, icon, web or git source), edited, deleted
  (owners and admins), and left (people it was shared with).
- A skill can be added to or uploaded into a chosen collection, and moved, but only within one
  collection.
- Sharing is whole-collection, through the Workshop's user picker. Each person gets a viewer,
  editor or owner role, there is one "Anyone in organization can view" switch, roles can be
  changed and people removed, and owners leave from the share dialog.
- Git-backed collections have tokens and a refresh. Admins manage the public (organization)
  collections. Collections can also hold ordinary documents, not only skills.

Nothing is enabled per workspace or per chat. Every collection in a user's library is ambient to
all of that user's agents. The only workspace link is `everyoneCanView`, which exists so that
sharing a workspace that read a collection doesn't get blocked.

## What workshop-app had, and lacked

It had a flat list of skills in Settings › Skills, with the collection shown as a tag, and a page
for each skill (Preview, Files, Settings). Changing the tag moves the skill between the user's own
collections.

It lacked:

- any view of the collections themselves
- creating an empty collection
- renaming, describing or deleting a collection
- sharing, and seeing who has access
- leaving a collection shared with you
- editing skills in a collection shared with you as editor (only "mine" could be edited)
- adding a skill straight into a collection other than by tag name

The "Workspace skills: share your skills with everyone in a workspace" row is still a "soon"
placeholder.

## How Balint would evolve it

Keep his flat list as the main surface: tags stay, rows stay, and there are no tree or group
headers. Make the collection a thing with a page of its own, the way he gave skills and templates
their own pages:

1. **Settings › Skills › Collections**: a group under the Skill library with one row per
   collection (a `SkillRow`: name, then "3 skills · Shared", "Shared by Grace", "Organization",
   with the owner's picture) and a **New collection** button. The user's own come first with My
   skills leading, then collections shared with them, then the organization's.
2. **Collection page** `/skills/collections/<id>`, laid out like a skill's page. The breadcrumb
   reads Skills › name. The name and description are edited in place by whoever can edit. Tags
   show the skill count, whose it is and your role, with a **Share** button under them (or "Who
   has access" for viewers). There are two tabs:
   - **Skills**: its skills as rows, with search and order, plus Add skill (write it, or upload
     files or a folder) straight into this collection.
   - **Settings**: who has it, with Share. The Danger zone has Delete (owners) or Leave (people
     it was shared with), each asked first.
3. **Share dialog**, the workspace share dialog's twin: who you add as Can use / Can edit (and
   Owner, for owners), the invite field with user search, a row per person with a role menu and
   Remove access, a Leave collection item on your own row (except for the last owner), and
   "Everyone at <site>" as one more row (`everyoneCanView`).
4. On **a skill's page**, its Settings tab gets a Collection row with Open collection, because
   sharing happens at the collection. Skills in a collection shared with you as editor can now be
   edited.

Later, still in his style: the tag on a row could link to its collection; a ⋯ menu on collection
rows (Share…, Leave, Delete) once the right-click/⋯ work lands; and a Workspaces tab or filter if
the kernel ever scopes collections to workspaces.

## Built (this branch)

All four screens above, with no kernel changes. `SkillStore` gains `collections`,
`addCollection`, `updateCollection`, `removeCollection`, `leaveCollection`, `sharing`, `share`
(through `createGatekeeperUserSelection('context', userId)`, then `shareContextCollection`, so the
browser never names an account), `setMemberRole`, `removeMember` and `setEveryoneCanView`. Each
skill now carries `collectionId` and `editable`, from `getContextCollectionPermissions`.
`MemorySkillsBackend` implements all of it for tests and the mock chats.

## Gaps

- Git-backed collections (create, branch, tokens, refresh) aren't offered here. They stay in the
  Context Library's own app.
- Admins can't create or manage organization collections here.
- Collection icons aren't shown or picked.
- A collection's non-skill documents aren't listed, so a collection with only documents shows
  "No skills".
- Moving a skill between collections is still a copy then a delete (see the port plan).
- An owner who isn't the last owner leaves only from the share dialog, as in main.
- "Workspace skills" (sharing with a workspace) is still a placeholder.

## Kernel or gatekeeper changes that would close them

- **Workspace skills**: the Context Library shares with accounts, not workspaces. This would need
  a grant keyed by workspace (gatekeeper-context, plus Workshop support to resolve a workspace's
  members), or a Workshop-side "share with this workspace's members" that calls
  `shareContextCollection` once per member, which wouldn't follow membership changes.
- **Atomic move between collections**: a `moveContextSkillToCollection` in gatekeeper-context, as
  its README already asks for.
- **Auto-use per skill**: somewhere to store it (gatekeeper-context metadata).
- **Display names for members added before sharing existed**: none needed. We show "You" or
  "Someone".
