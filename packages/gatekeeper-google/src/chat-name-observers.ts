import type { ChatProfileName } from "./chat-dm-names";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { ObserverTracker, type ObserverKv } from "./observers";

/** A Chat ACL does not by itself establish visibility of a People-sourced DM name. */
export function chatNameObservers(kv: ObserverKv, space: string) {
  return new ObserverTracker<ChatProfileName, Fetcher<GoogleVerifierApi>>(kv, {
    setPrefix: "chat:observed-name:",
    encode: profile => JSON.stringify([profile.id, profile.name]),
    decode: key => {
      const [id, name] = JSON.parse(key) as [string, string];
      return { id, name };
    },
    verifyBatch: (verifier, profiles) => verifier.verifyChatNames(space, [...profiles]),
    baselineDeniedMessage: "This collaborator cannot access the Google Chat conversation.",
    deniedMessage: () => "This collaborator cannot access a profile name this Chat connection has read.",
  });
}
