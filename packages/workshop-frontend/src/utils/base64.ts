// Base64 of the UTF-8 bytes of `text`. The bundles this encodes (gadget libraries, the diagram
// renderer) are large and not ASCII-only, so they can't go through btoa() directly; the native
// encoder is used where the browser has it, and the fallback feeds btoa() a binary string built in
// chunks small enough for String.fromCharCode's argument list.
type Base64Encodable = Uint8Array & { toBase64?: () => string }

export const base64Utf8 = (text: string): string => {
  const bytes: Base64Encodable = new TextEncoder().encode(text)
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64()
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
