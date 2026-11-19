// How a user connects: by pasting an API key they made in Acme Service into the connect page.

/** What the connect flow reads from the Worker's environment: nothing. */
export type AuthEnv = Record<never, never>;

// STOP(key-help): Where a user makes a key, and what access to give it. Say the narrowest access
// the endpoints this gatekeeper calls need.
/** What the connect page tells the user. */
export const KEY_HELP = "Create an API key in Acme Service, under Settings, and paste it here. " +
  "Cloudflare OS acts with whatever access the key has.";

// STOP(key-format): The longest key the provider issues, and its format if it has one, so a
// pasted value that can't be a key is refused before the provider is asked.
/** The longest key the connect page accepts. */
export const MAX_KEY_LENGTH = 512;
