// The sessions of an instance binding (GitLabInstanceGatekeeperImpl): the instance, which searches
// code across every project the account can read and opens repositories, and the read-only
// repositories it opens. Every read goes through gitlab-code.ts, which reports what it depends on
// (`instance/<host>`, `repository/<id>`, or `project/<id>` for metadata of a project whose
// repository is disabled) through the reading session's own approval queue. Nothing
// here advertises commit ids to the workspace git cache: the binding has no `gitPull`, so a commit
// it named could not be fetched through it.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, Cursor } from "@gadgets/workshop-shared/gatekeeper";
import {
  CodeSearchPager, RepositoryTreePager, openRepository, queueAuthorizer, readRepositoryFile, readRepositoryMetadata,
  type CodeReadContext, type RepositoryTarget,
} from "./gitlab-code";
import { PagerCursor } from "./gitlab-cursors";
import { parseResourceUrl } from "./gitlab-normalize";
import { pageSize } from "./gitlab-sessions";
import type {
  GitLabCodeHit,
  GitLabFileContent,
  GitLabInstance,
  GitLabInstanceCodeSearch,
  GitLabListFilesOptions,
  GitLabProjectMetadata,
  GitLabReadFileOptions,
  GitLabRepository,
  GitLabTreeEntry,
} from "./types";

/**
 * A repository opened through the instance binding, pinned to the project's numeric id when it
 * was opened: a later rename or transfer moves the path, never which project is read. Holds its
 * own duplicate of the opening session's approval queue.
 */
@validateRpc()
export class GitLabRepositoryImpl extends RpcTarget implements GitLabRepository {
  readonly #context: CodeReadContext;
  readonly #approvalQueue: RpcStub<ApprovalQueue>;
  readonly #target: RepositoryTarget;

  constructor(context: CodeReadContext, approvalQueue: RpcStub<ApprovalQueue>, target: RepositoryTarget) {
    super();
    this.#context = context;
    this.#approvalQueue = approvalQueue;
    this.#target = target;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getMetadata(): Promise<GitLabProjectMetadata> {
    return await readRepositoryMetadata(this.#context, queueAuthorizer(this.#approvalQueue), this.#target);
  }

  async readFile(path: string, options?: GitLabReadFileOptions): Promise<GitLabFileContent> {
    return await readRepositoryFile(this.#context, queueAuthorizer(this.#approvalQueue), this.#target, path, options);
  }

  async listFiles(options?: GitLabListFilesOptions): Promise<Cursor<GitLabTreeEntry>> {
    const size = pageSize(options, 100);
    const queue = this.#approvalQueue.dup();
    return new PagerCursor(new RepositoryTreePager(this.#context, queueAuthorizer(queue), this.#target, {
      ...(options?.ref === undefined ? {} : { ref: options.ref }),
      ...(options?.path === undefined ? {} : { path: options.path }),
      ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
      pageSize: size,
    }), () => queue[Symbol.dispose]());
  }
}

/** The instance binding's session. */
@validateRpc()
export class GitLabInstanceSessionImpl extends RpcTarget implements GitLabInstance {
  readonly #context: CodeReadContext;
  readonly #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(context: CodeReadContext, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#context = context;
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async searchCode(query: GitLabInstanceCodeSearch): Promise<Cursor<GitLabCodeHit>> {
    const queue = this.#approvalQueue.dup();
    return new PagerCursor(new CodeSearchPager(this.#context, queueAuthorizer(queue), { kind: "instance", query }),
      () => queue[Symbol.dispose]());
  }

  /**
   * Opening a repository is an answer about the instance, found or not: that the project exists
   * (see openRepository). The stub's reads then record their own.
   */
  async getRepository(idOrPath: string): Promise<GitLabRepository> {
    const project = await openRepository(this.#context, queueAuthorizer(this.#approvalQueue), idOrPath,
      url => parseResourceUrl(this.#context.instanceUrl, url)?.projectPath ?? null);
    return new GitLabRepositoryImpl(this.#context, this.#approvalQueue.dup(),
      { projectId: project.id, projectPath: project.path_with_namespace });
  }
}
