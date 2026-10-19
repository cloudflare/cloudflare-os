import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  GoogleGroupConfiguratorRpc, GoogleGroupConfiguratorValues,
} from "./google-group-configurator-types";

// The address grammar `normalizeEmail` in groups-api.ts accepts, copied because this module cannot
// import it. Matched before lowercasing, so no non-ASCII letter can fold into an address.
const EMAIL_LOCAL_RE = /^[A-Za-z0-9._%+'-]{1,64}$/;
const DOMAIN_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** `value` lowercased, when it is an email address the backend will accept. */
const groupEmail = (value: string | null | undefined): string | undefined => {
  const email = value?.trim();
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  return at > 0 && EMAIL_LOCAL_RE.test(email.slice(0, at)) && DOMAIN_RE.test(email.slice(at + 1))
    ? email.toLowerCase() : undefined;
};

/** The configurator only receives URLs matching the resource pattern, `/a/{domain}/g/{name}`. */
const emailFrom = (resourceUrl: string): string | undefined => {
  const match = /^https:\/\/groups\.google\.com\/a\/([^/]+)\/g\/([^/]+)\/?$/.exec(resourceUrl);
  if (!match) return undefined;
  try {
    return groupEmail(`${decodeURIComponent(match[2])}@${decodeURIComponent(match[1])}`);
  } catch {
    return undefined;
  }
};

export default {
  initial: {},
  isReady: ({ values }) => groupEmail(values.email) !== undefined,
  // Must mirror `parseGroupsUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: ({ values }) => {
    const email = groupEmail(values.email) ?? "";
    const at = email.lastIndexOf("@");
    return `https://groups.google.com/a/${email.slice(at + 1)}/g/${encodeURIComponent(email.slice(0, at))}`;
  },
  initialValuesFromResourceUrl({ resourceUrl }) {
    const email = emailFrom(resourceUrl);
    return email ? { email } : {};
  },
  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Group"
        description="Choose one Google Workspace group. The connection reads its details and direct members, and collaborators can open the Gadget only if their own Google account can see the group's members too."
      >
        <Autocomplete
          name="email"
          value={values.email}
          placeholder="Search your groups, or enter a group's email address or groups.google.com link..."
          loadOptions={query => ui.listGroups(query)}
          onChange={email => setValues({ email })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GoogleGroupConfiguratorRpc, GoogleGroupConfiguratorValues>;
