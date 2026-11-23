import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAuthenticatedApi } from "../../AuthContext";
import { useServerConfig } from "../../ServerConfigContext";
import { logRpcFailure } from "../../rpcErrors";
import { browserPushSupport, syncBrowserPush } from "./browserPush";

/** Keeps this browser's push with the signed-in user, and opens the chat a notification names. */
export const BrowserPushBridge = () => {
  const { authenticatedApi, currentUser, isCurrentUserConfirmed } = useAuthenticatedApi();
  const publicKey = useServerConfig()?.webPushPublicKey;
  const router = useRouter();
  const synced = useRef<string>(undefined);
  // Mid-reconnect, currentUser can still be the previous account while the API is the next one's,
  // which would register this browser for the wrong account.
  const confirmedUserId = isCurrentUserConfirmed ? currentUser?.id : undefined;

  useEffect(() => {
    // Once per user and key per page load, not per reconnect: each sync costs a central
    // registration, and every reconnect re-confirms. A reconnect can bring a new key, though, which
    // the browser must subscribe with. A failed sync is retried on the next reconnect, or a
    // long-lived tab would stay unregistered.
    if (!confirmedUserId || !publicKey || browserPushSupport() !== "supported") return;
    let target = `${confirmedUserId}\n${publicKey}`;
    if (synced.current === target) return;
    synced.current = target;
    syncBrowserPush(authenticatedApi, confirmedUserId, publicKey).catch(error => {
      if (synced.current === target) synced.current = undefined;
      logRpcFailure("Failed to refresh browser notifications:", error);
    });
  }, [authenticatedApi, confirmedUserId, publicKey]);

  useEffect(() => {
    let onMessage = (event: MessageEvent) => {
      if (event.data?.type === "cloudflare-os:open-notification") {
        void router.navigate({ href: event.data.path });
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [router]);

  return null;
};
