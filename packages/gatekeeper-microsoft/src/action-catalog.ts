// What each Microsoft 365 resource can change, and which of those changes a user may let go ahead
// without asking, for the vendor to advertise before anything is connected
// (SupportedResource.actionKinds): each resource's action set, as its sessions submit them.

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { actions as CALENDAR_ACTIONS } from "./calendar-actions";
import { ALL_RESOURCES, CALENDAR_RESOURCE, OUTLOOK_RESOURCE, SHAREPOINT_RESOURCE } from "./microsoft-env";
import { actions as OUTLOOK_ACTIONS } from "./outlook-actions";
import { actions as SHAREPOINT_ACTIONS } from "./sharepoint-actions";

let built: SupportedResource[] | undefined;

/** The vendor's resources, each with the kinds of change it makes, in `ALL_RESOURCES`' order. */
export const resourcesWithActionKinds = (): SupportedResource[] => {
  if (built) return built;
  // Built on first use, as the action modules also import the environment's.
  let byUrlPattern = new Map([
    [SHAREPOINT_RESOURCE.urlPattern, SHAREPOINT_ACTIONS.kinds()],
    [CALENDAR_RESOURCE.urlPattern, CALENDAR_ACTIONS.kinds()],
    [OUTLOOK_RESOURCE.urlPattern, OUTLOOK_ACTIONS.kinds()],
  ]);
  return built = ALL_RESOURCES.map(resource => {
    let actionKinds = byUrlPattern.get(resource.urlPattern);
    return actionKinds ? { ...resource, actionKinds } : resource;
  });
};
