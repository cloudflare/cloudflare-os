// Shows the Web Push notifications the central notification service sends while no Workshop tab
// is in view. It has no fetch handler, so it never takes part in loading pages.

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {}
  // A userVisibleOnly subscription must show a notification for every push. The service sends
  // only paths within this origin.
  let { title, body, path, tag } = typeof payload?.title === "string"
    ? payload
    : { title: "Cloudflare OS", path: "/" };
  event.waitUntil(self.registration.showNotification(title, { body, tag, data: { path } }));
});

// A connect popup that a failed connect left open has no Workshop to open the chat in. Kept in step
// with HANDOFF_PATH in src/connectHandoff.ts by serviceWorker.test.ts.
const HANDOFF_PATH = "/connect/handoff";

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let { path } = event.notification.data;
  event.waitUntil((async () => {
    // Windows come most recently focused first.
    let windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    let client = windows.find(candidate => new URL(candidate.url).pathname !== HANDOFF_PATH);
    if (client) {
      await client.focus();
      // Client.postMessage takes no target origin: it reaches only this origin's window.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      client.postMessage({ type: "cloudflare-os:open-notification", path });
    } else {
      await self.clients.openWindow(path);
    }
  })());
});
