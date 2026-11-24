// Loaded only by the dev backend. Wrangler's CLI does not expose a per-request log formatter;
// adapt its pinned Miniflare logger without suppressing diagnostics or piping the terminal.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

function getWranglerRequire() {
  // NODE_OPTIONS also reaches CLI wrappers, build subprocesses and node -e. Only the actual
  // Wrangler CLI owns this logger; resolve from its entry so pnpm uses the right package instance.
  if (!process.argv[1]) return;
  try {
    const entry = realpathSync(process.argv[1]);
    const require = createRequire(entry);
    if (entry === realpathSync(require.resolve("wrangler"))) return require;
  } catch { /* A build tool or eval argument need not be a file or resolve Wrangler. */ }
}
const require = getWranglerRequire();
if (require) {
  const { Log } = require("miniflare");
  const log = Log.prototype.log;
  Log.prototype.log = function (this: unknown, message: string) {
    // eslint-disable-next-line no-control-regex -- Preserve ANSI terminal formatting after the path.
    log.call(this, message.replace(/\/gatekeeper\/[^\s\u001b]+/g, "/gatekeeper/[redacted]"));
  };
}
