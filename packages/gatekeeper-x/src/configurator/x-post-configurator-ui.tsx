import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { XPostConfiguratorRpc, XPostConfiguratorValues } from "./x-post-configurator-types";

// A copy of the post half of `parseXUrl` (x-urls.ts): this module is transpiled alone and cannot
// import it. `__tests__/configurator-url.test.ts` keeps the two in step.
const HOSTS = ["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"];
const SNOWFLAKE = /^[0-9]{1,19}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** The canonical link for what was typed, or null when it names no post. */
function canonicalPostUrl(input: string | null | undefined): string | null {
  const text = (input ?? "").trim();
  if (SNOWFLAKE.test(text)) return `https://x.com/i/web/status/${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return null;
  if (!HOSTS.includes(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "i") {
    if (segments[1] === "web" && segments[2] === "status" && SNOWFLAKE.test(segments[3] ?? "")) {
      return `https://x.com/i/web/status/${segments[3]}`;
    }
    if (segments[1] === "status" && SNOWFLAKE.test(segments[2] ?? "")) {
      return `https://x.com/i/web/status/${segments[2]}`;
    }
    return null;
  }
  if (segments.length >= 3 && segments[1] === "status" && SNOWFLAKE.test(segments[2])) {
    return HANDLE.test(segments[0])
      ? `https://x.com/${segments[0]}/status/${segments[2]}`
      : `https://x.com/i/web/status/${segments[2]}`;
  }
  return null;
}

export default {
  initial: {},

  isReady({ values }) {
    return canonicalPostUrl(values.postUrl) !== null;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const canonical = canonicalPostUrl(resourceUrl);
    return canonical ? { postUrl: canonical } : {};
  },

  resourceUrl({ values }) {
    const canonical = canonicalPostUrl(values.postUrl);
    if (!canonical) throw new Error("Enter the link to a post on x.com.");
    return canonical;
  },

  render({ values, setValues }) {
    const invalid = Boolean(values.postUrl?.trim()) && canonicalPostUrl(values.postUrl) === null;
    return <Section>
      <Field
        label="Post"
        description={invalid
          ? "That isn't a link to an X post. Use the post's Share menu, then Copy link."
          : "Paste the link to a post on x.com. The binding reaches that post's conversation and nothing else."}>
        <TextInput
          name="postUrl"
          value={values.postUrl}
          placeholder="https://x.com/username/status/1234567890"
          onChange={postUrl => setValues({ postUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<XPostConfiguratorRpc, XPostConfiguratorValues>;
