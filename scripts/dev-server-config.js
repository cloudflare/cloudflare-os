export function getWranglerPortFromBackendHost(backendHost) {
  const trimmed = backendHost.trim();
  if (!trimmed) return null;
  if (trimmed.includes("://")) {
    throw new Error("VITE_BACKEND_HOST must include a valid host with an optional port.");
  }

  let url;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    if (/(^.*\]:|^[^:]+:)[^:]+$/.test(trimmed)) {
      throw new Error("VITE_BACKEND_HOST must include a valid port between 1 and 65535.");
    }
    throw new Error("VITE_BACKEND_HOST must include a valid host with an optional port.");
  }

  const explicitPort = url.port || trimmed.match(/:(\d+)$/)?.[1];
  if (!explicitPort) return null;

  const port = Number(explicitPort);
  if (port < 1) {
    throw new Error("VITE_BACKEND_HOST must include a valid port between 1 and 65535.");
  }

  return String(port);
}

export function parseRunLocalArgs(args) {
  let port = null;
  const passthroughArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== "--port" && !arg.startsWith("--port=")) {
      passthroughArgs.push(arg);
      continue;
    }

    const value = arg === "--port" ? args[++i] : arg.slice("--port=".length);
    if (value === undefined || value === "") {
      throw new Error("--port requires a value.");
    }

    const numericPort = Number(value);
    if (!/^\d+$/.test(value) || numericPort < 1 || numericPort > 65535) {
      throw new Error("--port must be a valid port between 1 and 65535.");
    }
    port = String(numericPort);
  }

  return { port, passthroughArgs };
}
