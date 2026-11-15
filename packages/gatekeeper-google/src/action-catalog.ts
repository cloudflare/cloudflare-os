// What each kind of Google resource can change, and which of those changes a user may let go ahead
// without asking, for the vendor to advertise before anything is connected
// (SupportedResource.actionKinds). Each list is what that resource's gatekeeper submits, so that a
// default chosen here covers what its connections then ask for.

import type { ActionKind, SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { CALENDAR_EVENTS_ACTION, CALENDAR_INVITATIONS_ACTION } from "./calendar-verdict";
import { AUTO_APPROVABLE_ACTIONS as CHAT_ACTIONS } from "./chat";
import { ADD_DOCUMENT_TAB_ACTION, EDIT_DOCUMENT_ACTION } from "./doc-actions";
import { DOC_COMMENT_ACTIONS } from "./doc-comments";
import { DRIVE_ACTIONS } from "./drive-actions";
import { GMAIL_ACTION_KINDS } from "./gmail";
import {
  GMAIL_RESOURCE, GOOGLE_CALENDAR_RESOURCE, GOOGLE_CHAT_RESOURCE, GOOGLE_CHAT_SPACE_RESOURCE,
  GOOGLE_CHAT_THREAD_RESOURCE, GOOGLE_DOC_RESOURCE, GOOGLE_DRIVE_FILE_RESOURCE,
  GOOGLE_DRIVE_FOLDER_RESOURCE, GOOGLE_DRIVE_RESOURCE, GOOGLE_SHEETS_RESOURCE,
  GOOGLE_SLIDES_RESOURCE, SUPPORTED_RESOURCES,
} from "./resources";
import { SHEETS_ACTIONS } from "./sheets-actions";
import { SLIDES_ACTIONS } from "./slides-actions";

type Catalog = NonNullable<SupportedResource["actionKinds"]>;

const automatic = (kinds: ActionKind[]): Catalog => kinds.map(kind => ({ kind, autoApprovable: true }));

// Built on first use, as the modules it reads also import the vendor's.
const catalog = (): Map<string, Catalog> => {
  let chat = automatic(CHAT_ACTIONS);
  let drive = DRIVE_ACTIONS.kinds();
  return new Map<string, Catalog>([
  [GMAIL_RESOURCE.urlPattern, GMAIL_ACTION_KINDS],
  [GOOGLE_DOC_RESOURCE.urlPattern,
    [...automatic([EDIT_DOCUMENT_ACTION, ADD_DOCUMENT_TAB_ACTION]), ...DOC_COMMENT_ACTIONS.kinds()]],
  [GOOGLE_SHEETS_RESOURCE.urlPattern, SHEETS_ACTIONS.kinds()],
  [GOOGLE_SLIDES_RESOURCE.urlPattern, SLIDES_ACTIONS.kinds()],
  [GOOGLE_CALENDAR_RESOURCE.urlPattern, automatic([CALENDAR_EVENTS_ACTION, CALENDAR_INVITATIONS_ACTION])],
  [GOOGLE_CHAT_RESOURCE.urlPattern, chat],
  [GOOGLE_CHAT_SPACE_RESOURCE.urlPattern, chat],
  [GOOGLE_CHAT_THREAD_RESOURCE.urlPattern, chat],
  [GOOGLE_DRIVE_RESOURCE.urlPattern, drive],
  [GOOGLE_DRIVE_FOLDER_RESOURCE.urlPattern, drive],
  [GOOGLE_DRIVE_FILE_RESOURCE.urlPattern, drive],
  ]);
};

let built: SupportedResource[] | undefined;

/** The vendor's resources, each with the kinds of change it makes. BigQuery only reads. */
export const resourcesWithActionKinds = (): SupportedResource[] => {
  if (built) return built;
  let byUrlPattern = catalog();
  return built = SUPPORTED_RESOURCES.map(resource => {
    let actionKinds = byUrlPattern.get(resource.urlPattern);
    return actionKinds ? { ...resource, actionKinds } : resource;
  });
};
