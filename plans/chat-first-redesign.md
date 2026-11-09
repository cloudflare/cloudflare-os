# Chat-first redesign

Implements the "Messing Around" page of the Cloudflare OS Figma file (`4SHhZFjGuSpHIIV8shqKDL`,
page `762:24`), everything except the "🪦 ded" section. The design changes the Workshop's unit of
navigation from the workspace to the chat: the sidebar lists recent chats from every workspace, a
home prompt starts a chat, and a workspace becomes an optional, named, shared space that holds
chats, apps and files.

## Screens

| Figma frame | Screen | Route |
|---|---|---|
| `762:25`, `805:251` | Home: greeting, quick actions, composer | `/` |
| `763:1007` | Chat | `/workspace/$id?chat=N` |
| `866:2`, `805:251` | Chat with an app or file open in the side pane | `/workspace/$id?chat=N&w=…` |
| `764:2789`, `764:3332`, `764:1837` | Chat details: Library, Connections, Activity log, Settings | `/workspace/$id?chat=N&details=library` |
| `866:259` | App settings: Access, Publish template, Delete | `/workspace/$id/app/$appId/settings` |
| `866:476`, `871:838`, `871:897` | Shared app, full screen, and its no-access state | `/workspace/$id/app/$appId` |
| `806:1386`, `806:1599`, `806:4630` | Library: Favorites, Apps, Files | `/library` |
| `806:2535` | Workspaces list | `/workspaces` |
| `806:2922`, `806:3496`, `806:4363` | Workspace: Chats, Library, Members, Activity | `/workspace/$id` |
| `814:5105`, `806:4093`, `814:5300`, `814:4890` | Mobile versions of the sidebar, home, chat and workspace library | same routes |
| `816:5455` | Button sheet | shared components |

## Assumptions log

Every decision the designs leave open is recorded in [chat-first-redesign-assumptions.md](chat-first-redesign-assumptions.md).
