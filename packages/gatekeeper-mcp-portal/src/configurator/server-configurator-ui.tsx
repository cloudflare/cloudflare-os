import {
  Autocomplete, CheckboxList, Field, h, RadioCards, Section,
  type ConfiguratorUIOption, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  McpServerConfiguratorRpc,
  McpServerConfiguratorValues,
} from "./server-configurator-types";

let pendingServers: Promise<ConfiguratorUIOption[]> | null = null;
let loadedServers: ConfiguratorUIOption[] | null = null;

function serverOptions(ui: McpServerConfiguratorRpc): Promise<ConfiguratorUIOption[]> {
  pendingServers ??= (async () => {
    loadedServers = await ui.listServerOptions();
    return loadedServers;
  })();
  return pendingServers;
}

async function loadServerOptions(
  ui: McpServerConfiguratorRpc,
  query = "",
): Promise<ConfiguratorUIOption[]> {
  const servers = await serverOptions(ui);
  const needle = query.trim().toLowerCase();
  return needle
    ? servers.filter(server =>
        server.value.toLowerCase().includes(needle) || server.title.toLowerCase().includes(needle))
    : servers;
}

export default {
  initial: { server: null, mode: "all", tools: null, endpointKind: "unknown" },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const params = new URLSearchParams(new URL(resourceUrl).hash.slice(1));
    const selected = params.getAll("tool").map(name => name.trim()).filter(Boolean)
      .map(encodeURIComponent);
    const requestedServer = params.get("server")?.trim() || null;
    const servers = await serverOptions(ui);
    const server = requestedServer
      ? servers.some(option => option.value === requestedServer) ? requestedServer : null
      : servers.length === 1 ? servers[0].value : null;
    return {
      server,
      mode: params.has("tool") ? "choose" : "all",
      tools: server && selected.length > 0 ? selected.join(",") : null,
      endpointKind: servers.length > 0 ? "portal" : "empty",
    };
  },

  isReady({ values }) {
    if (values.endpointKind !== "portal" || !values.server) return false;
    return values.mode === "all"
      || (values.tools ?? "").split(",").some(name => name.trim().length > 0);
  },

  async resourceUrl({ values, ui }) {
    if (!values.server) throw new Error("Choose a server behind this portal before adding it.");
    const endpoint = await ui.getEndpoint();
    const params = new URLSearchParams({ server: values.server });
    if (values.mode !== "all") {
      const selected = (values.tools ?? "").split(",").map(name => name.trim()).filter(Boolean)
        .map(decodeURIComponent);
      for (const tool of selected) params.append("tool", tool);
      if (selected.length === 0) params.append("tool", "");
    }
    return `${endpoint}#${params}`;
  },

  render({ values, setValues, ui }) {
    if (values.endpointKind === "unknown") {
      void serverOptions(ui).then(
        servers => {
          const server = values.server
            ? servers.some(option => option.value === values.server) ? values.server : null
            : servers.length === 1 ? servers[0].value : null;
          setValues({
            endpointKind: servers.length > 0 ? "portal" : "empty",
            server,
            ...(server === values.server ? {} : { tools: null }),
          });
        },
        () => setValues({ endpointKind: "unavailable" }),
      );
    }

    if (values.endpointKind === "unavailable") {
      return <Section>
        <Field
          label="Server"
          description={
            "Could not reach the portal to list the servers behind it, so there is nothing to " +
            "grant yet. Close this and try again; if it keeps happening, ask an administrator to " +
            "check the portal configuration and any context-optimization setting."
          }
        />
      </Section>;
    }

    if (values.endpointKind === "empty") {
      return <Section>
        <Field
          label="Server"
          description={
            "No grantable servers are available through this connector. They may be disabled in " +
            "the portal or available through native connectors. If this is unexpected, ask an " +
            "administrator to check the portal configuration."
          }
        />
      </Section>;
    }

    const soleServer = loadedServers?.length === 1 ? loadedServers[0] : null;
    const mode = values.mode === "choose" ? "choose" : "all";
    const toolsReady = Boolean(values.server);
    const serverKey = values.server ?? "";
    const selectedCount = (values.tools ?? "").split(",").filter(Boolean).length;

    return <Section>
      {(!soleServer || !values.server) && <Field
        label="Server"
        description="Which server behind this portal to grant. Its tools appear next."
      >
        <Autocomplete
          name="server"
          value={values.server}
          placeholder="Search servers behind this portal..."
          loadOptions={query => loadServerOptions(ui, query)}
          onChange={server => setValues({ server, tools: null })}
          onClear={() => setValues({ server: null, tools: null })}
        />
      </Field>}

      {toolsReady && <Field
        label={soleServer ? `Tools · ${soleServer.title}` : "Tools"}
        description="Choose how much of this server this connection may call."
      >
        <RadioCards
          value={mode}
          options={[
            {
              value: "all",
              title: "All tools",
              description: "Every tool this server offers, including ones it adds later.",
            },
            {
              value: "choose",
              title: "Choose tools",
              description:
                "Only the tools you tick, from up to 200 shown. Anything else is refused, " +
                "including tools added later.",
            },
          ]}
          onChange={next => setValues({ mode: next })}
        />
      </Field>}

      {toolsReady && <Field
        label="Allowed tools"
        description={mode === "all"
          ? "Read-only tools return data straight away; the rest queue for your approval."
          : selectedCount > 0
            ? `${selectedCount} selected. Read-only tools return data straight away; the rest `
              + "queue for your approval."
            : "Tick at least one tool to grant anything."}
      >
        <CheckboxList
          name={`tools:${serverKey}`}
          value={values.tools}
          loadOptions={async () => (await ui.listToolOptions(serverKey))
            .map(option => ({ ...option, value: encodeURIComponent(option.value) }))}
          allSelected={mode === "all"}
          disabled={mode === "all"}
          onChange={tools => setValues({ tools })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<McpServerConfiguratorRpc, McpServerConfiguratorValues>;
