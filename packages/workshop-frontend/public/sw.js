// Shows the Web Push notifications the central notification service sends while no Workshop tab
// is in view. It has no fetch handler, so it never takes part in loading pages.

// The service sends only paths within this origin. Anything else, including "/\host" that URL
// parsing reads as "//host", opens the Workshop's home page instead.
const workshopPath = (path) => {
  try {
    let url = new URL(path, self.location.origin);
    if (typeof path === "string" && url.origin === self.location.origin) {
      return url.pathname + url.search + url.hash;
    }
  } catch {}
  return "/";
};

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {}
  // A userVisibleOnly subscription must show a notification for every push.
  let { title, body, path, tag } = typeof payload?.title === "string"
    ? payload
    : { title: "Cloudflare OS" };
  event.waitUntil(self.registration.showNotification(
    title, { body, tag, data: { path: workshopPath(path) } }));
});

// Pages that render without the Workshop, so nothing there opens the chat: a connect popup that a
// failed connect left open, and sign-up. The handoff path is kept in step with HANDOFF_PATH in
// src/connectHandoff.ts by serviceWorker.test.ts.
const STANDALONE_PATHS = new Set(["/connect/handoff", "/signup"]);

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let { path } = event.notification.data;
  event.waitUntil((async () => {
    // Windows come most recently focused first.
    let windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    let client = windows.find(candidate => !STANDALONE_PATHS.has(new URL(candidate.url).pathname));
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
