export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (needle.every((byte, offset) => haystack[i + offset] === byte)) return true;
  }
  return false;
}
