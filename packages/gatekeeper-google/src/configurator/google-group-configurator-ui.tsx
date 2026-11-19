import {
  Autocomplete, Field, Fragment, h, Notice, RadioCards, Section,
  type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  GoogleGroupConfiguratorAlias as Alias,
  GoogleGroupConfiguratorGroupCheck as GroupCheck,
  GoogleGroupConfiguratorRpc as Rpc,
  GoogleGroupConfiguratorValues as Values,
} from "./google-group-configurator-types";

type Context = ConfiguratorUIRenderContext<Rpc, Values>;
type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed" };

// Mirrors `validateGroupMemberAddress` in cloud-identity-api.ts.
const GROUP_ADDRESS = /^[a-z0-9._%+'-]{1,64}@[a-z0-9.-]{1,253}$/;
/** Must match `GROUP_MAIL_GRANT` in resources.ts: read-only Gmail, which the group's mail is read with. */
const GMAIL_GRANT = "https://groups.google.com/mail";
const ACCESS_POLL_MS = 1500;
const ACCESS_WAIT_MS = 3 * 60_000;

// Module state, as the runtime keeps none for a module.

/** Whether the account lets this app read its mail; the group's mail comes from the owner's inbox. */
let mailAccess: Load<boolean> | undefined;
/** Each group's check, by address and who sends to it, so choosing one again doesn't repeat it. */
const checks = new Map<string, Load<GroupCheck | Alias>>();
/** Asking for Gmail access: `waiting` while Google's window is open, `error` when asking failed. */
let asking: { waiting?: true; error?: string } = {};
// Bumped by every ask, so an earlier one's wait ends.
let asks = 0;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Starts `request`, keeping its outcome wherever `store` puts it while that is still `current`. */
function track<T>(
  request: Promise<T>, store: (entry: Load<T>) => void, current: () => Load<T> | undefined, rerender: () => void,
): void {
  const entry: Load<T> = { state: "loading" };
  store(entry);
  const settle = (outcome: Load<T>) => {
    if (current() !== entry) return;
    store(outcome);
    rerender();
  };
  request.then(value => settle({ state: "ready", value }), () => settle({ state: "failed" }));
}

function loadMailAccess({ ui, setValues }: Context): void {
  track(ui.canReadMail(), entry => { mailAccess = entry; }, () => mailAccess, () => setValues({}));
}

const outside = (values: Values) => values.senders === "anyone";
const checkKey = (address: string, values: Values) => `${address} ${outside(values) ? "anyone" : ""}`;

function checkOf({ ui, values, setValues }: Context, address: string): Load<GroupCheck | Alias> {
  const key = checkKey(address, values);
  if (!checks.has(key)) {
    track(ui.checkGroup(address, outside(values)), entry => { checks.set(key, entry); }, () => checks.get(key), () => setValues({}));
  }
  return checks.get(key)!;
}

/**
 * Asks for the Gmail grant, which the connected account keeps for every connection made with it,
 * so an account that already holds it is never asked. Called from a click, so the browser lets
 * Workshop open Google's consent window; then watches for the grant to land, so nobody has to come
 * back and press anything.
 */
async function allowMail({ ensureResources, ui, setValues }: Context): Promise<void> {
  const asked = ensureResources([GMAIL_GRANT]);
  const ask = ++asks;
  asking = { waiting: true };
  setValues({});
  try {
    let held = await asked;
    const deadline = Date.now() + ACCESS_WAIT_MS;
    while (!held) {
      if (Date.now() >= deadline) throw new Error("Access wasn't confirmed. Try again.");
      await sleep(ACCESS_POLL_MS);
      if (ask !== asks) return;
      held = await ui.canReadMail().catch(() => false);
    }
    if (ask !== asks) return;
    mailAccess = { state: "ready", value: true };
    asking = {};
  } catch (error) {
    if (ask !== asks) return;
    asking = { error: error instanceof Error && error.message ? error.message : "Access wasn't allowed." };
  }
  setValues({});
}

/** Until the account lets this app read its mail, which the group's mail is read from. */
function mailNotice(context: Context) {
  if (mailAccess === undefined || mailAccess.state === "loading") return null;
  if (mailAccess.state === "failed") {
    const retry = () => {
      loadMailAccess(context);
      context.setValues({});
    };
    return <Notice tone="error" action={{ label: "Try again", onClick: retry }}>
      Couldn't check this account's Gmail access.
    </Notice>;
  }
  if (mailAccess.value) return null;
  const allow = () => void allowMail(context);
  if (asking.waiting) {
    return <Notice action={{ label: "Open it again", onClick: allow }}>
      Waiting for you to allow access in Google's window.
    </Notice>;
  }
  if (asking.error) return <Notice tone="error" action={{ label: "Allow access", onClick: allow }}>{asking.error}</Notice>;
  return <Notice action={{ label: "Allow access", onClick: allow }}>
    Group mail is read from your Gmail inbox, which needs your permission.
  </Notice>;
}

/** What the group's recent mail and settings say about connecting it. A group the account isn't in, or one that couldn't be checked, holds Connect back. */
function groupNotices(context: Context, address: string) {
  const check = checkOf(context, address);
  if (check.state === "loading") return null;
  if (check.state === "failed") {
    const retry = () => {
      checks.delete(checkKey(address, context.values));
      context.setValues({});
    };
    return <Notice action={{ label: "Try again", onClick: retry }}>
      Couldn't check this group.
    </Notice>;
  }
  if ("aliasOf" in check.value) {
    const { aliasOf } = check.value;
    // The field keeps what was typed apart from its value, so that goes too.
    const useMain = () => {
      context.clearFields("group");
      context.setValues({ group: aliasOf });
    };
    return <Notice action={{ label: "Use that address", onClick: useMain }}>
      This is another address for {aliasOf}. A group is connected by its main address.
    </Notice>;
  }
  const { mail, membership } = check.value;
  if (membership === "none") {
    return <Notice tone="error">You're not a direct member of this group, so it can't be connected.</Notice>;
  }
  return <Fragment>
    {membership === "manager" && <Notice>
      You manage this group, so this can't tell whether its other members can see the member list.
      Sharing with them only works if the group's "Who can view members" setting includes group
      members.
    </Notice>}
    {membership === "hidden" && <Notice>
      This group hides its member list, so sharing with its members won't work until a group
      manager lets members view it.
    </Notice>}
    {mail === "unverified" && <Notice>
      None of this group's recent mail could be verified, so it won't be shown. This usually means
      DKIM is off for your domain; a Workspace admin can turn it on.
    </Notice>}
    {mail === "empty" && <Notice>
      No mail for this group yet. It will show up as it arrives.
    </Notice>}
  </Fragment>;
}

const validGroup = (values: Values) => GROUP_ADDRESS.test(values.group ?? "") ? values.group! : undefined;

export default {
  initial: {},

  isReady({ values }) {
    const group = validGroup(values);
    if (!group || mailAccess?.state !== "ready" || !mailAccess.value) return false;
    // Only once the group has been found and the account's own membership answered.
    const check = checks.get(checkKey(group, values));
    return check?.state === "ready" && !("aliasOf" in check.value) && check.value.membership !== "none";
  },

  // Must mirror `parseGroupsUrl` and `groupResourceUrl` in resources.ts, which is what actually
  // mints the capability. This module is transpiled on its own and cannot import them, so
  // `__tests__/configurator-url.test.ts` is what keeps the copies honest.
  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = new URL(resourceUrl);
    const match = /^\/a\/([^/]+)\/g\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return {};
    return {
      group: `${decodeURIComponent(match[2])}@${decodeURIComponent(match[1])}`.toLowerCase(),
      ...(url.search === "?senders=anyone" ? { senders: "anyone" } : {}),
    };
  },

  resourceUrl({ values }) {
    const address = validGroup(values);
    if (!address) throw new Error("Choose a group.");
    const at = address.lastIndexOf("@");
    return `https://groups.google.com/a/${encodeURIComponent(address.slice(at + 1))}/g/${encodeURIComponent(address.slice(0, at))}` +
      (outside(values) ? "?senders=anyone" : "");
  },

  render(context) {
    const { values, setValues, ui } = context;
    if (mailAccess === undefined) loadMailAccess(context);
    const group = validGroup(values);
    return <Section>
      <Field
        label="Group"
        description="Choose a group you're in. Only mail sent to that group can be read, and nothing can be sent or changed."
      >
        <Autocomplete
          name="group"
          value={values.group}
          placeholder="Search your groups..."
          loadOptions={query => ui.listGroups(query)}
          onChange={chosen => setValues({ group: chosen })}
        />
      </Field>
      <Field label="Who emails this group?">
        <RadioCards
          value={outside(values) ? "anyone" : "organization"}
          options={[
            {
              value: "organization", title: "Only people at your company",
              description: "Best for internal groups. Stops outsiders from getting email in front of your team just by copying the group's address.",
            },
            {
              value: "anyone", title: "Anyone, including people outside",
              description: "Best for shared addresses like external-feedback@ or support@. Every email to the group shows up right away, including ones from outside your company.",
            },
          ]}
          onChange={next => setValues({ senders: next === "anyone" ? "anyone" : null })}
        />
      </Field>
      {mailNotice(context)}
      {group && mailAccess?.state === "ready" && mailAccess.value ? groupNotices(context, group) : null}
    </Section>;
  },
} satisfies ConfiguratorUISpec<Rpc, Values>;
