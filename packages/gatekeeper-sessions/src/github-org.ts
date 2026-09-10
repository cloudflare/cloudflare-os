import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor,
  ObservationAuthorizer,
  ObservationDescription,
  ObservationDomainSharingPolicy,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  githubHeaders,
  hasGitHubAppConfiguration,
  mintGitHubOrganizationToken,
  type GitHubAppEnv,
  type GitHubInstallationToken,
} from "./github-app.js";
import type {
  GitHubCodeSearchResult,
  GitHubOrganizationRepositorySummary,
  GitHubOrganizationSession,
  GitHubSourceFile,
  GitHubSourceRepository,
  GitHubSourceRepositoryMetadata,
  GitHubTreeEntry,
  GitHubTreeOptions,
  GitHubTreeResult,
} from "./github-org-types.js";
import TYPES_CODE from "./github-org-types.txt";

const GITHUB_API_ORIGIN = "https://api.github.com";
const ORGANIZATION = "totango";
const MAX_REPOSITORIES = 500;
const MAX_SEARCH_RESULTS = 50;
const MAX_TREE_ENTRIES = 1_000;
const MAX_FILE_BYTES = 256 * 1024;
const TOKEN_CACHE_KEY = "githubOrgToken";
const TOTANGO_DOMAIN_SHARING_POLICY = {
  type: "verified-sso-email-domain",
  emailDomain: "totango.com",
} as const satisfies ObservationDomainSharingPolicy;

function orgObservation(title: string, description: string): ObservationDescription {
  return { title, description, domainSharingPolicy: TOTANGO_DOMAIN_SHARING_POLICY };
}

const GITHUB_ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<path d='M128 24a104 104 0 0 0-32.9 202.7c5.2 1 7.1-2.3 7.1-5v-19.3c-29 6.3-35.1-12.3-35.1-12.3-4.7-12-11.6-15.2-11.6-15.2-9.5-6.5.7-6.4.7-6.4 10.5.7 16 10.8 16 10.8 9.3 16 24.5 11.4 30.5 8.7.9-6.8 3.6-11.4 6.6-14-23.1-2.6-47.4-11.6-47.4-51.4 0-11.4 4.1-20.7 10.7-28-1.1-2.6-4.6-13.2 1-27.5 0 0 8.7-2.8 28.6 10.7a99.3 99.3 0 0 1 52 0c19.8-13.5 28.5-10.7 28.5-10.7 5.7 14.3 2.1 24.9 1 27.5 6.7 7.3 10.7 16.6 10.7 28 0 39.9-24.4 48.7-47.6 51.3 3.7 3.2 7 9.5 7 19.1v28.4c0 2.8 1.9 6 7.2 5A104 104 0 0 0 128 24Z'/></svg>"),
};

/** Bindings and GitHub App credentials used by the organization source entrypoints. */
export interface GitHubOrganizationEnv extends GitHubAppEnv {}

type AccountProps = { accountId: string };
type GatekeeperProps = AccountProps;
type TokenProvider = () => Promise<string>;

type ExportContext<Props> = ExecutionContext<Props> & {
  exports: {
    GitHubOrganizationAccount(options: { props: AccountProps }): Fetcher<GatekeeperUser>;
    GitHubOrganizationGatekeeper(options: { props: GatekeeperProps }):
      DurableObjectClass<Gatekeeper<GitHubOrganizationSession>>;
    GitHubOrganizationVerifier(options: object): Fetcher<GatekeeperUserVerifier>;
  };
};

/** RPC session exposing organization repository discovery. */
@validateRpc()
export class GitHubOrganizationSessionImpl extends RpcTarget implements GitHubOrganizationSession {
  constructor(
    private readonly token: TokenProvider,
    private readonly approvalQueue: NativeRpcStub<ApprovalQueue>,
  ) {
    super();
  }

  /** Searches repositories installed for the organization App. */
  async searchRepositories(
    query: string,
    limit = 20,
  ): Promise<GitHubOrganizationRepositorySummary[]> {
    const normalizedQuery = requiredText(query, "Repository query", 200).toLowerCase();
    const boundedLimit = boundedInteger(limit, 1, MAX_SEARCH_RESULTS, "Repository result limit");
    const repositories = await listInstalledRepositories(await this.token());
    const matches = repositories
      .filter(repo => repo.full_name.toLowerCase().startsWith(`${ORGANIZATION}/`))
      .filter(repo => `${repo.name}\n${repo.description ?? ""}`.toLowerCase().includes(normalizedQuery))
      .slice(0, boundedLimit)
      .map(repositorySummary);
    await this.approvalQueue.authorizeObservation(orgObservation(
      "Search Totango GitHub repositories",
      `Searched installed repositories for \`${normalizedQuery}\` and found ${matches.length} result(s).`,
    ));
    return matches;
  }

