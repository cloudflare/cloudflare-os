# From a gadget to its workspace and a chat

## The problem

In the old Workshop a gadget sat inside its workspace, so where it lived was obvious and its chat
was one click away. The new Library opens a gadget as a page of its own, which is right for using
it. It cut two paths, though:

- **Carrying on building it.** Changes are asked for in a chat, and nothing on the page led to one.
- **Using it with the agent.** An agent can drive a gadget (over its RPC API, which users never need
  to hear about). A slides gadget whose agent builds the deck with you is one of the strongest
  things the product does, and it starts from a chat with the gadget beside it.

The page also stopped saying which workspace the gadget is in.

## The design

The page reuses idioms the app already has, so it adds no new pieces of chrome.

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ [▣ Marketing] [▤ Slides]                         [◌ Chat] [⋯] [👤+] [⤢]  │
 ├──────────────────────────────────────────────────────────────────────────┤
 │                               the gadget                                 │
```

**Where it lives.** The header starts with the workspace's crumb (its icon and title), then the
gadget's own title pill. A chat's header has the same shape (`[folder][title]`), so a gadget reads
as one more thing inside its workspace. The crumb goes to the workspace, with the gadget beside it.
On a gadget's page the title is always shown, because naming the workspace is the point. In a chat
header the crumb is the icon alone, because there the workspace is context and not news. Moving
from the gadget into a chat keeps the crumb, which draws the title back into the icon
(`HeaderBubble` names).

**The way to a chat.** At the far end, ahead of More, sits a labelled **Chat** button. It is the one
labelled control in a row of icons, because it is the page's main way onward. It opens a small menu:

```
  ┌────────────────────────────────────────┐
  │ +  New chat                            │
  │    With Slides beside it               │
  │ ────────────────────────────────────── │
  │ ◌  Q3 board deck                       │
  │    Had Slides open · 2 hours ago       │
  │ ◌  Pricing page copy                   │
  │    Yesterday                           │
  └────────────────────────────────────────┘
```

- **New chat** comes first because it is the common case: "I want the agent to help me with this
  now." It opens `/workspace/$id/new?open=<gadget>`, and the gadget stays beside the chat once the
  first message is sent. The greeting names it: *"Hello Ada, what should we do with Slides?"* That
  one line tells the user the agent knows what is beside it.
- **Chats to carry on in**, at most four, from the gadget's workspace (`listChats()`). Chats that
  last had this gadget beside them (in this browser) come first and say *"Had Slides open"*; the
  rest are the most recent. Chats an agent started (`spawnerName`) are left out: they are its runs,
  not somewhere to talk. Opening one puts the gadget beside it and remembers it there.
- **Nothing to choose between, no menu.** With no chats in the workspace, Chat starts a new one
  straight away. While the chats are read, the menu has New chat and says it is loading them.

## Who sees what

| Viewer | Crumb | Chat |
|---|---|---|
| Owner, or builds in the workspace | yes | yes |
| Given the gadget alone to use (`role: "use"`) | no | no |

People who only use a gadget cannot chat in its workspace, so neither control is shown to them.

## Where it is left out

- **Opened from a chat.** Collapse already goes back beside that chat, and a second way into a
  chat would compete with it.
- **Full screen.** The page is for nothing but the gadget there. The app mark already leads back to
  the workspace's latest chat.
- **Phone.** The crumb gives way to the back arrow. Chat stays, as its icon alone.

## What it deliberately doesn't claim

The backend does not record which chat made a gadget, so the menu never says "the chat it was made
in". "Had it open" comes from what this browser last showed beside each chat (`lastShown`), and the
copy says only that. If the kernel ever records a gadget's origin chat, it would become the first
row ("Where it was made"), above the recent chats.

## Sharing beside it

Share is how a gadget reaches the people who would use it, so where the gadget can be shared its
header shows Share as an icon bubble, in the place the link's was, and Copy link moves into More
(the share dialog has it too). Where it cannot be shared, the link's bubble stays.

## Code

- `blocks/GadgetChatMenu.tsx` is the button and menu (gallery: "SidePane as a gadget's page").
- `blocks/SidePane.tsx` has the page placement's `workspace` (crumb) and `chat` props, and Share.
- `aside/AsidePane.tsx` decides who sees them, from the workspace's role.
- `aside/itemChats.ts` builds the chat list (tested), from `workspaces/useWorkspaceChats.ts`.
- `routes/_app.tsx` has the navigation and decides when to leave Chat out.
  `routes/_app/workspace.$workspaceId.new.tsx` handles the greeting.
