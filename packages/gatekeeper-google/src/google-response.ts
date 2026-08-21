type GoogleJsonResponseOptions = {
  provider: string;
  operation: string;
  maxBytes: number;
};

async function readBoundedText(
  response: Response,
  maxBytes: number,
  provider: string,
): Promise<string> {
  let contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    let declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${provider} response exceeded the ${maxBytes}-byte limit.`);
    }
  }

  if (!response.body) return "";
  let reader = response.body.getReader();
  let chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${provider} response exceeded the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  let bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (let chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Read a size-bounded Google JSON response without exposing provider response prose in errors. */
export async function readGoogleJson<T>(
  response: Response,
  options: GoogleJsonResponseOptions,
): Promise<T> {
  let { provider, operation, maxBytes } = options;
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${provider} ${operation} failed [http=${response.status}]`);
  }

  let text = await readBoundedText(response, maxBytes, provider);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${provider} ${operation} returned invalid JSON.`);
  }
}
