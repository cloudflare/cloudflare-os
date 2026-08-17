/**
 * The port a `VITE_BACKEND_HOST` names, as a string, or null when it names no port. Throws on a
 * value that is not a bare `host[:port]`.
 */
export function getWranglerPortFromBackendHost(backendHost: string): string | null {
  const trimmed = backendHost.trim();
  if (!trimmed) return null;
  if (trimmed.includes("://")) {
    throw new Error("VITE_BACKEND_HOST must include a valid host with an optional port.");
  }

  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    if (/(^.*\]:|^[^:]+:)[^:]+$/.test(trimmed)) {
      throw new Error("VITE_BACKEND_HOST must include a valid port between 1 and 65535.");
    }
    throw new Error("VITE_BACKEND_HOST must include a valid host with an optional port.");
  }

  if (!url.port) return null;

  const port = Number(url.port);
  if (port < 1) {
    throw new Error("VITE_BACKEND_HOST must include a valid port between 1 and 65535.");
  }

  return url.port;
}

/**
 * Resolve where the dev server's backend lives: an explicit `--port` wins, else
 * `VITE_BACKEND_HOST`, else `localhost:8787`.
 */
export function getDevServerConfig(args: readonly string[], envBackendHost?: string): {
  backendHost: string;
  wranglerPort: string | null;
} {
  let commandLinePort: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== "--port" && !arg.startsWith("--port=")) continue;

    if (commandLinePort !== null) {
      throw new Error("--port may only be specified once.");
    }

    const value = arg === "--port" ? args[++i] : arg.slice("--port=".length);
    if (!/^\d+$/.test(value ?? "") || Number(value) < 1 || Number(value) > 65535) {
      throw new Error("--port must be an integer between 1 and 65535.");
    }
    commandLinePort = String(Number(value));
  }

  if (commandLinePort !== null) {
    return {
      backendHost: `localhost:${commandLinePort}`,
      wranglerPort: commandLinePort,
    };
  }

  const backendHost = envBackendHost?.trim() || "localhost:8787";
  return {
    backendHost,
    wranglerPort: getWranglerPortFromBackendHost(backendHost),
  };
}
