import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { JiraApi, jqlLiteral, parseIssueKeyOrId, type AccessibleResource } from "./jira-api";
import type { ConfiguratorOption, JiraConfiguratorRpc, JiraDefaultProject } from "./configurator/jira-configurator-types";

const OPTION_LIMIT = 50;
const QUERY_LIMIT = 256;
type Context = { getSites: () => Promise<AccessibleResource[]>; getToken: () => Promise<string>; getDefaultProject: () => Promise<JiraDefaultProject>; setDefaultProject: (projectUrl: string | null) => Promise<JiraDefaultProject> };
const contexts = new WeakMap<object, Context>();
const ctx = (target: object): Context => {
  const value = contexts.get(target);
  if (!value) throw new Error("Jira configurator is not initialized.");
  return value;
};
const apiFor = (site: AccessibleResource, getToken: () => Promise<string>): JiraApi => new JiraApi({ cloudId: site.id, webBase: site.url, getToken });

@validateRpc()
export class JiraConfiguratorUI extends RpcTarget implements JiraConfiguratorRpc {
  constructor(getSites: () => Promise<AccessibleResource[]>, getToken: () => Promise<string>, defaults?: Pick<Context, "getDefaultProject" | "setDefaultProject">) {
    super();
    contexts.set(this, {
      getSites,
      getToken,
      getDefaultProject: defaults?.getDefaultProject ?? (async () => null),
      setDefaultProject: defaults?.setDefaultProject ?? (async () => null),
    });
  }

  async listSites(query: string): Promise<ConfiguratorOption[]> {
    const q = query.trim().toLowerCase();
    return (await ctx(this).getSites()).filter(site => !q || site.name.toLowerCase().includes(q) || site.url.toLowerCase().includes(q)).slice(0, OPTION_LIMIT).map(site => ({ value: site.url, title: site.name, subtitle: site.url }));
  }

  async listProjects(query: string): Promise<ConfiguratorOption[]> {
    const { getSites, getToken } = ctx(this);
    const search = query.trim().slice(0, QUERY_LIMIT);
    const options: ConfiguratorOption[] = [];
    for (const site of await getSites()) {
      try {
        const page = await apiFor(site, getToken).listProjects(0, OPTION_LIMIT - options.length, search);
        options.push(...(page.values ?? []).map(project => ({ value: `${site.url}/projects/${project.key}`, title: project.name, subtitle: `${project.key} · ${site.name}` })));
      } catch {
        continue;
      }
      if (options.length >= OPTION_LIMIT) break;
    }
    return options;
  }

  async listIssues(query: string): Promise<ConfiguratorOption[]> {
    const { getSites, getToken } = ctx(this);
    const search = query.trim().slice(0, QUERY_LIMIT);
    const options: ConfiguratorOption[] = [];
    for (const site of await getSites()) {
      try {
        const api = apiFor(site, getToken);
        const jql = /^[A-Z][A-Z0-9_]{1,31}-\d+$/i.test(search) ? `key = ${jqlLiteral(parseIssueKeyOrId(search))}` : (search ? `text ~ ${jqlLiteral(search)} ORDER BY updated DESC` : "ORDER BY updated DESC");
        const page = await api.searchIssues(jql, 0, Math.min(20, OPTION_LIMIT - options.length));
        options.push(...page.issues.map(issue => ({ value: `${site.url}/browse/${issue.key}`, title: `${issue.key}: ${issue.fields.summary ?? "Untitled"}`, subtitle: site.name })));
      } catch {
        continue;
      }
      if (options.length >= OPTION_LIMIT) break;
    }
    return options;
  }

  getDefaultProject(): Promise<JiraDefaultProject> {
    return ctx(this).getDefaultProject();
  }

  setDefaultProject(projectUrl: string | null): Promise<JiraDefaultProject> {
    return ctx(this).setDefaultProject(projectUrl);
  }
}
