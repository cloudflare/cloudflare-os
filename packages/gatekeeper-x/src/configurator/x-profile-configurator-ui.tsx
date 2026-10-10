import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { XProfileConfiguratorRpc, XProfileConfiguratorValues } from "./x-profile-configurator-types";

// A copy of the profile half of `parseXUrl` and `parseUsernameRef` (x-urls.ts): this module is
// transpiled alone and cannot import them. `__tests__/configurator-url.test.ts` keeps them in step.
const HOSTS = ["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"];
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const RESERVED_FIRST_SEGMENTS = [
  "about", "account", "bookmarks", "communities", "compose", "download", "explore", "hashtag",
  "help", "home", "i", "intent", "jobs", "lists", "login", "logout", "messages", "notifications",
  "premium", "privacy", "search", "settings", "share", "signup", "topics", "tos",
];
const PROFILE_TABS = [
  "with_replies", "media", "highlights", "articles", "followers", "following", "verified_followers",
];

function isHandle(value: string): boolean {
  return HANDLE.test(value) && !RESERVED_FIRST_SEGMENTS.includes(value.toLowerCase());
}

/** The handle that was typed, as a handle, "@handle", or profile link; null when it names none. */
function handleOf(input: string | null | undefined): string | null {
  const text = (input ?? "").trim();
  const bare = text.replace(/^@/, "");
  if (isHandle(bare)) return bare;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return null;
  if (!HOSTS.includes(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > 2 || !isHandle(segments[0])) return null;
  return segments.length === 1 || PROFILE_TABS.includes(segments[1]) ? segments[0] : null;
}

export default {
  initial: {},

  isReady({ values }) {
    return handleOf(values.username) !== null;
  },

  resourceUrl({ values }) {
    const handle = handleOf(values.username);
    if (!handle) throw new Error("Enter an X username or profile link.");
    return `https://x.com/${handle}`;
  },

  render({ values, setValues }) {
    const invalid = Boolean(values.username?.trim()) && handleOf(values.username) === null;
    return <Section>
      <Field
        label="Profile"
        description={invalid
          ? "That isn't an X username or profile link. A username has at most 15 letters, digits, or underscores."
          : "An X username, such as @XDevelopers, or a profile link. The binding reads that profile and its public posts, and can't act on X."}>
        <TextInput
          name="username"
          value={values.username}
          placeholder="@username"
          onChange={username => setValues({ username })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<XProfileConfiguratorRpc, XProfileConfiguratorValues>;
