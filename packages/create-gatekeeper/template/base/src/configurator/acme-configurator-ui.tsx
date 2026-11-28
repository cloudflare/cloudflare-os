import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { AcmeConfiguratorRpc, AcmeConfiguratorValues } from "./acme-configurator-types";

// STOP(configurator): This asks for a pasted link. Offer a picker instead where the provider can
// list what the user may bind, with the lookups as methods of `AcmeConfiguratorUI`.
//
// A copy of `parseResourceUrl` (acme-urls.ts): this module is transpiled alone and cannot import it.
function canonicalItemUrl(input: string | null | undefined): string | null {
  let url: URL;
  try {
    url = new URL((input ?? "").trim());
  } catch {
    return null;
  }
  const match = /^\/items\/([A-Za-z0-9_-]+)(?:\/.*)?$/.exec(url.pathname);
  if (url.origin !== "https://acme.example" || !match) return null;
  return `https://acme.example/items/${match[1]}`;
}

export default {
  initial: {},

  isReady({ values }) {
    return canonicalItemUrl(values.itemUrl) !== null;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const canonical = canonicalItemUrl(resourceUrl);
    return canonical ? { itemUrl: canonical } : {};
  },

  resourceUrl({ values }) {
    const canonical = canonicalItemUrl(values.itemUrl);
    if (!canonical) throw new Error("Enter the link to your Acme Service item.");
    return canonical;
  },

  render({ values, setValues }) {
    const invalid = Boolean(values.itemUrl?.trim()) && canonicalItemUrl(values.itemUrl) === null;
    return <Section>
      <Field
        label="Item"
        description={invalid
          ? "That isn't a link to any Acme Service item."
          : "Paste the link to an item. The binding reaches that item and nothing else."}>
        <TextInput
          name="itemUrl"
          value={values.itemUrl}
          placeholder="https://acme.example/items/abc123"
          onChange={itemUrl => setValues({ itemUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<AcmeConfiguratorRpc, AcmeConfiguratorValues>;