  /** Opens a read-only source capability for one repository. */
  async openRepository(name: string): Promise<GitHubSourceRepository> {
    return new GitHubSourceRepositoryImpl(
      repositoryName(name), this.token, this.approvalQueue.dup());
  }

  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]?.();
  }
}

/** RPC capability exposing bounded reads from one Totango repository. */
@validateRpc()
export class GitHubSourceRepositoryImpl extends RpcTarget implements GitHubSourceRepository {
  constructor(
    private readonly repository: string,
    private readonly token: TokenProvider,
    private readonly approvalQueue: NativeRpcStub<ApprovalQueue>,
  ) {
    super();
  }

  /** Reads repository metadata and resolves the default branch revision. */
  async getMetadata(): Promise<GitHubSourceRepositoryMetadata> {
    const token = await this.token();
    const metadata = await githubJson<RawRepository>(
      token, `/repos/${ORGANIZATION}/${encodeURIComponent(this.repository)}`);
    const branch = await githubJson<{ commit: { sha: string } }>(
      token,
      `/repos/${ORGANIZATION}/${encodeURIComponent(this.repository)}/branches/` +
        encodeURIComponent(metadata.default_branch),
    );
    const result: GitHubSourceRepositoryMetadata = {
      ...repositorySummary(metadata),
      visibility: visibility(metadata.visibility),
      defaultBranchRevision: branch.commit.sha,
    };
    await this.authorize("Read GitHub repository metadata",
      `Read metadata for \`${ORGANIZATION}/${this.repository}\` at ` +
      `\`${result.defaultBranchRevision.slice(0, 12)}\`.`);
    return result;
  }

  /** Lists immediate source-tree entries at a path and ref. */
  async listTree(options: GitHubTreeOptions = {}): Promise<GitHubTreeResult> {
    const ref = optionalRef(options.ref);
    const path = optionalPath(options.path);
    const token = await this.token();
    const suffix = path ? `/contents/${encodePath(path)}` : "/contents";
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const response = await githubJson<RawContent | RawContent[]>(
      token, `/repos/${ORGANIZATION}/${encodeURIComponent(this.repository)}${suffix}${query}`);
    if (!Array.isArray(response)) throw new Error(`GitHub path \`${path}\` is not a directory.`);
    const entries = response.slice(0, MAX_TREE_ENTRIES).map(treeEntry);
    await this.authorize("List GitHub source tree",
      `Listed ${entries.length} entries under \`${ORGANIZATION}/${this.repository}/${path}\`.`);
    return {
      repository: `${ORGANIZATION}/${this.repository}`,
      ref: ref ?? "default branch",
      path,
      entries,
      truncated: response.length > entries.length,
    };
  }

  /** Searches actual default-branch code and returns bounded matching fragments. */
  async searchCode(query: string, limit = 20): Promise<GitHubCodeSearchResult[]> {
    const normalizedQuery = requiredText(query, "Code query", 200);
    const boundedLimit = boundedInteger(limit, 1, MAX_SEARCH_RESULTS, "Code result limit");
    const token = await this.token();
    const search = new URLSearchParams({
      q: `${normalizedQuery} repo:${ORGANIZATION}/${this.repository}`,
      per_page: String(boundedLimit),
    });
    const result = await githubJson<RawCodeSearch>(token, `/search/code?${search}`, true);
    const expected = `${ORGANIZATION}/${this.repository}`.toLowerCase();
    const matches = result.items
      .filter(item => item.repository.full_name.toLowerCase() === expected)
      .slice(0, boundedLimit)
      .map(item => ({
        repository: item.repository.full_name,
        path: item.path,
        sha: item.sha,
        url: item.html_url,
        fragments: (item.text_matches ?? []).map(match => match.fragment.slice(0, 1_000)).slice(0, 3),
      }));
    await this.authorize("Search GitHub source code",
      `Searched current default-branch source in \`${ORGANIZATION}/${this.repository}\` for ` +
      `\`${normalizedQuery}\` and found ${matches.length} result(s).`);
    return matches;
  }

