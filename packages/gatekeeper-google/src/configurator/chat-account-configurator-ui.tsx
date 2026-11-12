import {
  Field, h, Notice, RadioCards, Section, type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  ChatAccountConfiguratorRpc, ChatAccountConfiguratorValues,
} from "./chat-account-configurator-types";

type Context = ConfiguratorUIRenderContext<ChatAccountConfiguratorRpc, ChatAccountConfiguratorValues>;

/** The whole-account resource's URL, which is also its `urlPattern`. */
const CHAT_ACCOUNT_URL = "https://chat.google.com/";
const ACCESS_POLL_MS = 2_000;
const ACCESS_WAIT_MS = 3 * 60_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Whether the account's consent covers starting conversations, as the gatekeeper last said. The
 * Workshop decides whether to ask for a grant from the account description it stored, which an
 * account granted before the resource gained a scope keeps listing as granted, so only this check
 * can offer that account the grant again. Module state, as the runtime keeps none for a module.
 */
let grant:
  | { step: "checking" | "covered" }
  | { step: "missing"; note?: string; tone?: "error"; waiting?: boolean }
  | undefined;

const check = ({ ui, setValues }: Context) => {
  grant = { step: "checking" };
  void ui.canStartConversations().then(
    covered => { grant = covered ? { step: "covered" } : { step: "missing" }; },
    // Unconfirmed, as before this check: a send still says what to do if Google refuses it.
    () => { grant = { step: "covered" }; },
  ).then(() => setValues({}));
};

/** Asks from the click, so the browser lets Workshop open Google's consent pop-up. */
const allow = async ({ ui, ensureResources, setValues }: Context) => {
  const show = (next: typeof grant) => { grant = next; setValues({}); };
  try {
    if (await ensureResources([CHAT_ACCOUNT_URL])) return show({ step: "covered" });
    show({ step: "missing", note: "Allow access in Google's window.", waiting: true });
    // The new grant reaches the gatekeeper once the pop-up completes; nothing tells this frame.
    for (const deadline = Date.now() + ACCESS_WAIT_MS; Date.now() < deadline;) {
      await sleep(ACCESS_POLL_MS);
      if (await ui.canStartConversations()) return show({ step: "covered" });
    }
    show({ step: "missing", note: "Access wasn't allowed within 3 minutes. Select Allow access to try again." });
  } catch (error) {
    show({ step: "missing", tone: "error",
      note: error instanceof Error && error.message ? error.message : "Access wasn't allowed." });
  }
};

export default {
  initial: { scope: "account" },
  isReady: () => true,
  // Must mirror `parseChatUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: () => CHAT_ACCOUNT_URL,
  render(context) {
    const { setValues } = context;
    if (grant === undefined) check(context);
    return <Section>
      <Field
        label="Google Chat account"
        description="Covers every conversation this account can reach, including direct messages."
      >
        <RadioCards
          value="account"
          options={[{
            value: "account",
            title: "All my Google Chat conversations",
            description: "Find and search conversations, read messages, and post, react, or edit as you. Because this includes direct messages, a Gadget using it cannot be shared with collaborators — connect a single conversation for that.",
          }]}
          onChange={() => setValues({ scope: "account" })}
        />
      </Field>
      {grant?.step === "missing" && <Notice
        tone={grant.tone}
        {...(grant.waiting ? {} : { action: { label: "Allow access", onClick: () => void allow(context) } })}
      >
        {grant.note ?? "This account hasn't allowed everything Google Chat needs, so it can't start new " +
          "conversations, only read and post in ones it already has. Allow access to fix it."}
      </Notice>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<ChatAccountConfiguratorRpc, ChatAccountConfiguratorValues>;
