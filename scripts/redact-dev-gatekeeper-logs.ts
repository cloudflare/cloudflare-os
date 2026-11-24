// Loaded only by the dev backend. Wrangler's CLI does not expose a per-request log formatter;
// adapt its pinned Miniflare logger without suppressing diagnostics or piping the terminal.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

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

  // Proxy transport errors use Wrangler's own logger, including a disk log, rather than Log.
  // It has no exported formatter. Adapt only the pinned CLI's logging boundary at load time,
  // before either esbuild's line wrapping or disk persistence; do not alter global formatting,
  // requests, dependencies on disk, or terminal streams. Fail closed after an incompatible bump.
  const cliUrl = pathToFileURL(realpathSync(require.resolve("wrangler"))).href;
  registerHooks({load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== cliUrl) return loaded;
    const source = loaded.source == null ? readFileSync(new URL(url), "utf8")
      : typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
    const boundary = "doLog(messageLevel, args) {";
    if (source.split(boundary).length !== 2) {
      throw new Error("Wrangler logger changed; update the gatekeeper URL redaction adapter before starting dev.");
    }
    const sanitize = String.raw`.replace(/\/gatekeeper\/[^\s\u001b]+/g, "/gatekeeper/[redacted]")`;
    return {...loaded, source: source.replace(boundary, boundary +
      `\nargs = Array.isArray(args) ? [util.format(...args)${sanitize}] : args${sanitize};`)};
  }});
}
