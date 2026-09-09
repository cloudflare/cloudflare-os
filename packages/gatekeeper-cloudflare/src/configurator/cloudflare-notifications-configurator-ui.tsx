import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CloudflareNotificationsConfiguratorValues,
  CloudflareNotificationsConfiguratorRpc,
} from "./cloudflare-configurator-types";

let selection = 0;

export default {
  initial: { accountId: null, status: null, statusDetails: null },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const url = new URL(resourceUrl);
    const accountId = url.pathname.split("/")[1];
    if (url.origin !== "https://dash.cloudflare.com" || !/^[a-f0-9]{32}$/i.test(accountId ?? ""))
      return {};
    const status = await ui.getSetupStatus(accountId!);
    return { accountId, status: status.summary, statusDetails: status.details ?? null };
  },

  isReady({ values }) {
    return /^[a-f0-9]{32}$/i.test(values.accountId ?? "");
  },

  resourceUrl({ values }) {
    return `https://dash.cloudflare.com/${encodeURIComponent(values.accountId!)}/notifications`;
  },

  render({ values, setValues, ui }) {
    return (
      <Section>
        <Field
          label="Cloudflare account"
          description="Choose the account whose alerts this workspace can receive."
        >
          <Autocomplete
            name="accountId"
            value={values.accountId}
            placeholder="Choose an account"
            loadOptions={(query) => ui.listAccounts(query)}
            onChange={async (accountId) => {
              const current = ++selection;
              setValues({
                accountId,
                status: accountId ? "Checking connection…" : null,
                statusDetails: null,
              });
              if (!accountId) return;
              try {
                const status = await ui.getSetupStatus(accountId);
                if (selection === current)
                  setValues({ status: status.summary, statusDetails: status.details ?? null });
              } catch {
                if (selection === current)
                  setValues({
                    status: "Could not check connection",
                    statusDetails: "Reopen this connection to try again.",
                  });
              }
            }}
          />
        </Field>
        {values.status && (
          <p className="field-label" role="status" style={{ margin: "0" }}>
            {values.status}
          </p>
        )}
        <p className="field-description" style={{ margin: "0" }}>
          After adding, enable a notification hook in Connections.
        </p>
        <details>
          <summary className="field-label" style={{ cursor: "pointer" }}>
            Details
          </summary>
          <p className="field-description" style={{ marginTop: "8px" }}>
            Choose the Cloudflare OS webhook on the notification policies you want to receive.
            Enabling your first hook creates the destination. Notifications Write access is
            required.
          </p>
          {values.statusDetails && (
            <p className="field-description" style={{ overflowWrap: "anywhere" }}>
              {values.statusDetails}
            </p>
          )}
        </details>
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<
  CloudflareNotificationsConfiguratorRpc,
  CloudflareNotificationsConfiguratorValues
>;