  /** Reads one bounded UTF-8 source file. */
  async readFile(path: string, ref?: string): Promise<GitHubSourceFile> {
    const filePath = requiredPath(path);
    const normalizedRef = optionalRef(ref);
    const query = normalizedRef ? `?ref=${encodeURIComponent(normalizedRef)}` : "";
    const token = await this.token();
    const result = await githubJson<RawContent>(
      token,
      `/repos/${ORGANIZATION}/${encodeURIComponent(this.repository)}/contents/` +
        `${encodePath(filePath)}${query}`,
    );
    if (result.type !== "file" || result.encoding !== "base64" || typeof result.content !== "string") {
      throw new Error(`GitHub path \`${filePath}\` is not a readable file.`);
    }
    if (result.size > MAX_FILE_BYTES) {
      throw new Error(`GitHub file is larger than ${MAX_FILE_BYTES / 1024} KiB.`);
    }
    const bytes = decodeBase64(result.content);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`GitHub file is larger than ${MAX_FILE_BYTES / 1024} KiB.`);
    }
    if (bytes.includes(0)) throw new Error("GitHub file appears to be binary.");
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    await this.authorize("Read GitHub source file",
      `Read \`${ORGANIZATION}/${this.repository}/${filePath}\` at ` +
      `\`${normalizedRef ?? "default branch"}\`.`);
    return {
      repository: `${ORGANIZATION}/${this.repository}`,
      path: filePath,
      ref: normalizedRef ?? "default branch",
      sha: result.sha,
      url: result.html_url ?? `https://github.com/${ORGANIZATION}/${this.repository}`,
      content,
    };
  }

  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]?.();
  }

  private authorize(title: string, description: string): Promise<void> {
    return this.approvalQueue.authorizeObservation(orgObservation(title, description));
  }
}

/** Durable read-only gatekeeper for one auto-provisioned account. */
@validateRpc()
export class GitHubOrganizationGatekeeper
  extends DurableObject<GitHubOrganizationEnv, GatekeeperProps>
  implements Gatekeeper<GitHubOrganizationSession>
{
  /** Describes the organization-wide, read-only source binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: `github-org://${ORGANIZATION}`,
      title: "Totango GitHub",
      snippet:
        "Live organization repository metadata and current source. Use this for GitHub and code " +
        "questions.",
      suggestedBindingName: "GITHUB_ORG",
      tsType: "GitHubOrganizationSession",
      domainSharingPolicy: TOTANGO_DOMAIN_SHARING_POLICY,
    };
  }

  /** Returns the complete read-only source API declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Explicitly opts this ambient singleton out of a discovery catalog. Repositories are discovered
   * on demand through searchRepositories(); returning null reveals no account or repository data.
   * Keep the authorizer parameter: the Workshop passes it over RPC even for an absent catalog.
   */
  async getAgentCatalog(_authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<null> {
    return null;
  }

  /** Reports that this read-only gatekeeper has no actions. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /** Opens a session backed by a short-lived, read-only installation token. */
  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<GitHubOrganizationSession> {
    return new GitHubOrganizationSessionImpl(
      () => this.installationToken(), approvalQueue.dup());
  }

  /** Admits observers after the Workshop verifies the Totango SSO domain policy. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
  }

  /** Removes no observer state because observers are never admitted. */
  async removeObserver(_id: string): Promise<void> {}

  applyAction(_action: number): never {
    throw new Error("Totango GitHub organization access is read-only.");
  }

  rejectAction(_action: number): never {
    throw new Error("Totango GitHub organization access is read-only.");
  }

  revertAction(_action: number): never {
    throw new Error("Totango GitHub organization access is read-only.");
  }

  private async installationToken(): Promise<string> {
    const cached = this.ctx.storage.kv.get<GitHubInstallationToken>(TOKEN_CACHE_KEY);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const next = await mintGitHubOrganizationToken(this.env);
    this.ctx.storage.kv.put(TOKEN_CACHE_KEY, next);
    return next.token;
  }
}

/** Auto-provisioned account exposing the organization source singleton. */
@validateRpc()
export class GitHubOrganizationAccount
  extends WorkerEntrypoint<GitHubOrganizationEnv, AccountProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Totango GitHub",
      avatar: GITHUB_ICON,
      singleton: { tsType: "GitHubOrganizationSession" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<
    DurableObjectClass<Gatekeeper<GitHubOrganizationSession>>
  > {
    return (this.ctx as ExportContext<AccountProps>).exports.GitHubOrganizationGatekeeper({
      props: this.ctx.props,
    });
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Totango GitHub is an ambient singleton and has no URL resources.");
  }
  startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Totango GitHub is an ambient singleton and has no configurator.");
  }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> {}
  reconnect(): never {
    throw new Error("Totango GitHub is deployment-configured; ask an administrator to rotate it.");
  }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return (this.ctx as ExportContext<AccountProps>).exports.GitHubOrganizationVerifier({});
  }
}

