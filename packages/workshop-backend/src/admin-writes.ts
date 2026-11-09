// The pure parts of admin writes to workspaces: what is computed from its arguments alone, with no
// storage read and no call made.

/** A fresh challenge: 32 random bytes, then `binding` (the digest of what the ceremony confirms:
 * an approval's request, a removal's credential id), as unpadded base64url. */
export function newPasskeyChallenge(binding?: Uint8Array): string {
  let challenge = new Uint8Array(32 + (binding?.length ?? 0));
  crypto.getRandomValues(challenge.subarray(0, 32));
  if (binding) challenge.set(binding, 32);
  return challenge.toBase64({ alphabet: "base64url", omitPadding: true });
}