/** Verifier for account capabilities minted by this deployment-controlled vendor. */
@validateRpc()
export class GitHubOrganizationVerifier
  extends WorkerEntrypoint<GitHubOrganizationEnv>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

/** Vendor entrypoint for deployment-controlled Totango GitHub source access. */
@validateRpc()
export class GitHubOrganizationVendor
  extends WorkerEntrypoint<GitHubOrganizationEnv>
  implements GatekeeperVendor
{
  async describe(): Promise<VendorDescription> {
    const configured = hasGitHubAppConfiguration(this.env);
    return {
      displayName: "Totango GitHub",
      url: "https://github.com/totango",
      logo: GITHUB_ICON,
      color: "#24292f",
      tagline: configured ? "Inspect live Totango source" : "GitHub App credentials are not configured",
      description:
        "Read organization repository metadata and current source through the deployment's " +
        "GitHub App. This capability cannot modify repositories.",
      autoProvisionsAccount: configured,
      providesAuth: false,
    };
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    if (!hasGitHubAppConfiguration(this.env)) {
      throw new Error("Totango GitHub App credentials are not configured.");
    }
    return (this.ctx as ExportContext<{}>).exports.GitHubOrganizationAccount({
      props: { accountId: crypto.randomUUID() },
    });
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Totango GitHub is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

type RawRepository = {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  archived: boolean;
  updated_at: string;
  visibility?: string;
};

type RawContent = {
  type: string;
  name: string;
  path: string;
  sha: string;
  size: number;
  html_url: string | null;
  encoding?: string;
  content?: string;
};

type RawCodeSearch = {
  items: Array<{
    path: string;
    sha: string;
    html_url: string;
    repository: { full_name: string };
    text_matches?: Array<{ fragment: string }>;
  }>;
};

async function listInstalledRepositories(token: string): Promise<RawRepository[]> {
  const repositories: RawRepository[] = [];
  for (let page = 1; repositories.length < MAX_REPOSITORIES; page++) {
    const result = await githubJson<{ repositories: RawRepository[] }>(
      token, `/installation/repositories?per_page=100&page=${page}`);
    repositories.push(...result.repositories);
    if (result.repositories.length < 100) break;
  }
  return repositories.slice(0, MAX_REPOSITORIES);
}

async function githubJson<T>(token: string, path: string, textMatch = false): Promise<T> {
  const headers = githubHeaders(`Bearer ${token}`, "odie-os-github-org");
  if (textMatch) headers.set("accept", "application/vnd.github.text-match+json");
  const response = await fetch(`${GITHUB_API_ORIGIN}${path}`, { headers });
  if (!response.ok) {
    if (response.status === 404) throw new Error("GitHub repository, ref, or path was not found.");
    throw new Error(`GitHub request failed (${response.status}).`);
  }
  return response.json<T>();
}

function repositorySummary(repository: RawRepository): GitHubOrganizationRepositorySummary {
  return {
    name: repository.name,
    fullName: repository.full_name,
    ...(repository.description ? { description: repository.description } : {}),
    url: repository.html_url,
    defaultBranch: repository.default_branch,
    archived: repository.archived,
    updatedAt: repository.updated_at,
  };
}

function treeEntry(entry: RawContent): GitHubTreeEntry {
  const types: Record<string, GitHubTreeEntry["type"]> = {
    file: "file", dir: "directory", symlink: "symlink", submodule: "submodule",
  };
  const type = types[entry.type];
  if (!type) throw new Error(`GitHub returned an unsupported tree entry type: ${entry.type}.`);
  return {
    name: entry.name,
    path: entry.path,
    type,
    sha: entry.sha,
    ...(entry.size ? { size: entry.size } : {}),
    ...(entry.html_url ? { url: entry.html_url } : {}),
  };
}

function visibility(value: string | undefined): GitHubSourceRepositoryMetadata["visibility"] {
  return value === "public" || value === "internal" ? value : "private";
}

function repositoryName(value: string): string {
  const name = requiredText(value, "Repository name", 100);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Invalid Totango repository name.");
  return name;
}

function optionalRef(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return requiredText(value, "Git ref", 255);
}

function optionalPath(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "";
  return normalizedPath(value, "Tree path");
}

function requiredPath(value: string): string {
  return normalizedPath(value, "File path");
}

function normalizedPath(value: string, label: string): string {
  const path = requiredText(value, label, 1_024).replace(/^\/+|\/+$/g, "");
  if (!path || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Invalid ${label.toLowerCase()}.`);
  }
  return path;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function requiredText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = [...value]
    .map(character => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
