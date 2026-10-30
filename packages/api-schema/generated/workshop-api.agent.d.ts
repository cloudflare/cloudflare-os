// Generated from packages/workshop-shared/src/api.ts by packages/api-schema/scripts/generate.ts -- do not edit.
// The Workshop API as an agent holding an AuthenticatedApi stub sees it, without the credential methods.
// Change api.ts and run `pnpm api-schema:generate`.

/**
 * Top-level API exposed to the user after they have authenticated, from which they reach their
 * workspaces and the gadgets in them.
 */
export interface AuthenticatedApi {
  /**
   * Add a blueprint to the user's library by reference, caching the current public metadata
   * snapshot for list rendering.
   */
  addBlueprintToLibrary(blueprintId: Awaitable<string>): Promise<void>;
  /**
   * Adds a new model to the user's configured set. The ID must not name a model the user already
   * added; use `updateModel()` to replace one.
   *
   * `copySecretsFrom` names a hand-added model (see `getModelConfig()`) whose stored secrets fill
   * in the `null` secrets of `config`, which is how a model is cloned without the client ever
   * holding the secrets. The rules of `updateModel()` for keeping a secret apply to copying one.
   * Without it, `config` must contain no `null` secrets. With it, `profile.id` must also not name
   * a model provided by the deployment's AI Gateway configuration.
   *
   * Throws on a deployment whose users may not add their own models (see
   * `AiGatewayInfo.userModelsEnabled`), as `updateModel()` does.
   */
  addModel(profile: Awaitable<AiChatAuthorInfo>, config: Awaitable<RedactedAiModelConfig>, copySecretsFrom?: Awaitable<string>): Promise<void>;
  /**
   * Whether the current user is a deployment admin. Used by the client to decide whether to show
   * the admin UI.
   */
  amIAdmin(): Promise<boolean>;
  /**
   * Stage a two-minute, single-use device-session transfer for a native app. The state is an
   * opaque 16–512 character URL-safe value and the key is an uncompressed P-256 public key encoded
   * as unpadded base64url. The encrypted credential remains server-side until the browser POSTs
   * the returned ticket to `/api/device-session/callback`, which redirects to the fixed, claimed
   * HTTPS app link. Repeating a live state reissues its ticket and invalidates the previous one.
   */
  beginDeviceSessionHandoff(publicKey: Awaitable<string>, state: Awaitable<string>): Promise<DeviceSessionHandoffStart>;
  /**
   * Redeem a finished connect flow's handoff. Called by the Workshop's own /connect/handoff page
   * running in the popup, over the popup's session, which is the initiating user's (the SPA
   * authenticates as any Workshop tab does: from the shared localStorage token, or from the
   * Cloudflare Access identity in an Access deployment). `ticket` is the handoff ticket from the
   * page's URL fragment; `nonce` must be the one connectAccount() / reconnectAccount() /
   * ensureAccountResources() returned for the flow that produced the ticket, read from the popup's
   * own sessionStorage. Both are single-use. Activates the pending connect / reconnect /
   * ensure-resources grant, after which the account (or its restored credentials) appears via
   * subscribeConnectedAccounts(). Throws with a user-facing message if the ticket or nonce is
   * unknown to this user, already used, or expired, or they belong to different flows.
   */
  completeConnectHandoff(ticket: Awaitable<string>, nonce: Awaitable<string>): Promise<void>;
  /** Mark the onboarding wizard as completed. */
  completeOnboarding(): Promise<void>;
  /**
   * Connect this account to an account on a connector: a third-party service or MCP server. Returns
   * the URL which the Workshop opens as a disowned popup to complete the authorization, plus the
   * flow's nonce (see `ConnectFlowStart`). When the flow finishes, the popup lands on the
   * Workshop's own /connect/handoff page, which redeems the handoff with completeConnectHandoff()
   * over its own session; only then is the account added to the list, which can be observed through
   * subscribeConnectedAccounts().
   *
   * Only the Workshop client that started the flow can complete it. The ticket arrives only in
   * the URL fragment of the /connect/handoff page the flow ends on, and that page redeems it only
   * with the nonce the Workshop stored in its popup (the native apps instead pass the ticket back
   * to the WebView that kept the nonce). The URL opened any other way, such as in a plain browser
   * tab, ends on a handoff page that redeems nothing, so a caller holding the nonce still never
   * sees the ticket (see docs/connect-handoff.md). A vendor that provisions its own account
   * (`description.autoProvisionsAccount`) needs no flow: see provisionAmbientAccount().
   *
   * `resourceUrlPatterns`, if given, limits the connection to the authorization needed for those
   * grantable resource types (those with `grantable`; see `SupportedResource`). If omitted,
   * authorization for all of the vendor's resource types is requested. An empty array is meaningful
   * and distinct from omitting it: it requests no resource authorization at all, which is how a
   * caller connects an account for a non-resource purpose (e.g. billing) without asking the user to
   * grant data access it will never use.
   */
  connectAccount(vendorId: Awaitable<string>, resourceUrlPatterns?: Awaitable<string[]>): Promise<ConnectFlowStart>;
  /**
   * Mint a single-use ticket for a user selected on behalf of a gatekeeper app,
   * redeemable through that gatekeeper app's exchange capability (see
   * GatekeeperUserSelectionExchangeImpl). Returns null if the selected user is
   * this user or does not exist.
   */
  createGatekeeperUserSelection(vendorId: Awaitable<string>, selectedUserId: Awaitable<string>): Promise<null | GatekeeperUserSelection>;
  /** Deletes a configured model. */
  deleteModel(id: Awaitable<string>): Promise<void>;
  /**
   * Delete a blueprint that the user owns. Works even if the source gadget has been deleted
   * (operates on User DO + KV directly).
   */
  deleteOrphanedBlueprint(blueprintId: Awaitable<string>): Promise<void>;
  /** Remove a connected account, revoking the token. */
  disconnectAccount(accountId: Awaitable<number>): Promise<void>;
  /**
   * Remove a shared workspace from the user's home page listing. Does NOT revoke the user's
   * access -- if they open the workspace again (e.g., via link), it reappears on their home page.
   */
  dismissSharedWorkspace(workspaceId: Awaitable<string>): Promise<void>;
  /**
   * Ensure the authorization for the listed grantable resource types (by `urlPattern`) is granted
   * on a connected account, expanding if needed. Returns a flow to open as a disowned popup, which
   * only the Workshop client that started it can complete (as for connectAccount()), to authorize
   * them, or null if nothing was needed. Completion is redeemed via completeConnectHandoff(); the
   * updated grant is then observable via subscribeConnectedAccounts().
   * Returning null also re-reads the account's description, so a list of granted resource types
   * that was out of date is corrected and observable the same way.
   */
  ensureAccountResources(accountId: Awaitable<number>, resourceUrlPatterns: Awaitable<string[]>): Promise<null | ConnectFlowStart>;
  /**
   * Returns a capability for managing deployment-wide admin settings, or null when the caller is not
   * an admin. The access check happens once here, so the returned stub's methods need no per-call
   * checks. (Authentication config — sign-in providers, password login — is intentionally not
   * managed here; it stays env-var driven.)
   * @nullWhen the caller is not a deployment admin; amIAdmin() says whether it is
   */
  getAdminApi(): Promise<null | AdminApi>;
  /**
   * Get AI configuration info, including whether AI Gateway mode is active and which providers
   * are available. The frontend uses this to adjust the model management UI.
   */
  getAiConfig(): Promise<AiGatewayInfo>;
  /**
   * Fetch a user's avatar image by user ID. Returns null if no avatar has been set.
   * Accepts any user ID so that other users' avatars can be displayed (e.g. in chat).
   */
  getAvatar(userId: Awaitable<string>): Promise<Uint8Array | null>;
  /** Get the user's current free-tier usage and connected-account balance. */
  getCloudflareUsage(): Promise<CloudflareUsageInfo>;
  /**
   * Get the app of gatekeeper `id`, such as Skills, for creating Skills/Context collections.
   * A UI-providing gatekeeper has one: Skills (`context`) has a `ui` that creates and manages
   * Skills/Context collections, and Scheduled Tasks (`scheduler`) one that lists schedules. The app
   * is the gatekeeper's frame (self-contained iframe HTML + its `ui` capability), or null if the
   * user has no such gatekeeper. An ambient one the deployment only offers is null until the user
   * opts in with provisionAmbientAccount(). The Workshop hosts the HTML in a sandboxed iframe and
   * exposes `ui` to it over a MessagePort RPC session. The `ui`'s interface is the one the
   * gatekeeper's package.json names as `cloudflareOs.appApi`.
   * @appApi ui id
   * @nullWhen the user has no gatekeeper of that id with an app, as listGatekeeperApps() lists
   * them; for an ambient one the deployment only offers, provisionAmbientAccount() with that id
   * adds it
   */
  getGatekeeperApp(id: Awaitable<string>): Promise<null | GatekeeperUiFrame>;
  /**
   * Gets the profile and configuration of a model the user added by hand, i.e. not one provided
   * by the deployment's AI Gateway configuration, with its secrets withheld.
   */
  getModelConfig(id: Awaitable<string>): Promise<{
    config: RedactedAiModelConfig;
    profile: AiChatAuthorInfo;
  }>;
  /** Return a blueprint created by the current user, or null if it is not owned by this user. */
  getOwnBlueprint(blueprintId: Awaitable<string>): Promise<null | BlueprintUserSummary>;
  /**
   * Get the user's preferred model, chosen during onboarding. Returns null if the user has not
   * set a preference (or explicitly chose "No agent"). The preference may name a model that is
   * no longer offered (see setPreferredModel).
   */
  getPreferredModel(): Promise<null | string>;
  /** Get the quick model setting. */
  getQuickModel(): Promise<null | string>;
  /** Resolve UI feature flags for the authenticated user. */
  getUiFeatureFlags(): Promise<UiFeatureFlags>;
  /**
   * Whether this account has a password set. False for accounts created via an OAuth provider, in
   * which case the change-password UI should be hidden.
   */
  hasPasswordLogin(): Promise<boolean>;
  /**
   * Import a `.gadget` archive from another Workshop instance. The imported blueprint is stored
   * as a local blueprint owned by the current user.
   */
  importBlueprint(archive: Awaitable<ReadableStream<Uint8Array>>): Promise<string>;
  /**
   * Returns info about whether the blueprint is in the user's library.
   * Returns null if not in library, or { uploaded } if it is.
   */
  isBlueprintInLibrary(blueprintId: Awaitable<string>): Promise<null | {
    uploaded: boolean;
  }>;
  /** Returns whether the blueprint is pinned by the current user. */
  isBlueprintPinned(blueprintId: Awaitable<string>): Promise<boolean>;
  /** Returns true if the user has completed the onboarding wizard. */
  isOnboardingCompleted(): Promise<boolean>;
  /**
   * List the auto-provisioning ("ambient") gatekeepers the user can opt into right now. They are
   * those set to 'optional' by the admin that the user hasn't added yet, such as Skills
   * (`context`), Scheduled Tasks (`scheduler`) or Web Search (`websearch`). Rendered as an
   * "Available" section on the Connectors page. ('enabled' ones are already provisioned; 'disabled'
   * ones aren't offered.) Returns the same shape as listGatekeeperVendors (with no resources) so
   * the connect UI handles both identically, routing on `description.autoProvisionsAccount`.
   */
  listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]>;
  /**
   * List the Cloudflare accounts the connected grant can access. Used to prompt account selection
   * when the user has more than one. Returns an empty array if not connected. Connecting Cloudflare
   * is done via the Cloudflare gatekeeper (connectAccount("cloudflare")) or by signing in with it.
   */
  listCloudflareAccounts(): Promise<CloudflareAccountOption[]>;
  /**
   * List the deployment-wide featured blueprints. This is served from a KV snapshot rather
   * than directly from the AdminSettings durable object.
   */
  listFeaturedBlueprints(): Promise<BlueprintPublicInfo[]>;
  /**
   * List the gatekeepers that expose a full-page management UI (VendorDescription.providesUi) and are
   * available to this user. The Workshop renders a nav entry + page per entry. Independent of whether
   * the gatekeeper is a singleton.
   */
  listGatekeeperApps(): Promise<GatekeeperAppInfo[]>;
  /**
   * Connectors you can connect: third-party services and MCP (Model Context Protocol) servers.
   * The services are ones such as GitHub or Slack, and the list is those this account can add.
   *
   * connectAccount() connects one, giving a connected account, and Overseer.newGatekeeper() then
   * makes one of that account's resources (a GitHub repository, an MCP server's endpoint) a
   * gatekeeper in a workspace; that is also how a workspace answers an agent's connection request
   * (see Overseer.acceptConnectionRequest()). Ambient gatekeepers need no connecting: see
   * listAddableGatekeepers().
   */
  listGatekeeperVendors(filter?: Awaitable<GatekeeperVendorFilter>): Promise<GatekeeperVendorInfo[]>;
  /**
   * List the blueprints currently in the user's library. This includes uploaded `.gadget`
   * archives (stored locally) and blueprints saved by reference from other publishers.
   */
  listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]>;
  /**
   * List the user's configured AI models of one kind, by default the language models, which can
   * chat.
   *
   * Note that the list returned here could be different from a particular gadget's Overseer,
   * especially if the gadget is owned by someone else.
   */
  listModels(kind?: Awaitable<ModelKind>): Promise<AiChatAuthorInfo[]>;
  /**
   * The deployment's standard output formats, the built-in blueprints this instance ships with and
   * any others an admin promotes, for a "New Document / New Slides / ..." menu, in the order to
   * offer them.
   * Empty when the deployment promotes none.
   *
   * These are ordinary blueprints an admin has promoted. Each blueprint bundled with the
   * deployment is promoted once, when it is first installed, and an admin may turn it off.
   */
  listOutputFormats(): Promise<OutputFormatOffer[]>;
  /**
   * List the outputs of all the user's workspaces. Used to display the Outputs page, which lets
   * the user find things they made without remembering which workspace they made them in.
   *
   * Served from an index in the user's own account which each workspace pushes to; a workspace
   * shared with the user contributes its outputs from the first time the user opens it (matching
   * when it appears in listWorkspaces()), and stops updating them if their access is revoked.
   * Provisional workspaces (still awaiting acceptance of a chat's changes) are never included.
   *
   * TODO: Pagination, sort options.
   */
  listOutputs(): Promise<ListOutputsResult>;
  /**
   * List all blueprints created by the current user (from User DO). Useful for an audit
   * view in Settings.
   */
  listOwnBlueprints(): Promise<BlueprintUserSummary[]>;
  /**
   * List the user's provisional workspaces (see newWorkspace()), which listWorkspaces() hides: one
   * made and then left, such as by a client that lost the Overseer newWorkspace() returned before
   * reading its id, is found here by when it was created, to open with openWorkspace() or delete
   * with Overseer.deleteSelf().
   */
  listProvisionalWorkspaces(): Promise<{
    /**
     * True when the workspace has observed data marked `containsRestrictedData` (see
     * `ObservationDescription`). It can still be shared, with collaborators verified per
     * gatekeeper (if `ownerInvitesOnly` is also set, only the owner can add them), but can no longer
     * fetch from the public web, and every action requires manual approval.
     */
    containsRestrictedData?: boolean;
    created: Date;
    /**
     * Various objects in the API specify a gadgetId, but make the property optional. When omitted,
     * the default gadget ID should be assumed. This is largely for backwards compatibility with
     * records that were stored before workspaces could have multiple gadgets.
     *
     * TODO(multi-gadget): Do a migration to backfill all gadget IDs, then eliminate the concept of
     * a default gadget from the API.
     */
    defaultGadgetId?: number;
    /**
     * Unique ID for this workspace, used with `openWorkspace()`. This is a url-safe base64 value
     * chosen randomly when the workspace is created.
     */
    id: string;
    /** Set while the user has muted this workspace's notifications. */
    notificationMute?: NotificationMute;
    /**
     * Set when the workspace is not owned by the current user. Presence of this field indicates the
     * user is a collaborator, not the owner.
     */
    owner?: AiChatAuthorInfo;
    /**
     * True when the workspace has observed data marked `ownerInvitesOnly` (see
     * `ObservationDescription`). Only collaborators the owner added directly have access: share
     * links can no longer be created, copied, or redeemed, and only the owner can add collaborators.
     */
    ownerInvitesOnly?: boolean;
    /** Whether the user has pinned this workspace to the top of their list. */
    pinned?: boolean;
    /**
     * The viewing user's effective role for this workspace. The owner is always "build". Used by the
     * frontend to decide whether to render the full editor ("build") or the UI-only shell ("use").
     * Absent implies "build" for backwards compatibility.
     */
    role?: CollaboratorRole;
    /**
     * Human-readable workspace title. Can be modified. (Per-gadget titles live on the gadget
     * workpieces themselves; see WorkpieceSummary.)
     */
    title: string;
    /** Total cost of AI inference in dollars, if known. */
    totalCost?: number;
  }[]>;
  /**
   * List metadata about all the user's workspaces, which hold their gadgets. Used to display the
   * front-page listing.
   *
   * Provisional workspaces are hidden.
   *
   * TODO: Pagination, sort options.
   */
  listWorkspaces(): Promise<WorkspaceMetadataWithTimestamps[]>;
  /**
   * Create a new workspace. It will start out titled "Untitled Workspace".
   *
   * Note: A workspace is considered "provisional" until it has some sort of activity, such as a
   *   chat message or code edit. Provisional workspaces do not appear on the home page
   *   (listWorkspaces() leaves them out, listProvisionalWorkspaces() lists them), and nothing
   *   deletes them but Overseer.deleteSelf(). Note in particular that calling new*Gatekeeper() will
   *   not clear the provisional bit (as long as the gatekeeper isn't bound into a gadget), so
   *   provisional workspaces are useful to allow the user to write an initial chat message without
   *   explicitly creating a new workspace.
   *
   * A client that does not keep the returned Overseer, such as a one-shot command, reads the
   * workspace's id with Overseer.getMetadata() before letting it go, and later opens the workspace
   * with openWorkspace().
   * @reportsId workspace getMetadata().id
   */
  newWorkspace(): Pipelined<Overseer>;
  /**
   * Create a new workspace from a blueprint. Reads the blueprint from KV, downloads code from
   * R2, creates a new Overseer DO, initializes it with the blueprint's code, and creates
   * gatekeepers from the provided binding assignments.
   *
   * Every required binding in the blueprint must have a corresponding entry in `bindings`,
   * keyed by binding name. Throws if any are missing or if accountId/modelId are invalid.
   *
   * The returned Overseer can be used immediately (pipelining-friendly).
   * @reportsId workspace getMetadata().id
   */
  newWorkspaceFromBlueprint(blueprintId: Awaitable<string>, bindings: Awaitable<{
    [key: string]: BlueprintBindingAssignment;
  }>): Pipelined<Overseer>;
  /**
   * Open an existing workspace, or join one shared with you by redeeming its share link's key.
   *
   * If `shareKey` is provided, the server redeems it before opening, adding the caller as a
   * collaborator. If the key is invalid or expired, the call throws an exception. If the workspace
   * has `ownerInvitesOnly` set (see `WorkspaceMetadata`), a caller the owner has not added directly
   * is refused with a `shareLinksDisabled` coded exception. This design
   * allows share-key redemption and workspace opening in a single round trip, and further calls
   * can be pipelined on the returned Overseer.
   *
   * To allow for pipelining, this throws an exception if the workspace doesn't exist. Expected
   * missing and authorization failures carry a code from `OPEN_WORKSPACE_ERROR_CODES`.
   *
   * `configureObservers` is invoked only when the opening user is a non-owner who must choose
   * connected accounts for one or more gatekeeper bindings before they can observe the workspace
   * (see ObserverConfigCallback). It is never called for the owner or an already-configured
   * observer, so the common-case open is still a single pipelined round trip.
   */
  openWorkspace(id: Awaitable<string>, shareKey?: Awaitable<string>, configureObservers?: ObserverConfigCallback): Pipelined<Overseer>;
  /**
   * Opt into an ambient gatekeeper, such as Skills (Context collections), minting its account.
   * Ambient ones include Skills (`context`), Scheduled Tasks (`scheduler`) and Web Search
   * (`websearch`), and the account is this user's connected account, minted with no OAuth flow.
   * The new account appears via subscribeConnectedAccounts(); if the user already has one, the
   * call does nothing. Throws for an unknown vendor, one whose mode is 'disabled', or one that
   * isn't ambient.
   */
  provisionAmbientAccount(vendorId: Awaitable<string>): Promise<void>;
  /**
   * Re-authenticate a connected account whose credentials have expired (or may be about to
   * expire). Returns a flow to open as a disowned popup, which only the Workshop client that
   * started it can complete (as for connectAccount()). Once the OAuth flow completes and the
   * popup's /connect/handoff page redeems the handoff via completeConnectHandoff(), the account is
   * updated and subscribers are notified with credentialsValid: true.
   */
  reconnectAccount(accountId: Awaitable<number>): Promise<ConnectFlowStart>;
  /**
   * Register one of the user's devices for push: the native app's one-time central device
   * registration, or this browser's Web Push subscription. Each registered device gets push; a
   * device that registers again replaces its own subscription. The deployment never receives an
   * APNs device token or Cloudflare account token. A browser's subscription passes through it to
   * the central notification service, which delivers to an endpoint only for its most recent
   * registration.
   */
  registerNotificationDevice(registration: Awaitable<WebPushSubscription | string>): Promise<void>;
  /**
   * Remove a blueprint from the user's library. If the library entry was uploaded by the
   * current user, this also deletes the backing blueprint content from storage.
   */
  removeBlueprintFromLibrary(blueprintId: Awaitable<string>): Promise<void>;
  /**
   * Find other users of this deployment by a case-insensitive substring of
   * their display name or id, for inviting collaborators. Excludes the caller
   * and every user named by `excludeIds`. Returns at most 10 records, earliest
   * substring match first.
   *
   * Rejects a `query` longer than 1000 characters or containing a line break,
   * and more than 1000 distinct ids to exclude, the caller's own included.
   *
   * Returns no records while the admin has user search turned off
   * (`ServerConfig.userSearchEnabled`); inviting by exact username/email via
   * `Overseer.addCollaborator()` still works then.
   */
  searchUsers(query: Awaitable<string>, excludeIds: Awaitable<string[]>): Promise<UserDirectoryRecord[]>;
  /**
   * Select which Cloudflare account to bill. Persists the choice. Throws if the account isn't
   * accessible.
   */
  selectCloudflareAccount(accountId: Awaitable<string>): Promise<void>;
  /**
   * Upload a user avatar image. The data should be a compressed image (JPEG/PNG), ideally under
   * 50 KB. Pass null to remove the avatar.
   */
  setAvatar(data: Awaitable<Uint8Array | null>): Promise<void>;
  /**
   * Pin a blueprint for quick reuse on the home page. Pinning a public blueprint that isn't
   * already yours or in your library saves it to your library first.
   */
  setBlueprintPinned(blueprintId: Awaitable<string>, pinned: Awaitable<boolean>): Promise<void>;
  /**
   * Set the email address used on git commits the user authors, or clear it with null to fall
   * back to one derived from their user ID. Rejects an address `validateCommitEmail` refuses.
   */
  setOwnCommitEmail(email: Awaitable<null | string>): Promise<void>;
  /** Set the user's own display name, seen in chats, etc. */
  setOwnDisplayName(name: Awaitable<string>): Promise<void>;
  /**
   * Set the user's preferred model. Pass null to indicate "No agent". Any model that resolves is
   * accepted, including one hidden from pickers, but a new external conversation uses the
   * preference only while it is offered, and otherwise the first offered model.
   */
  setPreferredModel(id: Awaitable<null | string>): Promise<void>;
  /**
   * Set the model to use for simple quick tasks, like generating chat titles. Set null to
   * disable quick model use (e.g. chats will be titled "New Chat").
   */
  setQuickModel(id: Awaitable<null | string>): Promise<void>;
  /**
   * Mute a workspace in the user's list, so its finished tasks notify no tab or device, or unmute
   * it with null. Permission requests still come through.
   */
  setWorkspaceNotificationMute(workspaceId: Awaitable<string>, mute: Awaitable<null | NotificationMute>): Promise<void>;
  /** Pin or unpin this workspace in the user's list. */
  setWorkspacePinned(workspaceId: Awaitable<string>, pinned: Awaitable<boolean>): Promise<void>;
  /**
   * Get the UI in which the approver of a creation of the type `resourceUrlPattern` configures it
   * in their connected account `accountId` (see SupportedResource.creationConfigurator). The
   * frame's collectResourceUrl() gives CreationApproval.configuration.
   */
  startCreationConfigurator(accountId: Awaitable<number>, resourceUrlPattern: Awaitable<string>): Promise<GatekeeperUiFrame>;
  /**
   * Get the UI used to choose a specific resource from a connected account.
   *
   * `accountId` is the user's connected account that provides this resource.
   * `resourceUrlPattern` is the `urlPattern` associated with the supported resource.
   *
   * Once the user has chosen in the frame, the Workshop asks its iframe for the resource URL
   * (ResourceConfiguratorIframe.collectResourceUrl()) and passes it to Overseer.newGatekeeper().
   * A caller without the iframe makes that URL itself, in the form of `resourceUrlPattern`, the
   * frame's `ui` helping only to look up what fills it.
   */
  startResourceConfigurator(accountId: Awaitable<number>, resourceUrlPattern: Awaitable<string>): Promise<GatekeeperUiFrame>;
  /**
   * Subscribe to the list of third-party accounts connected to the user's account.
   *
   * Dispose the returned stub to cancel the subscription.
   *
   * This is subscription-based because the flow to connect a new account completes in a separate
   * window. When it completes, we want the list of accounts in the Workshop UI to update
   * immediately, to give the user feedback that the account is now connected.
   */
  subscribeConnectedAccounts(subscriber: ConnectedAccountsSubscriber, filter?: Awaitable<ConnectedAccountsFilter>): Pipelined<Empty>;
  /**
   * Subscribe while this client can visibly present notifications. Dispose the returned handle
   * when the page becomes hidden so the backend can promptly fall back to push.
   */
  subscribeToNotifications(subscriber: NotificationSubscriber): Pipelined<Empty>;
  /**
   * Replaces the configuration of a model the user added by hand. `profile.id` names the model,
   * and `config.provider` and `config.model` must match the stored values.
   *
   * A `null` secret keeps the stored value; for a header, that of the stored header with exactly
   * the same name. Secrets may be kept only while `config.provider` and `config.apiUrl` are
   * unchanged, since otherwise the client could direct the stored secrets to a server it controls.
   * Passing back what `getModelConfig()` returned therefore changes nothing.
   */
  updateModel(profile: Awaitable<AiChatAuthorInfo>, config: Awaitable<RedactedAiModelConfig>): Promise<void>;
  /** Get profile info for the user who is logged in. */
  whoami(): Promise<AiChatAuthorInfo>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

/** Interface implemented by the client to receive action-log upserts. */
export interface ActionsSubscriber {
  entry(record: ActionLogEntry): Awaitable<void>;
  /**
   * @deprecated Fires after the subscription has caught up to the current time. However, this is
   * only a useful signal when a subscription is being used to enumerate past actions using a
   * distant-past `startAfter`. This is not the correct way to use `subscribeToActions()`; use
   * `listActions()` instead.
   */
  ready(): Awaitable<void>;
}

/**
 * Capability for managing deployment-wide admin settings, obtained via
 * AuthenticatedApi.getAdminApi() (which is null for non-admins). The access check happens when the
 * capability is minted, so these methods don't re-check. Covers branding, agent instructions,
 * which gatekeeper connectors/resources are offered, and the models an AI Gateway deployment
 * provides — NOT authentication config (that's env-var driven). Each setter throws on invalid
 * input.
 */
export interface AdminApi {
  /**
   * Add a model to the ones the deployment provides, listed after its provider's suggested models
   * and 'enabled' by default. Throws if the model is malformed (an empty or over-long ID or name,
   * an over-long `behavesLike`, a token limit that isn't a positive integer), if the gateway does
   * not serve and enable its provider (see AdminSettingsView.gatewayModels), if a suggested or
   * added model already has its ID, if the model runtime does not know its `behavesLike` under
   * its provider, or if what its context window reserves for the response (its output limit, or
   * WORKERS_AI_OUTPUT_LIMIT for a Cloudflare model that gives none) leaves a prompt no room.
   */
  addGatewayModel(model: Awaitable<GatewayModel>): Promise<void>;
  /**
   * Ask now for the newest release, whether or not automatic update checks are on, and return
   * the status that check produces. Null unless the deploy flow installed this deployment. Throws
   * when the check fails.
   */
  checkForUpdates(): Promise<null | DeploymentUpdateStatus>;
  /** Read all admin-managed settings for the admin UI in one call. */
  getSettings(): Promise<AdminSettingsView>;
  /**
   * Whether a newer release is available. Null unless the deploy flow installed this deployment.
   * While automatic update checks are off (see setUpdateChecksEnabled) it asks no one and reports
   * the last check made for the running release, if any.
   */
  getUpdateStatus(): Promise<null | DeploymentUpdateStatus>;
  /**
   * Returns whether the blueprint is featured on the deployment. Returns null when the blueprint
   * can't be featured (e.g. it isn't a listable blueprint).
   */
  isBlueprintFeatured(blueprintId: Awaitable<string>): Promise<boolean | null>;
  /**
   * Offer a blueprint as a standard format, appended last in menu order. Throws if the blueprint
   * doesn't exist. Promoting one that already is leaves its curation and menu position alone, so
   * that retrying a promotion whose mirror write failed repairs it rather than being refused.
   */
  promoteFormat(blueprintId: Awaitable<string>): Promise<void>;
  /**
   * Stop offering a blueprint as a standard format, and forget the deployment's curation of it.
   * The blueprint itself is untouched.
   *
   * Refused for a bundled blueprint (see `AdminFormat.bundled`), which the deployment installed
   * and will reinstall: `enabled: false` withdraws it without discarding the admin's overrides,
   * hint and menu position.
   */
  removeFormat(blueprintId: Awaitable<string>): Promise<void>;
  /**
   * Remove a model added with addGatewayModel(), along with its mode and settings. Throws if no
   * added model has this ID; a suggested model can't be removed, only disabled.
   *
   * Removing frees the ID rather than reserving it. The chats, spawners and preferences that name
   * the model resolve again if a model is later added under the same ID. A gadget model binding
   * minted for it carries its own provider and model, so while users may add their own models
   * (see setUserModelsEnabled) it runs once the model is removed, even if the model was disabled.
   * To shut a model off, disable it instead.
   */
  removeGatewayModel(modelId: Awaitable<string>): Promise<void>;
  /**
   * Set the deployment accent color (hex, e.g. "#3b82f6"). Pass "" to reset to the default theme.
   * Rejects an invalid hex color.
   */
  setAccentColor(color: Awaitable<string>): Promise<void>;
  /**
   * Set the top-bar notice (centered text in the top navigation bar). Pass "" to clear. Rejects over
   * MAX_ANNOUNCEMENT_LENGTH.
   */
  setAnnouncement(text: Awaitable<string>): Promise<void>;
  /**
   * Set the full-width banner. Pass an empty text to hide it. Rejects over MAX_ANNOUNCEMENT_LENGTH or
   * an invalid color.
   */
  setBanner(text: Awaitable<string>, color: Awaitable<BannerColor>): Promise<void>;
  /** Mark or unmark a blueprint as featured on the deployment. */
  setBlueprintFeatured(blueprintId: Awaitable<string>, featured: Awaitable<boolean>): Promise<void>;
  /**
   * Set the reasoning level of every gateway model that has none of its own, or null for each
   * model's built-in behaviour. It never applies to a model a user added.
   */
  setDefaultReasoning(level: Awaitable<"high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh" | null>): Promise<void>;
  /** Reorder the menu. `blueprintIds` must be a permutation of the currently promoted ids. */
  setFormatOrder(blueprintIds: Awaitable<string[]>): Promise<void>;
  /**
   * Set a gatekeeper's availability. For an auto-provisioning ("ambient") gatekeeper, `mode` is the
   * full three-state (disabled / optional / enabled); for an ordinary gatekeeper only 'disabled' /
   * 'enabled' are valid ('optional' is rejected). Soft enforcement: it doesn't revoke a capability a
   * gadget already holds, and 'disabled' leaves an ambient account's data dormant rather than deleting
   * it.
   */
  setGatekeeperMode(vendorId: Awaitable<string>, mode: Awaitable<"disabled" | "enabled" | "optional">): Promise<void>;
  /**
   * Set how the deployment offers one of its gateway models (see GatewayModelMode). Setting the
   * model's default mode forgets the override, so the model follows its default from then on.
   * Throws if `modelId` is not one of the deployment's gateway models.
   *
   * 'disabled' revokes nothing that is stored: the chats, spawners, preferences and gadget model
   * bindings that name the model keep naming it, and stop resolving for as long as it is disabled.
   */
  setGatewayModelMode(modelId: Awaitable<string>, mode: Awaitable<"disabled" | "enabled" | "hidden">): Promise<void>;
  /**
   * Replace what the deployment sets for one of its gateway models (see GatewayModelSettings):
   * a field left out of `settings` is unset, and an empty `settings` unsets everything. Throws
   * if `modelId` is not one of the deployment's gateway models, or if the compaction budget is
   * not a positive whole number within the model's maximum (see
   * AdminModelView.maxCompactionInputBudget).
   *
   * The reasoning level may be one the model lacks, since it is fitted to the model when a
   * request is made (see ReasoningLevel).
   */
  setGatewayModelSettings(modelId: Awaitable<string>, settings: Awaitable<GatewayModelSettings>): Promise<void>;
  /**
   * Turn a provider on or off beside the ones CF_AI_GATEWAY_PROVIDERS lists. On is the same as
   * listing it there: its suggested models appear in their default modes, models can be added
   * under it, and so can users' own while those are allowed. Throws for a provider the gateway
   * does not serve, and when turning off one that the variable lists: it is a floor, which an
   * admin adds to.
   *
   * Off takes the provider's models out of the deployment's and deletes nothing: their modes and
   * settings, and the models added under the provider, are kept for when it is back on. It stops
   * neither a model a user already added under the provider nor a gadget model binding already
   * minted for one of its models, which setUserModelsEnabled(false) does.
   */
  setGatewayProviderEnabled(provider: Awaitable<AiModelProvider>, enabled: Awaitable<boolean>): Promise<void>;
  /** Replace the agent system-prompt instructions. Pass "" to clear. Rejects over MAX_INSTANCE_INSTRUCTIONS_LENGTH. */
  setInstanceInstructions(text: Awaitable<string>): Promise<void>;
  /**
   * Set whether the admin UI may suggest models from models.dev while an admin adds one. Off by
   * default.
   *
   * The admin's browser reads the setting and, with it on, downloads models.dev's public model
   * list while an admin adds a model, to fill in the add-model form. It changes nothing the server
   * does: the server never contacts models.dev, and addGatewayModel() validates a suggested model
   * like any other.
   */
  setModelsDevSuggestions(enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Enable or disable a single gatekeeper resource type, keyed by vendor id + resource urlPattern.
   * Soft enforcement: disabling hides the resource from the connect UI, the resource picker, and the
   * agent; it doesn't revoke a capability a gadget already holds.
   */
  setResourceEnabled(vendorId: Awaitable<string>, urlPattern: Awaitable<string>, enabled: Awaitable<boolean>): Promise<void>;
  /** Enable or disable new account signups. Existing users can still log in while signups are closed. */
  setSignupsEnabled(enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Set the deployment logo from browser-rasterized PNG bytes and return its canonical public
   * image, or undefined after reset. Pass null to restore the default Cloudflare OS mark. The
   * caller must supply decodable PNG data; the server enforces its header, size, and dimensions.
   */
  setSiteLogo(data: Awaitable<Uint8Array | null>): Promise<AvatarImage | undefined>;
  /**
   * Set the site name shown next to the top-bar logo. Pass "" to reset to DEFAULT_SITE_NAME.
   * Rejects over MAX_SITE_NAME_LENGTH.
   */
  setSiteName(name: Awaitable<string>): Promise<void>;
  /**
   * Set how many minutes a successful update check is relied on before the deployment asks again,
   * DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES by default. A failed check is retried after the interval
   * or 15 minutes, whichever is shorter. The deployment asks only while an admin is using it
   * (getUpdateStatus() makes the check when one is due), never on a schedule of its own. Throws
   * unless `minutes` is a whole number from 1 to MAX_UPDATE_CHECK_INTERVAL_MINUTES.
   */
  setUpdateCheckIntervalMinutes(minutes: Awaitable<number>): Promise<void>;
  /**
   * Set whether the deployment checks for updates by itself. On by default. When off,
   * getUpdateStatus() makes no outbound call and admins are never notified; checkForUpdates()
   * still asks.
   */
  setUpdateChecksEnabled(enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Set how many hours a newer release must have been available before admins are notified of
   * it, DEFAULT_UPDATE_MINIMUM_AGE_HOURS by default. It delays the notice only: an update always
   * installs the newest release. 0 notifies as soon as a check reports an update. Throws unless
   * `hours` is a whole number from 0 to MAX_UPDATE_HOURS.
   */
  setUpdateMinimumAgeHours(hours: Awaitable<number>): Promise<void>;
  /**
   * Set how many hours a dismissed update notice stays hidden in the browser that dismissed it,
   * DEFAULT_UPDATE_NOTICE_SNOOZE_HOURS by default. 0 means a closed notice comes back on the next
   * visit to Home. Throws unless `hours` is a whole number from 0 to MAX_UPDATE_HOURS.
   */
  setUpdateNoticeSnoozeHours(hours: Awaitable<number>): Promise<void>;
  /**
   * Set whether users may add models of their own, which run through the deployment's gateway
   * like the models it provides. On by default.
   *
   * Off makes the deployment's models the only ones: a user can't add or edit a model, and the
   * models users added are neither listed nor resolved. A gadget model binding stops at its next
   * call unless a gateway model has its provider and model. Nothing stored is deleted, so the
   * models users added work again once this is back on.
   */
  setUserModelsEnabled(enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Enable or disable user directory search. The directory itself is maintained
   * either way, and this switch just controls user access.
   */
  setUserSearchEnabled(enabled: Awaitable<boolean>): Promise<void>;
  /**
   * Send one request to a gateway model the way a chat turn would, through the gateway, as the
   * admin, and report what happened within 30 seconds. The request asks for the reasoning level
   * in effect for the model (its own, else the deployment's default, else what BuiltInReasoning
   * describes), with the capabilities stated for it and the flags of the model it behaves like,
   * under a response cap of at most 2,048 tokens. A level that a model takes as a token budget
   * comes out of that cap, so it is cut to the room the cap leaves and is smaller than a chat's.
   * It works on a model in any mode, hidden and disabled included, and changes nothing. Throws
   * outside AI Gateway mode and for an ID that names no gateway model; a request that fails is a
   * result (see GatewayModelTest).
   *
   * A pass says that the model answered that one request. It costs more than
   * testGatewayProvider(), whose quick request is capped at a few tokens.
   */
  testGatewayModel(modelId: Awaitable<string>): Promise<GatewayModelTest>;
  /**
   * Send one small request to the first of a provider's SUGGESTED_MODELS through the gateway, as
   * the admin, and report what happened within 15 seconds: the Workshop can't see which provider
   * keys the gateway holds. It works on a provider that is off, and changes nothing. Throws for
   * a provider the gateway does not serve; a request that fails is a result (see
   * GatewayModelTest).
   *
   * A pass says that one model answered once. A 401 or 403 does not tell a provider key the
   * gateway lacks from a CF_AI_GATEWAY_API_TOKEN that may not run models. The request is a
   * quick one that takes none of a model's settings: testGatewayModel() sends a model the
   * request its chats would.
   */
  testGatewayProvider(provider: Awaitable<AiModelProvider>): Promise<GatewayModelTest>;
  /**
   * Test a model as described, without adding it. It sends one request the way a chat turn would
   * with no reasoning level set (so asking for what BuiltInReasoning describes, whatever the
   * deployment's default level is), and one at each reasoning level the model would list once
   * added (see AdminModelView.reasoningLevels). The requests are sent together, through the
   * gateway, as the admin, each under testGatewayModel()'s response cap and time limit. The
   * results come with the request that set no level first, then the levels from least to most.
   * It stores nothing. Throws outside AI Gateway mode and for a model addGatewayModel() would
   * refuse, for the same reason; a request that fails is a result (see GatewayModelLevelTest).
   *
   * A pass says that the model answered that one request. A model that lists every level is sent
   * eight requests, each of which may use the whole response cap.
   */
  testNewGatewayModel(model: Awaitable<GatewayModel>): Promise<GatewayModelLevelTest[]>;
  /**
   * Update one promoted format. Only the provided fields change. `agentHint: ""` clears the hint;
   * an `overrides` field set to null reverts that field to the blueprint's own declaration.
   */
  updateFormat(blueprintId: Awaitable<string>, patch: Awaitable<AdminFormatPatch>): Promise<void>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

/**
 * Interface implemented by the client to receive callback notifications whenever there is new
 * chat activity. Use Overseer.subscribeToChat() to register a subscriber.
 */
export interface AiChatSubscriber {
  /**
   * Delivers one accepted change of a chat's change stream: a human submitCodeChange(), an agent
   * tool edit (broadcast when the tool call completes, superseding the provisional editPreview*
   * stream of its in-progress content -- see AiChatStreamEvent). Changes must be applied in
   * revision order within a generation; a gap means events were lost and the client should
   * rebuild from fresh metadata and history. On a generation switch, first finish the old
   * generation's remaining changes -- complete once seen through
   * ChatCodeBase.prior.finalRevision -- before re-basing onto the new stream (see
   * ChatCodeBase.prior), and ignore stray events only for generations fully left behind.
   * Subscriptions replay each chat's not-yet-materialized changes, so newly-joined clients can
   * reconstruct uncommitted state without a separate fetch; changes a `changes` message has since
   * absorbed are dropped via the message's `watermark` instead (there is no separate "cleared"
   * event).
   *
   * Changes produced by submitCodeChange() echo the submitter's identity as `submission` (the
   * CodeChangeSubmission's clientId and seq), so the submitting client recognizes its own change
   * -- in the live feed and in subscribe-replay alike, without depending on ack/broadcast
   * ordering -- and drops its in-flight buffer instead of re-applying. The echo is informational
   * only; server-authored changes (agent edits) omit it.
   */
  changeApplied(chatId: number, generation: number, revision: number, author: AiChatAuthorInfo, change: CodeChange, submission?: {
    clientId: string;
    seq: number;
  }): Awaitable<void>;
  /** Indicates the chat thread was deleted. */
  deleted(chatId: number): Awaitable<void>;
  /** Adds a message to the chat. */
  message(msg: AiChatMessage): Awaitable<void>;
  /** Metadata for the given chat thread has changed, or a new chat thread was created. */
  metadata(chat: AiChatMetadata): Awaitable<void>;
  /** Delivers one provisional streaming event. Clients may ignore event types they don't support. */
  stream(chatId: number, event: AiChatStreamEvent): Awaitable<void>;
  /**
   * Sent exactly once, at the start of a subscription, before any other callbacks. Carries an
   * opaque value identifying the current server (Overseer DO) instance. If a resubscribing client
   * sees a different value than on its previous subscription, the DO has fully restarted since
   * then, meaning any in-flight provisional stream content was lost and will be re-streamed from
   * scratch; the client should discard its provisional streaming state. An unchanged value (a
   * plain network reconnect to the same live instance) means provisional state should be kept.
   */
  streamGeneration(generation: number): Awaitable<void>;
}

/** Subscription callback for AuthenticatedApi.subscribeConnectedAccounts(). */
export interface ConnectedAccountsSubscriber {
  /**
   * If `credentialsValid` is false, the account's credentials are known to be expired, and the
   * UI should call reconnectAccount() to fix this if the user tries to select this account.
   */
  add(id: number, description: AccountDescription, vendor: VendorDescription, supportedResources: SupportedResource[], credentialsValid: boolean, vendorId: string): Awaitable<void>;
  /** Called after add() has been called for all accounts known so far. */
  ready(): Awaitable<void>;
  remove(id: number): Awaitable<void>;
}

/**
 * Interface implemented by the client to receive callback notifications about console logs written
 * by the gadget.
 */
export interface ConsoleLogSubscriber {
  /**
   * Deliver a batch of logs. Often just one log is delivered at a time, but for efficiency they
   * may be batched.
   *
   * If `chatId` is non-null, then the logs were generated while running the version of the gadget
   * code including the changes in the given chat. This can be used to associate the logs with
   * an ongoing agent session and report them to that session.
   */
  event(chatId: null | number, logs: ConsoleLogEvent[]): Awaitable<void>;
}

export interface Empty {
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

/**
 * Capability representing one gadget workpiece within a workspace. Obtained from
 * Overseer.createGadget() or Overseer.getGadget(). Workspace-level concerns (code sync, chats,
 * sharing, actions, blueprint listing) stay on Overseer; this covers the per-gadget surface.
 */
export interface GadgetClient {
  /**
   * Propose merging the current release of a blueprint into this gadget: to take an update from
   * the blueprint the gadget follows, or to switch it to another. The proposal is recorded in a
   * new chat (see AiChatMessageBody.blueprintMerges), where it is previewed and then accepted
   * or discarded like any other proposed change. Nothing about the gadget changes until it is
   * accepted, including which blueprint it follows.
   *
   * The merge is three-way, against the newest version the gadget and the release have in
   * common. If they share no history that version has to be guessed, which is only done if
   * `allowUnrelated` is set (see ApplyBlueprintResult). Unless the release is already in the
   * gadget's history, the merge is written as a commit, which the new chat is pinned at.
   *
   * A proposal of kind "merge" starts an agent turn in the new chat, to resolve what conflicted
   * and to check that the two sets of changes work together. `modelId` is the model that runs
   * it: as for Overseer.newChat(), one of the IDs in the result of `listModels()`, or null for
   * no agent. No other proposal starts a turn.
   *
   * Throws if the blueprint does not exist, or if the gadget is still pending in a chat and so
   * has no committed code to merge into. Throws too, creating no chat, if the gadget and the
   * blueprint both changed a file and a version of it, or the merged text, is too large for a
   * file to hold; the error names the file. Making it smaller, or undoing the gadget's own
   * changes to it, lets the blueprint be applied.
   */
  applyBlueprint(blueprintId: Awaitable<string>, options: Awaitable<{
    allowUnrelated?: boolean;
    modelId: null | string;
  }>): Promise<ApplyBlueprintResult>;
  /**
   * Bind the given workpiece (a gatekeeper) into this gadget's `env` under `name`. Throws if the
   * name is invalid (see validateBindingName()), reserved, or already bound in this gadget
   * (including bound provisionally by another chat).
   *
   * If `chatId` is provided, the binding is treated like an edit made in the given chat -- it is
   * proposed, but someone needs to click "accept changes" (call `mergeChanges()`) to make it
   * final. Until then it exists only in the given chat.
   */
  bind(name: Awaitable<string>, target: Awaitable<number>, chatId?: Awaitable<number>): Promise<void>;
  /**
   * Like bind(), but if the target isn't already bound in this gadget, choose a name based on the
   * resource's own suggestion (deduplicated against this gadget's existing binding names). If the
   * target is already bound, does nothing. Either way, returns the target's binding name.
   */
  bindWithSuggestedName(target: Awaitable<number>, chatId?: Awaitable<number>): Promise<string>;
  /**
   * Open an RPC connection to the gadget's server side, which holds its data, to call it.
   * The server side is the gadget's Durable Object facet, and the calls are to its own methods.
   * The frontend may pass this stub into the gadget's iframe sandbox, so that the gadget UI can
   * communicate with its server side. It can also permit the coding agent to make direct calls.
   *
   * The methods are the gadget's own code, so this API does not list them: the gadget's README.md
   * and server.js say what they are, readable through Overseer.listTree() and
   * Overseer.readFilesAtCommit() at its head commit (GadgetSummary.commitId).
   *
   * If `chatId` is specified, then the gadget will include changes currently proposed in the given
   * chat.
   */
  connectToGadget(chatId?: Awaitable<number>): Promise<UntypedStub>;
  /**
   * Publish this gadget's current committed code as a new blueprint.
   * PublicApi.downloadBlueprint() exports it as a `.gadget` archive.
   * `title` defaults to the gadget's title if omitted.
   *
   * The blueprint is always owned by the workspace owner, regardless of who calls this method.
   *
   * Steps: generate ID, snapshot code, collect binding metadata, store locally, propagate
   * to User DO + KV + R2. Maintenance of existing blueprints stays on Overseer (see
   * Overseer.updateBlueprint() etc.).
   */
  createBlueprint(title?: Awaitable<string>, description?: Awaitable<string>, screenshot?: Awaitable<BlueprintScreenshotUpload>): Promise<BlueprintGadgetSummary>;
  /**
   * Exports the format with the given ID. If `chatId` is specified, the export
   * uses changes currently proposed in that chat.
   */
  export(id: Awaitable<string>, chatId?: Awaitable<number>): Promise<ReadableStream<Uint8Array>>;
  /**
   * Get the gatekeeper bound under the given name, or null if there is no such binding.
   * @nullWhen this gadget has no accepted binding by that name whose gatekeeper still exists;
   * listBindings() also lists one whose gatekeeper is gone, and, given a chat, that chat's pending ones
   */
  getBinding(name: Awaitable<string>): Promise<null | GatekeeperClient>;
  /**
   * Get the blueprint annotation for the named binding, if one has been set. Annotations live on
   * the binding edge, not on the target gatekeeper (see BlueprintBindingAnnotation).
   */
  getBlueprintAnnotation(name: Awaitable<string>): Promise<null | BlueprintBindingAnnotation>;
  /**
   * Lists the Gadget's supported file export formats. If `chatId` is specified,
   * the formats are read from the code currently proposed in that chat.
   */
  getExportFormats(chatId?: Awaitable<number>): Promise<GadgetExportFormat[]>;
  /** Get the workpiece's ID, unique among all workpieces in the workspace (of any type). */
  getId(): Promise<number>;
  /**
   * Human-readable title, for display. For a gadget this is its user-renamable title; for a
   * gatekeeper it is the connected resource's title.
   */
  getTitle(): Promise<string>;
  /**
   * Get the gadget's deployed UI code, to be run inside an iframe sandbox.
   *
   * Returns null if the gadget has no deployed UI code (e.g. if it's new, or if it's just an AI
   * agent with no code).
   */
  getUiBundle(chatId?: Awaitable<number>): Promise<null | UiBundle>;
  /**
   * List this gadget's bindings: the names it adds to its worker's `env`, besides the GADGET and
   * GIT every one holds, with what each is bound to.
   *
   * If `chatId` is specified, bindings which have been proposed but not yet accepted in the given
   * chat thread will be included.
   */
  listBindings(chatId?: Awaitable<number>): Promise<GadgetBindingInfo[]>;
  /**
   * Delete this workpiece (a gadget or a gatekeeper), permanently removing it from the workspace.
   *
   * For a gadget, this deletes its registry entry (including its binding map) and hooks and
   * clears its files; gatekeepers it bound survive, possibly no longer bound by any gadget. For
   * a gatekeeper, this destroys the connection itself -- distinct from merely unbinding it from
   * one gadget (GadgetClient.unbind()).
   */
  remove(): Promise<void>;
  /**
   * Rename a binding while preserving its target and blueprint annotation. Throws if `oldName`
   * does not exist or `newName` is reserved or already bound in this gadget.
   */
  renameBinding(oldName: Awaitable<string>, newName: Awaitable<string>): Promise<void>;
  /** Set the blueprint annotation for the named binding. */
  setBlueprintAnnotation(name: Awaitable<string>, annotation: Awaitable<BlueprintBindingAnnotation>): Promise<void>;
  /**
   * Rename this workpiece (a gadget or a gatekeeper): change its title.
   *
   * (Note gatekeeper titles are initially based on the title of the underlying resource, but this
   * method does not change the remote resource, only the display name used locally within this
   * workspace.)
   */
  setTitle(title: Awaitable<string>): Promise<void>;
  /**
   * Remove the binding with the given name. This only removes the edge from this gadget -- the
   * target gatekeeper itself survives (possibly no longer bound by any gadget); use
   * GatekeeperClient.remove() to destroy the connection itself.
   */
  unbind(name: Awaitable<string>): Promise<void>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

/**
 * Capability representing one gatekeeper (connection) workpiece. Note that binding-edge
 * operations -- binding names and blueprint annotations -- live on GadgetClient, since a
 * gatekeeper may be bound by several gadgets under different names.
 */
export interface GatekeeperClient {
  /** Get the resource description, including the schema of its RPC interface. */
  describe(): Promise<ResourceDescription>;
  /** Get the creation spec describing how this gatekeeper was originally created. */
  getCreationSpec(): Promise<GatekeeperCreationSpec>;
  /** Get the workpiece's ID, unique among all workpieces in the workspace (of any type). */
  getId(): Promise<number>;
  /**
   * Human-readable title, for display. For a gadget this is its user-renamable title; for a
   * gatekeeper it is the connected resource's title.
   */
  getTitle(): Promise<string>;
  /**
   * Open a direct session to this gatekeeper. Particularly useful when using the AI agent to talk
   * to the resource directly.
   */
  openSession(): Promise<UntypedStub>;
  /**
   * Delete this workpiece (a gadget or a gatekeeper), permanently removing it from the workspace.
   *
   * For a gadget, this deletes its registry entry (including its binding map) and hooks and
   * clears its files; gatekeepers it bound survive, possibly no longer bound by any gadget. For
   * a gatekeeper, this destroys the connection itself -- distinct from merely unbinding it from
   * one gadget (GadgetClient.unbind()).
   */
  remove(): Promise<void>;
  /**
   * Rename this workpiece (a gadget or a gatekeeper): change its title.
   *
   * (Note gatekeeper titles are initially based on the title of the underlying resource, but this
   * method does not change the remote resource, only the display name used locally within this
   * workspace.)
   */
  setTitle(title: Awaitable<string>): Promise<void>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

/** Callback used by `AuthenticatedApi.subscribeToNotifications()`. */
export interface NotificationSubscriber {
  /**
   * Present a notification to the active user. Resolve only once the user has seen it, or is
   * already viewing its chat; if no subscriber resolves promptly, the backend falls back to push to
   * the user's registered devices and browsers.
   */
  notify(notification: UserNotification): Awaitable<void>;
}

/**
 * Provided by the client when opening a workspace with openWorkspace(). Invoked by the overseer
 * ONLY if the opening user must choose connected accounts for one or more gatekeeper bindings
 * before they can observe the workspace. In the common case (owner, or an already-configured
 * observer) this is never called and openWorkspace() resolves without an extra round trip. The
 * overseer does not resolve openWorkspace() until this returns. If the user cannot or will not
 * provide the needed accounts, the callback should reject, and the overseer denies the open.
 *
 * `configure()` may be called a second time within one open, for the subset of bindings that failed
 * verification (each carrying an ObserverBindingNeed.failure). This lets the user repair a binding --
 * typically by re-authenticating the account whose credentials expired -- without leaving the flow.
 * The overseer bounds the number of such re-prompts, so a client that resubmits an account that
 * keeps failing eventually gets a denial rather than an endless loop.
 */
export interface ObserverConfigCallback {
  configure(needs: ObserverBindingNeed[]): Awaitable<ObserverAccountChoice[]>;
}

/**
 * Interface to a workspace's Overseer, used to display the Gadget Workshop shell UI around that
 * workspace. Workspace-level concerns live here: the gadget registry, committed code (git
 * commits in the workspace's shared object store, each gadget's head recorded in
 * WorkpieceSummary.commitId), per-chat uncommitted changes (a revisioned stream of code changes per
 * chat, applied on top of commits; see ChatCodeBase), chats, actions/hooks, sharing, and
 * blueprint listing. Per-gadget operations live on the GadgetClient sub-capability (see
 * createGadget()/getGadget()).
 */
export interface Overseer {
  /**
   * Accept an agent's pending connection request (a "connectionRequest" chat message). The caller
   * is responsible for having actually created the gatekeeper (via newGatekeeper()) and passes the
   * resulting gatekeeper id. The gatekeeper is surfaced to the agent as a named binding in the
   * chat's env, under the name the agent chose when it made the request (see
   * `connectionRequest.bindingName`). This marks the request accepted, updates the inline card,
   * and resumes the agent so it can use the resource.
   */
  acceptConnectionRequest(requestId: Awaitable<string>, result: Awaitable<{
    gatekeeperId: number;
  }>): Promise<void>;
  /**
   * Share this workspace with another user, inviting them by username/email as a collaborator.
   * `role` is the access to grant. The caller must be the owner or an existing collaborator, and
   * may not grant a role higher than their own effective role. Returns the new collaborator's info,
   * or null if the username doesn't correspond to an existing account.
   */
  addCollaborator(username: Awaitable<string>, role: Awaitable<CollaboratorRole>, note?: Awaitable<string>): Promise<null | CollaboratorInfo>;
  /**
   * Approve an action that is currently in the "pending" state. The action will be performed on
   * approval. Approving a creation (see ActionLogEntry.creation) requires `creation`: how the
   * approver chose to make it.
   */
  approveAction(id: Awaitable<number>, creation?: Awaitable<CreationApproval>): Promise<void>;
  /**
   * Create a new gadget workpiece in this workspace. `title` is required -- gadgets have no
   * default title. The new gadget starts with no files and no bindings.
   *
   * If `chatId` is provided, the creation is provisional to that chat, exactly like code edits
   * made with a chat open: a `changes` message records it in the chat log (see
   * `createdGadgets`), and the gadget remains pending (see WorkpieceSummary.chatId) until
   * the user accepts the chat's changes through that message (merging deletes the pending marker;
   * reverting deletes the gadget). Without `chatId` the gadget is created permanently, with an
   * empty initial commit as its head (see WorkpieceSummary.commitId).
   *
   * `bindingName` is the name under which the gadget appears in chat envs and the workspace
   * default binding list (see validateBindingName()). When absent, the server chooses one from
   * the title (via the quick model when configured, else a generic fallback). Gadget binding
   * names are unique within the workspace: throws if the name is already taken by another
   * gadget -- including one still pending in another chat (retry after that chat's changes are
   * accepted or reverted).
   */
  createGadget(title: Awaitable<string>, chatId?: Awaitable<number>, bindingName?: Awaitable<string>): Pipelined<GadgetClient>;
  /**
   * Create a share link for this workspace. The server generates a random 128-bit key, stores its
   * HMAC-SHA-256 hash, and returns the raw key (hex-encoded) along with the id of the link it
   * created. The caller constructs a URL from the key. The raw key is never stored server-side.
   * `role` is the access level granted to anyone who redeems the link; the caller may not grant a
   * role higher than their own effective role.
   *
   * A signed-in user redeems the key by passing it as `shareKey` to
   * AuthenticatedApi.openWorkspace(), which adds them as a collaborator and opens the workspace.
   */
  createShareLink(role: Awaitable<CollaboratorRole>, note?: Awaitable<string>): Promise<{
    key: string;
    linkId: string;
  }>;
  /** Delete a blueprint. Cleans up KV, R2, User DO, and local storage. */
  deleteBlueprint(blueprintId: Awaitable<string>): Promise<void>;
  /** Delete a chat thread. */
  deleteChat(chatId: Awaitable<number>): Promise<void>;
  /** Permanently delete the hook, disabling it first, which removes a scheduled task for good. */
  deleteHook(id: Awaitable<number>): Promise<void>;
  /**
   * Instruct the workspace to delete itself, removing it from the User's workspace list and
   * deleting all data. Further method calls will fail.
   *
   * TODO: Implement undelete, maybe using PITR...
   */
  deleteSelf(): Promise<void>;
  /**
   * Deny an agent's pending connection request. Updates the inline card. Does NOT resume the agent:
   * the turn stays ended so the user can decide what to tell the agent to do instead.
   */
  denyConnectionRequest(requestId: Awaitable<string>): Promise<void>;
  /**
   * Disable the hook with the given ID: callbacks stop, and a scheduled task is removed. Enabling
   * the hook again re-creates the task's schedule from its original timing, so a one-time task
   * whose time has passed meanwhile never runs.
   */
  disableHook(id: Awaitable<number>): Promise<void>;
  /**
   * Discard the chat's changes not yet materialized into a durable `changes` message, without
   * affecting any messages. Pins those changes established (and no materialized message declared)
   * are removed with them, and ChatCodeBase.generation is bumped destructively, exactly as with
   * revertChanges(): clients' content contains the erased changes, so they must rebuild. A late
   * retry of an erased change is still recognized rather than applied as new (see
   * submitCodeChange()).
   */
  discardChatDraftChanges(chatId: Awaitable<number>): Promise<void>;
  /**
   * Enable the hook with the given ID, so callbacks begin flowing: a scheduled task needs it.
   * Until then the task does not run.
   */
  enableHook(id: Awaitable<number>): Promise<void>;
  /**
   * Materialize the chat's changes not yet covered by a durable `changes` message into one, without
   * merging anything into the mainline. (Materialization also happens automatically: at agent
   * turn start, at accept, and when the un-materialized changes grow past a size/age threshold. It
   * invalidates nothing -- the message's `watermark` tells clients which changes it absorbed.)
   */
  finalizeChatDraft(chatId: Awaitable<number>): Promise<void>;
  /**
   * Fetch the bytes of a committed chat attachment over RPC. The canonical metadata is already
   * present in the message's ChatAttachmentRef. Images are inlined there, so this is normally used
   * only to download non-image attachments on demand.
   */
  getChatAttachmentContent(chatId: Awaitable<number>, id: Awaitable<string>): Promise<Uint8Array>;
  /**
   * Fetch one page of messages in the chat history for the given chat thread. If `beforeSequence`
   * is absent, fetch the current tail. Otherwise, fetch messages before that sequence.
   *
   * Note that if you plan to subscribe to updates, you should initiate the subscription first,
   * before fetching history. Otherwise, you could theoretically miss a message that is sent
   * between when you fetch the history and when you subscribe.
   *
   * In typical usage, the client subscribes to all chat activity upfront, but only fetches
   * histories if and when the user opens a specific.
   */
  getChatHistory(chatId: Awaitable<number>, beforeSequence?: Awaitable<number>): Promise<AiChatHistoryPage>;
  /** Fetch a single message from a chat thread. */
  getChatMessage(chatId: Awaitable<number>, sequence: Awaitable<number>): Promise<AiChatMessage | undefined>;
  /**
   * Walk the commit graph from `fromCommit` (that commit first, then its ancestry), returning up
   * to `depth` commits' metadata -- all reachable commits when `depth` is omitted. Traversal
   * order for merge commits follows git log's default (reverse chronological). Like
   * listTree(), results are immutable and cacheable.
   */
  getCommitLog(fromCommit: Awaitable<string>, depth?: Awaitable<number>): Promise<CommitInfo[]>;
  /**
   * Get the gadget with the given workpiece ID. To allow for pipelining, this throws an
   * exception if there is no such gadget.
   */
  getGadget(id: Awaitable<number>): Pipelined<GadgetClient>;
  /** Get an existing gatekeeper by workpiece ID. Throws if the ID doesn't exist. */
  getGatekeeperById(id: Awaitable<number>): Pipelined<GatekeeperClient>;
  /** Get metadata describing this workspace. */
  getMetadata(): Promise<WorkspaceMetadata>;
  /**
   * Fetch one page of action history, newest first by id (creation order). "all" (the default)
   * pages every record and a record type pages that type — pending records included, each at its
   * creation position; `filter: "pending"` pages only the currently-pending records — the query
   * half of the query-for-state/subscribe-for-deltas contract (see subscribeToActions()).
   *
   * Page size is a server constant. Pages are full until the last: absence of `nextBeforeId`
   * means the history is exhausted; otherwise it is the id of the last returned entry, to pass
   * as `beforeId` for the next-older page.
   */
  listActions(options?: Awaitable<{
    beforeId?: number;
    filter?: ActionHistoryFilter;
  }>): Promise<ActionHistoryPage>;
  /** List the currently-enabled auto-approval rules. */
  listAutoApprovedActionKinds(): Promise<{
    actionKind: ActionKind;
    gatekeeperId: number;
  }[]>;
  /** List blueprints created from this workspace's gadgets. */
  listBlueprints(): Promise<BlueprintGadgetSummary[]>;
  /**
   * List the paths whose entry differs between two commits' trees: added, removed, or changed
   * in content or mode, sorted by code unit (as `Array.prototype.sort()` sorts). Only files are
   * listed, never a directory: a symlink or submodule is listed as a file is, and a name that is
   * a file in one tree and a directory in the other lists the file and the paths within the
   * directory. The two commits may come in either order; the list is the same.
   *
   * Like listTree(), only tree objects are read, never blobs, and a subtree with the same id
   * in both is not read at all, so the cost is proportional to what differs. The result is
   * immutable and cacheable by the pair of commit IDs.
   *
   * This is how a client finds the files a merge changed: where a chat's pin has a `baseCommit`
   * other than its `mergedCommit` (see ChatGadgetPinState), the files that differ between the
   * two are changed in the chat even where none of the chat's code changes touch them.
   */
  listChangedPaths(fromCommit: Awaitable<string>, toCommit: Awaitable<string>): Promise<string[]>;
  /** List past AI chats. */
  listChats(): Promise<AiChatMetadata[]>;
  /**
   * List who this workspace is shared with: its collaborators, the owner aside. Available to owner
   * and all collaborators.
   */
  listCollaborators(): Promise<CollaboratorInfo[]>;
  /**
   * List the hooks waking the workspace's gadgets: scheduled tasks (the scheduler's) and more.
   * A hook is a callback through which a gatekeeper wakes a gadget: for a scheduled task (the
   * scheduler gatekeeper), or for an incoming email or GitHub event.
   *
   * A gatekeeper binds a hook disabled, when the gadget or an agent registers for it, and it
   * delivers nothing until enableHook(). The scheduler offers no way to unregister a schedule:
   * stopping or removing one is disabling or deleting its hook (disableHook(), deleteHook()).
   *
   * The list spans the whole workspace; each entry names the gadget it wakes (see
   * BoundHookInfo.gadgetId), so a per-gadget view must filter on that.
   */
  listHooks(): Promise<BoundHookInfo[]>;
  /**
   * List available language models; decision models are left out. The first listed model should
   * be the default, unless the user has chosen something else.
   */
  listModels(): Promise<AiChatAuthorInfo[]>;
  /**
   * List the connections a recipient with `role` must verify before opening this workspace, in
   * the order the connections were created. Reports what sharing will cost the recipient; it
   * grants nothing and mints no capability.
   */
  listObserverRequirements(role: Awaitable<CollaboratorRole>): Promise<ObserverBindingNeed[]>;
  /**
   * List the auto-approvable action kinds offered by gatekeepers bound in this workspace. Each
   * entry identifies its connection and reports whether a matching auto-approval rule is enabled.
   */
  listPreApprovableActions(): Promise<PreApprovableAction[]>;
  /** List active share links (for management UI). */
  listShareLinks(): Promise<ShareLinkInfo[]>;
  /**
   * Lists the slash commands available in this workspace: the built-in ones, and those of the
   * Gatekeepers currently attached to it, including ambient ones.
   */
  listSlashCommands(): Promise<SlashCommandChoice[]>;
  /**
   * Read a commit's whole tree as nested TreeNodes: the root directory's entries, each
   * directory carrying its own, in git tree order (byte order of names, a directory sorting as
   * if its name had a trailing `/`). Only tree objects are read -- never blobs -- so the
   * response is proportional to the commit's entry count. Commits are immutable, so responses
   * are cacheable client-side by commit ID. Like readFilesAtCommit(), the read may pull missing
   * trees through the gatekeeper that provided the commit.
   *
   * Together with readFilesAtCommit() this is how clients read committed code: a workpiece's
   * tree at its head or accepted commit (outside any chat, or when the open chat has no pin for
   * it), and the base content of a chat's pins (see ChatCodeBase), one file at a time as it is
   * opened or edited.
   */
  listTree(commitId: Awaitable<string>): Promise<TreeNode[]>;
  /**
   * Indicates that the user has requested that the chat's proposed changes be merged into the
   * mainline. Always merges *everything* the chat proposes -- changes not yet materialized into a
   * `changes` message are swept in first, and there is no way to accept only a subset.
   *
   * Accepting is only ever a fast-forward: every gadget touched by the merged changes must have
   * its chat pin's ChatGadgetPinState.mergedCommit equal to the gadget's current head commit.
   * If mainline has advanced past any pin, nothing at all is merged and the call returns a
   * "stale" outcome (an expected result, not an exception; see MergeChangesResult): call
   * updateChatFromMainline(), resolve any conflicts, and retry. Where the pin's `baseCommit` is
   * a merge commit not yet accepted, whose first parent is `mergedCommit`, the head moves
   * through it: to the merge commit itself if the chat changed nothing since, else to a new
   * commit on top of it.
   *
   * A chat has something to accept when it holds a pin, a gadget or binding edge pending in it,
   * or a blueprint proposal that is neither merged nor reverted. Otherwise this is a no-op and
   * records nothing.
   *
   * A successful merge closes the chat's current **epoch**: all merged content now lives in
   * commits, so the chat's code base resets to empty (every pin is dropped, the change stream
   * restarts at revision 0 under a new generation, and the merge message records
   * `epochBoundary`). Subsequent edits re-pin lazily against the new heads. The generation bump
   * is content-preserving: ChatCodeBase.prior describes the closed stream, and in-flight
   * submissions rooted in it are transformed onto the new generation rather than discarded (see
   * submitCodeChange()), so a client typing through someone's accept loses nothing.
   *
   * A blueprint release the chat proposes to merge into a gadget (see
   * AiChatMessageBody.blueprintMerges) is accepted with the rest: the gadget's new head gains
   * the release as a parent, unless its history already holds it, and the gadget follows that
   * blueprint from then on.
   *
   * Each file is taken as it stands, conflict markers included. A caller should first resolve
   * the conflicts that the chat's still-proposed `changes` messages list
   * (AiChatMessageBody.blueprintMerges[].conflictPaths and mainlineMerge.gadgets[].conflictPaths),
   * as the Workshop UI does before accepting: it looks for a `<<<<<<< ` or `>>>>>>> ` line left
   * in each of those files, and asks the user whether to accept them as they are.
   */
  mergeChanges(chatId: Awaitable<number>): Promise<MergeChangesResult>;
  /**
   * Create a new gatekeeper for an agent spawner binding. This allows the gadget to
   * programmatically spawn AI agents to complete tasks.
   */
  newAgentSpawnerGatekeeper(config: Awaitable<AgentSpawnerConfig>): Pipelined<GatekeeperClient>;
  /**
   * Create a new gatekeeper for an AI model binding. The model can be any returned by
   * `AuthenticatedApi.listModels()`. A language model's gatekeeper provides a
   * `LanguageModelBinding`, a decision model's a `DecisionModelBinding`.
   */
  newAiModelGatekeeper(modelId: Awaitable<string>): Pipelined<GatekeeperClient>;
  /**
   * Starts a new chat in this workspace with an initial message or slash-command request.
   * A slash command always creates a visible chat event, even when it does not produce a message
   * for the agent.
   * Slash-command requests cannot include capsules or attachments.
   *
   * `modelId` is one of the IDs in the result of `listModels()`, or null to inhibit AI response
   * (useful when using chat to talk between humans). Returns the new chat's id without waiting
   * for the agent's turn; `waitForAgent()` waits for it to end.
   *
   * `formats` records where the message names one of the deployment's standard output formats, so
   * the transcript can draw it as a chip. Display only -- what the agent reads is the noun, which
   * is already in the text.
   */
  newChat(initialMessage: Awaitable<SlashCommandRequest | string>, modelId: Awaitable<null | string>, capsules?: Awaitable<CapsuleSpecifier[]>, attachments?: Awaitable<ChatAttachmentHandle[]>, formats?: Awaitable<MessageFormatRef[]>): Promise<number>;
  /**
   * Try to create a new gatekeeper for this resource URL, such as a repository or MCP server.
   * The gatekeeper is a connection to that one resource of a connected account, such as a GitHub
   * repository or an MCP server's endpoint.
   *
   * `accountId` is the user's connected account to use to access this resource. To determine an
   * appropriate account, use `subscribeConnectedAccounts()` with a `filter` for this URL, then
   * let the user choose one.
   *
   * The new gatekeeper is a workspace-level workpiece; it is not bound into any gadget's `env` by
   * default. Use GadgetClient.bind() / bindWithSuggestedName() to expose it to a gadget, or pass
   * its id to acceptConnectionRequest() to hand it to the agent that asked for it.
   */
  newGatekeeper(accountId: Awaitable<number>, resourceUrl: Awaitable<string>): Promise<null | GatekeeperClient>;
  /**
   * Mint a fresh secret for an existing link so the user can copy a new URL without creating a
   * whole new link. The old secrets remain valid, and revoking the link revokes them all together.
   */
  newShareLinkKey(linkId: Awaitable<string>): Promise<{
    key: string;
  }>;
  /**
   * Preview what would happen if a collaborator were removed. For a non-owner caller,
   * if the target has edges from other sources that would survive, returns an empty array
   * (the target would not actually be affected). Otherwise, returns the list of users whose
   * access would change (lose access or be downgraded to a lower role) as a consequence, so the
   * caller can present checkboxes for which to keep vs. remove.
   */
  previewRemoveCollaborator(profileId: Awaitable<string>): Promise<AffectedCollaborator[]>;
  /**
   * Preview what would happen if a share link were revoked. Returns the list of users whose access
   * would change (lose access or be downgraded to a lower role) as a consequence, so the caller
   * can present checkboxes for which to keep vs. remove.
   */
  previewRevokeShareLink(linkId: Awaitable<string>): Promise<AffectedCollaborator[]>;
  /**
   * Read the content of the named files at a commit. Returns one `[path, FileAtCommit]` entry
   * per requested path, in request order (a list of pairs rather than a path-keyed object so
   * that file names like `__proto__`, which RPC deserialization drops from object keys, survive
   * in transit -- see CodeChange in `@gadgets/workshop-shared/code-change`). Blobs missing from
   * the workspace's git store are pulled in one batch through the gatekeeper that provided the
   * commit; a pull failure fails the whole call, since it is transient or actionable rather than
   * a fact about any one file, whereas per-file conditions -- absent path, symlink, submodule,
   * binary or oversized content -- are reported per entry (see FileAtCommit).
   *
   * At most MAX_READ_FILES_PER_CALL paths per call. The server stops decoding once the
   * accumulated text exceeds READ_FILES_RESPONSE_BUDGET and omits the remaining paths from the
   * result, so a missing entry means "not answered, ask again" -- never "absent", which is
   * always stated explicitly. Responses are cacheable by (commit ID, path).
   */
  readFilesAtCommit(commitId: Awaitable<string>, paths: Awaitable<string[]>): Promise<[string, FileAtCommit][]>;
  /**
   * Reject an action that is in the "pending" state. This notifies the gatekeeper that it will not
   * be approved in the future.
   */
  rejectAction(id: Awaitable<number>): Promise<void>;
  /**
   * Remove the auto-approval rule for `tag` on the given gatekeeper; matching actions then
   * require manual approval again.
   */
  removeAutoApprovedActionKind(gatekeeperId: Awaitable<number>, tag: Awaitable<string>): Promise<void>;
  /**
   * Stop sharing this workspace with a user (unshare it): remove a collaborator by profile.id.
   *
   * Owner can remove anyone. A non-owner collaborator can only remove their own edge(s)
   * from the target. If the target still has edges from other sources, they keep access
   * and the return is an empty array. If no edges remain, the target is fully removed.
   *
   * When a target is fully removed, `keepUsers` lists the profile.ids of users who would
   * lose access transitively but should be retained. Their PermissionEdges through the
   * removed user are replaced with new edges from the caller. Users reachable only through
   * the removed user who are NOT in `keepUsers` are also removed.
   *
   * Returns the list of users whose access actually changed (removed or downgraded), including
   * the primary target. An empty array means the caller's edge was removed but no one's effective
   * access changed (the target retained their role through other edges).
   */
  removeCollaborator(profileId: Awaitable<string>, keepUsers: Awaitable<string[]>): Promise<AffectedCollaborator[]>;
  /**
   * Retry the agent on the given chat. This starts the agent without adding a new user message.
   * The agent will re-process the existing chat history using the specified model.
   *
   * Throws if an agent is already running on the chat.
   */
  retryAgent(chatId: Awaitable<number>, modelId: Awaitable<string>): Promise<void>;
  /**
   * Retry publishing a blueprint whose `dirty` flag is set (meaning a previous propagation
   * to User DO / KV / R2 failed).
   */
  retryBlueprintPublish(blueprintId: Awaitable<string>): Promise<void>;
  /**
   * Indicates that the user has requested that proposed changes starting from the given sequence
   * number in the chat thread be reverted.
   *
   * Throws if the range covers a still-proposed mainline merge that records no `gadgets` (see
   * AiChatMessageBody.mainlineMerge for why such a message cannot be erased), or if the range
   * erases the chat's conversion boundary while keeping an earlier still-proposed batch (see
   * AiChatMessageBody.conversionBoundary; a revert covering everything, `revertFrom` 0, always
   * satisfies this).
   *
   * Each pin is settled from the log as it stands after the revert: its `baseCommit` is that of
   * its last surviving declaration, and a pin with none is removed from ChatCodeBase. Its
   * `mergedCommit` is put back to what the earliest update from mainline the revert covers
   * records it was before (MainlineMergeGadget.baseCommit), and is otherwise left alone.
   * Changes not yet materialized into a message are erased
   * along with the reverted range. Erasing already-applied changes invalidates every client's local
   * state -- content they may have transformed against is gone -- so ChatCodeBase.generation is
   * bumped destructively: in-flight submitCodeChange() calls fail and clients rebuild instead of
   * corrupting the chat.
   */
  revertChanges(chatId: Awaitable<number>, revertFrom: Awaitable<number>): Promise<void>;
  /**
   * Revoke a share link by its `linkId`, which revokes every secret ever minted for it. Users who
   * gained access through the link may be transitively removed or downgraded. `keepUsers` lists
   * profile.ids of users who should be retained at their prior role with fresh edges from the
   * caller. Returns the list of users whose access actually changed (removed or downgraded).
   */
  revokeShareLink(linkId: Awaitable<string>, keepUsers: Awaitable<string[]>): Promise<AffectedCollaborator[]>;
  /**
   * Send a message to the chat from this client. Sending a message causes the LLM to start
   * running if it isn't already.
   * While it runs, plain text with no capsules, attachments or formats steers it, on the running
   * turn's model whatever `modelId` is, even null: it waits in `AiChatMetadata.queuedSteers` until
   * the agent reads it. Anything else, or anything sent after `stopAgent()`, throws until the
   * agent finishes.
   * If a slash command produces no message, only its visible invocation event is committed and the
   * agent does not run.
   * Slash-command requests cannot include capsules or attachments.
   *
   * `modelId` is one of the IDs in the result of `listModels()`, or null to inhibit AI response
   * (useful when using chat to talk between humans). Returns without waiting for the agent's
   * turn; `waitForAgent()` waits for it to end.
   */
  sendChatMessage(chatId: Awaitable<number>, message: Awaitable<SlashCommandRequest | string>, modelId: Awaitable<null | string>, capsules?: Awaitable<CapsuleSpecifier[]>, attachments?: Awaitable<ChatAttachmentHandle[]>, formats?: Awaitable<MessageFormatRef[]>): Promise<void>;
  /**
   * Enable auto-approval of actions carrying the given `actionKind` (the
   * ActionDescription.actionKind) on the gatekeeper identified by `gatekeeperId`. Future actions
   * with that kind's tag whose author marked them `autoApprovable` are then applied automatically
   * without manual approval, and any matching action(s) already pending are applied immediately.
   *
   * Auto-approval rules are workspace-wide per gatekeeper: approving an action kind approves it
   * no matter which gadget invokes it.
   *
   * Once the workspace has read restricted data (`WorkspaceMetadata.containsRestrictedData`), rules
   * are stored but never fire: every action pends for manual approval.
   */
  setAutoApprovedActionKind(gatekeeperId: Awaitable<number>, actionKind: Awaitable<ActionKind>): Promise<void>;
  /**
   * Update the title of a chat. Usually not needed as a title is generated automatically from
   * the first message.
   */
  setChatTitle(chatId: Awaitable<number>, title: Awaitable<string>): Promise<void>;
  /** Rename the workspace: change its title. */
  setTitle(title: Awaitable<string>): Promise<void>;
  /**
   * Request that any ongoing LLM session in the given chat immediately stop.
   *
   * If an LLM is running, the session is canceled subscribers will receive a metadata update
   * reflecting this before `stop()` returns.
   *
   * If no LLM is running, `stop()` does nothing and returns immediately.
   *
   * Stopping drops the chat's queued steers (see `AiChatMetadata.queuedSteers`), whoever sent them.
   * The client that stops is expected to put them in its draft, so its user can still send them.
   */
  stopAgent(chatId: Awaitable<number>): Promise<void>;
  /**
   * Submit one code change on a chat's branch: how a client edits files.
   * This is the only way to edit code: committed code cannot be written directly -- gadget heads
   * only advance when a chat's changes are accepted (see mergeChanges()).
   *
   * `submission.change` is expressed against the chat's content as of
   * `(submission.generation, submission.revision)` -- that is, the submitter has applied every
   * accepted change of that generation's stream up to and including that revision (see
   * ChatCodeBase). The server transforms the change over any changes accepted since, validates it,
   * appends it to the stream, and broadcasts it (AiChatSubscriber.changeApplied()); the returned
   * `(generation, revision)` is where it landed.
   *
   * `submission.pins` must carry one declaration per *permanent* gadget the change touches that is
   * not yet pinned in the chat, each naming the head commit the client's content derives from.
   * The server checks that each declared base is the gadget's current head, or its first parent
   * (tolerating a race with one concurrent merge), and establishes the pin atomically with the
   * change. A declaration identical to the existing pin is accepted idempotently; one naming a
   * different `baseCommit` (a race between two first editors) throws. Exception: a gadget still
   * pending in this chat has no head commit to pin (see WorkpieceSummary.commitId), so its changes
   * carry no declaration and build its content up from nothing (see ChatCodeBase). A worktree
   * declaration is accepted iff its `baseCommit` is the worktree's accepted commit -- the
   * content as of the chat's last accept, the analog of a gadget's head -- exactly, with no
   * parent tolerance (only this chat's accept moves it, and that closes the generation).
   *
   * Retries: `submission.clientId` names the client's editing session and `submission.seq`
   * numbers its submissions from 1. The server remembers each session's last accepted seq and
   * where it landed -- independently of the changes themselves, so recognition survives
   * materialization, epoch resets, and destructive generation bumps -- and answers a retry of
   * that seq with the recorded result instead of applying it twice. A transport failure must
   * therefore be retried with the *same* seq and an identical payload, never renumbered or
   * re-composed (OT, unlike a CRDT, does not tolerate double-application); a same-seq
   * submission whose content differs is a client bug and is rejected. A seq one past the last
   * accepted (or 1 from a new session) is the next change; anything else is rejected -- discard
   * local edits and rebuild under a fresh clientId. Only the last submission is remembered, so
   * keep at most one in flight.
   *
   * While an agent turn is active, the call throws a retryable error: keep the queued change and
   * resubmit after the turn ends. (The UI already locks editing during turns; this backstops
   * races.)
   *
   * A submission still rooted in the *previous* generation, when that generation was closed by
   * a merge (a content-preserving bump; see ChatCodeBase.generation), is transformed across the
   * boundary and lands in the current generation, so typing straight through someone's accept
   * is seamless. Such a submission's pin declarations are ignored (they describe pre-merge
   * heads; the server derives the new pins itself), and it is rejected if it touches a gadget
   * in ChatCodeBase.prior.discontinuousGadgets (the merge visibly changed that gadget's
   * content) or a gadget that has since been re-pinned at a different base.
   *
   * Every other rejection means the client's local state is unusable: a generation ended by a
   * destructive bump (revert, draft discard, turn abort), a revision older than the server's
   * retained transform window, or an invalid change all mean the client must discard its local
   * edits and rebuild from fresh metadata.
   */
  submitCodeChange(chatId: Awaitable<number>, submission: Awaitable<CodeChangeSubmission>): Promise<{
    generation: number;
    revision: number;
  }>;
  /**
   * Subscribe to action adds/updates. Dispose the returned stub to unsubscribe.
   *
   * The subscription delivers live deltas only — nothing pre-existing is replayed. Query for
   * state, subscribe for deltas: fetch the current pending set via
   * listActions({filter: "pending"}) and resolved history via the other filters. As with
   * subscribeToChat(), initiate the subscribe call before those reads — there is no need to
   * await its return, only to start it first — so nothing can slip between the snapshot the
   * pages reflect and the stream.
   *
   * The `startAfter` parameter is intended to be used when resubscribing after a disconnect:
   * specify the time of the last action seen, in order to ensure no actions were missed during
   * the disconnect. The bound is inclusive -- records last changed at exactly that time are
   * re-delivered (entries are upserts) -- and the replay arrives in change-time order, not
   * creation order. If not specified, the subscription starts from the current time.
   *
   * Do NOT use `startAfter` as a way to enumerate historical data. Use `listActions()` instead.
   * To ensure no holes between a subscription and historical data, call `subscribeToActions()`
   * immediately before `listActions()`, similar to `subscribeToChat()`.
   */
  subscribeToActions(subscriber: ActionsSubscriber, startAfter?: Awaitable<Date>): Pipelined<Empty>;
  /**
   * Subscribe to all new chat messages (across all threads), the agent's replies among them.
   *
   * If `startAt` is given, it must be a date in the past. All messages starting from that date
   * will be sent upfront. This is intended to allow resubscribing after being disconnected. If
   * `startAt` is omitted, only new messages will be sent.
   *
   * Generally, a client should subscribe to chats immediately on loading the gadget editor. If
   * the client needs to call any methods like `listChats()` to backfill content, it should make
   * these calls after `subscribeToChat()`, so that there's no chance of missing a message. (It is
   * not necessary to wait for `subscribeToChat()` to return -- only to initiate the call before
   * other read calls.)
   */
  subscribeToChat(subscriber: AiChatSubscriber, startAfter?: Awaitable<Date>): Pipelined<Empty>;
  /**
   * Subscribe to the gadget worker's console logs. This allows the user to observe console logs
   * being produced by the gadget.
   *
   * At present, logs are not stored, so the only way to see them is to be subscribed when they
   * happen.
   *
   * To unsubscribe, dispose the returned stub.
   */
  subscribeToConsoleLogs(subscriber: ConsoleLogSubscriber): Pipelined<Empty>;
  /**
   * Get metadata describing this workspace and subscribe to changes.
   *
   * `callback` will be called once immediately with the current metadata, then again any time it
   * changes.
   *
   * Disposing the returned `RpcStub` will cancel the subscription.
   */
  subscribeToMetadata(callback: (metadata: WorkspaceMetadata) => Awaitable<void>): Pipelined<Empty>;
  /**
   * Watch who is viewing the workspace: receive the viewer roster, then updates as it changes.
   * The current roster comes first, then incremental updates as viewers come and go. A viewer is
   * present for the lifetime of the openWorkspace() session.
   */
  subscribeToPresence(subscriber: PresenceSubscriber): Pipelined<Empty>;
  /**
   * Subscribe to the workspace's workpiece list, which lists its gadgets, each by ID and title.
   *
   * The subscriber receives one entry() per existing workpiece, followed by ready(), then
   * incremental entry()/removed() calls as workpieces are created, renamed, or deleted, and
   * whenever a summary field changes (a gadget's head, a worktree's accepted or head commit).
   * Gadgets and worktrees are delivered (see WorkpieceSummary for which subscriptions see
   * worktrees).
   *
   * Disposing the returned `RpcStub` will cancel the subscription.
   */
  subscribeToWorkpieces(subscriber: WorkpiecesSubscriber): Pipelined<Empty>;
  /**
   * Update an existing blueprint. Any combination of metadata and code can be updated
   * atomically in a single call with one propagation pass.
   *
   * - `title` / `description`: if provided, update the respective field.
   * - `updateCode`: if true, release the source gadget's current committed code as the
   *   blueprint's next version. If that code is what the blueprint's latest version already
   *   holds, the version stays as it is.
   * - `updateBindings`: if true, refresh the blueprint's connection annotations from
   *   the source gadget's current bindings without changing the code snapshot.
   *
   * At least one option must be provided.
   */
  updateBlueprint(blueprintId: Awaitable<string>, options: Awaitable<{
    description?: string;
    screenshot?: null | BlueprintScreenshotUpload;
    title?: string;
    updateBindings?: boolean;
    updateCode?: boolean;
  }>): Promise<void>;
  /**
   * Merge mainline commits that landed after this chat's pins into the chat's uncommitted state.
   *
   * Only *pinned* gadgets participate: an unpinned gadget's code was never modified in this
   * chat, so it tracks mainline head live and there is nothing to merge into. For each pinned
   * gadget whose ChatGadgetPinState.mergedCommit is behind the gadget's current head, the server
   * computes a 3-way text merge (base = the last merged commit, ours = the head, theirs = the
   * chat's current files) and writes it as commits: the chat's files before the update, and the
   * merge commit, whose parents are the head and that (see MainlineMergeGadget). The chat's pin
   * for the gadget then re-roots at the merge commit (see ChatGadgetPinRecord), with the head as
   * its `mergedCommit`. A gadget whose files in the chat are already in the head's history had
   * nothing of its own to merge, and re-roots at the head itself. Conflicting hunks are left
   * inline as 3-way conflict markers (`<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`) for the user or
   * their agent to clean up; the affected paths, each qualified by its gadget's binding name
   * (`GADGET_NAME/path`), are returned in sorted order and also recorded on the message. An
   * empty `conflictPaths` means every file merged cleanly (or there was nothing to merge).
   *
   * The update is recorded as a `changes` message carrying `mainlineMerge` and declaring the
   * re-roots, with no `change`. It then ends the chat's change stream with a destructive bump
   * of ChatCodeBase.generation, delivered after the message: clients rebuild their content from
   * the log, re-rooted. Changes a client has submitted and not yet had acknowledged are lost.
   *
   * Throws, changing nothing, if both sides changed a file and a version of it, or the merged
   * text, is too large for a file to hold; the error names the file. Making it smaller on
   * either side, or undoing the chat's own changes to it, lets the update through.
   *
   * Once the chat is up to date (and mainline hasn't moved again), mergeChanges() succeeds as a
   * plain fast-forward through the merge commit. The update can be reverted like any other
   * proposed change, which puts the pins back as they were before it (see revertChanges()).
   */
  updateChatFromMainline(chatId: Awaitable<number>): Promise<{
    conflictPaths: string[];
  }>;
  /**
   * Update a share link's management metadata. The raw secrets are not available after creation;
   * this only edits the stored note used by the management UI.
   */
  updateShareLink(linkId: Awaitable<string>, note?: Awaitable<string>): Promise<void>;
  /**
   * Store raw bytes, such as a file to attach, as an immutable Git blob and return its OID. The OID
   * comes back after durable storage. Retrying identical bytes returns the same OID. This does not
   * change any worktree or message. Use the OID in a chat attachment, or in a worktree's whole-file
   * `setBytes` change together with the payload's byte length. The blob must be present in this
   * workspace's Git store. Limited to 8,000,000 bytes; larger-file support is deferred.
   */
  uploadBlob(content: Awaitable<Uint8Array>): Promise<string>;
  /**
   * Records that this client shows chat `chatId` until the returned handle is disposed. When a
   * turn finishes in a chat someone is viewing, the workspace resends that turn's last model
   * request just before the provider's cached copy of it would expire, so the user's next message
   * costs less and starts sooner. The resends are billed like the turn. They stop when the last
   * viewer leaves, at the chat's next turn, an hour after the turn, or before they would cost
   * more than the cache miss they avoid. Throws if the chat doesn't exist.
   */
  viewChat(chatId: Awaitable<number>): Pipelined<Empty>;
  /**
   * Wait for the agent's turn in a chat to end, and return the latest message the agent wrote in
   * it. This is the way to wait for the turn `newChat()`, `sendChatMessage()` or `retryAgent()`
   * starts: the message is then its reply, the error that ended it, or what it stopped to wait on.
   * Returns at once if no turn is running, and null if the agent has written nothing in the chat.
   * Control notes the chat does not show (`agentNudge`) are not messages the agent wrote.
   *
   * The wait ends when the chat's `AiChatMetadata.activeAgent` clears: the turn finished, failed
   * or was stopped, or paused for the user's decision on an action. A turn that hands straight on
   * to the next (to read the steers sent, or the calls made to the agent, while it ran) is waited
   * through; one that starts after the wait has ended is not. A `sendChatMessage()` or `retryAgent()` call this session made
   * before this one, pipelined rather than awaited, is waited for first, so the wait covers the
   * turn it starts. That holds only once the call is delivered: a call with a promise among its
   * arguments (an `uploadBlob()` result, say) is delivered when the promise resolves, which may
   * be after this one, so await such a call before waiting.
   *
   * `timeoutMs` bounds the wait: at most an hour, which is also the default, and 0 checks without
   * waiting. If it runs out with the agent still running, this throws an error whose code is
   * `WAIT_FOR_AGENT_ERROR_CODES.timedOut`. The wait is held in the workspace's memory, so if the
   * workspace restarts meanwhile the call fails as the connection does; the turn resumes by
   * itself, and a new connection can wait again. Requires the same access as `getChatHistory()`.
   */
  waitForAgent(chatId: Awaitable<number>, timeoutMs?: Awaitable<number>): Promise<null | AiChatMessage>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

/**
 * `init` delivers the full roster once on subscribe.
 * `add`/`remove` (keyed by `key`) report changes thereafter.
 */
export interface PresenceSubscriber {
  add(participant: PresenceParticipant): Awaitable<void>;
  init(participants: PresenceParticipant[]): Awaitable<void>;
  remove(key: string): Awaitable<void>;
}

/** Callback interface used to receive workpiece-list updates. See Overseer.subscribeToWorkpieces(). */
export interface WorkpiecesSubscriber {
  /**
   * Upsert: called once per existing workpiece when the subscription starts, then again whenever
   * a workpiece is created or its summary changes (e.g. it is renamed).
   */
  entry(summary: WorkpieceSummary): Awaitable<void>;
  /** Called after entry() has been called for all workpieces known so far. */
  ready(): Awaitable<void>;
  /** The workpiece was deleted. */
  removed(id: number): Awaitable<void>;
}

/** Describes a connected user account on an external service, for display purposes. */
export type AccountDescription = {
  /** User's avatar image. */
  avatar: AvatarImage;
  /** User's display name, e.g. "John Doe". This is a non-unique name that is human-readable. */
  displayName?: string;
  /**
   * `urlPattern`s of the grantable resource types (those with `grantable`; see
   * `SupportedResource`) currently enabled on this account. Used to show which resources are
   * usable and which need an additional grant. If omitted, treat the account as having every
   * resource granted (legacy accounts, or gatekeepers with no grantable resource types).
   */
  grantedResourceUrlPatterns?: string[];
  /**
   * If set, this account has a full-page management UI (see GatekeeperUser.startAppUi). The Workshop
   * surfaces it as a nav entry / page using this title.
   */
  providesUi?: {
    icon?: AvatarImage;
    title: string;
  };
  /**
   * If set, this account provides an agent singleton: a gatekeeper (see
   * GatekeeperUser.getSingletonGatekeeperClass) that the Workshop installs into the owner's gadgets
   * and whose session it auto-provides as an unnamed capsule. `tsType` names the session's interface
   * as returned by the gatekeeper's getTypeScriptTypes().
   */
  singleton?: {
    tsType: string;
  };
  /**
   * Unique, canonical name for this user account. Typically this is what the user would type into
   * the login form when logging in. This may an email address or a Unix-style username.
   */
  uniqueName?: string;
};

/**
 * Describes an action submitted to the action approval queue. This contains all the information
 * needed to:
 * - Decide whether the action needs to be approved and who can approve it.
 * - Display the action to the approver for review.
 * - Store the action in an audit log.
 */
export type ActionDescription = {
  /**
   * The action's kind (stable tag + display label), or absent for actions that can't be matched by
   * any tag-keyed rule -- those always require manual approval. `actionKind.tag` is what auto-
   * approval rules and the future policy engine key on; `actionKind.label` is shown in the UI.
   */
  actionKind?: ActionKind;
  /**
   * Author's verdict that this specific action is safe to auto-apply without human review, IF the
   * user has opted in to auto-approving this action's kind (see `actionKind`). Only the gatekeeper
   * author knows whether a given edit is benign vs. destructive, so this gate is set per-action.
   * Absent -> never auto-approvable, even if a matching rule exists.
   *
   * TODO: A single opaque boolean isn't the ideal long-term shape. Eventually the gatekeeper should
   * describe the *nature* of the action -- e.g. destructive vs. additive, reversible vs. not,
   * posting arbitrary content (possible data leak) vs. flipping a switch -- and let a security
   * policy decide whether auto-approval is allowed, rather than the gatekeeper author hard-coding
   * that judgement here.
   */
  autoApprovable?: boolean;
  /**
   * Hint that an agent should not keep working until this action has been approved or denied.
   *
   * Set this for actions whose effects the gatekeeper does NOT simulate. Because a not-yet-approved
   * action isn't reflected by later reads, an agent that keeps going would observe a world where
   * its action "didn't happen" — and tends to get confused: re-trying, second-guessing, or undoing
   * its own work. When this is set, the harness driving the agent should suspend the current turn
   * once the action is submitted and resume it after the user decides (or leave it ended on deny),
   * rather than letting the agent proceed against state the action hasn't been applied to.
   *
   * This is an advisory hint, not an enforcement mechanism: the action is still submitted and the
   * approval/security semantics are unchanged. Gatekeepers that fully simulate their actions (so
   * reads already reflect pending changes) should leave this unset, so the agent keeps working
   * seamlessly.
   */
  awaitDecision?: boolean;
  /**
   * A complete description of the action to be taken, in Markdown-formatted natural language.
   * This will be displayed to the approver. It must include all details that might be relevant to
   * consider before approving; see `descriptionIsComplete` for the standard this is held to.
   * Values the approver reviews are better carried in `fields`, leaving this the gatekeeper's own
   * prose.
   */
  description: string;
  /**
   * The gatekeeper's assertion that `description` and `fields` together reproduce, verbatim, every
   * piece of content originating in this workspace that applying the action will write or send:
   * bodies, field values, identifiers, serialized arguments. Bytes the gatekeeper re-sends
   * unchanged from the same provider may instead be named by size and digest, as a `file` field
   * with `origin: "provider"`. A provisional ID standing for something this workspace creates
   * counts as shown when the description says the gatekeeper sends the provider's ID in its place.
   * Absent means incomplete: a summary, a truncated field, or opaque bytes the approver cannot read
   * as text. A push (`pushedCommits`) is never complete. Approval surfaces tell the approver when
   * this is absent; an incomplete description is never refused for that reason.
   */
  descriptionIsComplete?: boolean;
  /**
   * The values the approver reviews, as typed data shown literally after `description`: never
   * rendered as Markdown, so a value needs no escaping to display as exactly itself.
   */
  fields?: ActionField[];
  /**
   * Does the Gatekeeper implement `revertAction()` for this action?
   *
   * It is recommended that all actions implement automatic revert. But, if an action is not able
   * to do so, it should at least use this flag to let the UI know not to offer the option to the
   * user.
   *
   * Note that this being true doesn't necessarily mean that reverting will always work. E.g. by
   * the time the user tries to revert, too many other changes may have been made, making it hard
   * to revert cleanly.
   */
  implementsRevert: boolean;
  /**
   * If present, applying this action will push the named commits to the remote resource this
   * gatekeeper fronts.
   *
   * At the time the action is submitted, the overseer may validate whether it makes sense to push
   * this commit (and the transitive closure of objects that come with it) to this gatekeeper, and
   * whether the gatekeeper is allowed to receive these commits. A variety of security policies,
   * possibly configured by the user or site administrator, may affect this decision. One common
   * policy is that a commit should not be pushed to a remote if its ancestors did not come from
   * that remote -- a policy which prevents accidentally pushing commits to the wrong repository,
   * possibly exposing confidential data. In any case, the Overseer typically applies such policies
   * at submit time (rather than apply time) and, if they indicate the action should not proceed,
   * will cause `submitAction()` to throw an exception.
   *
   * Even when the action is successfully submitted, the Gatekeeper is obliged -- as always -- not
   * to actually transmit any data until the action is approved and applied with `applyAction()`.
   * As always, though, the Gatekeeper is expected to simulate the effects of the action
   * immediately. E.g. if the agent queries the state of the remote repo, the Gatekeeper should
   * indicate that the push has completed.
   *
   * In order to assist in simulation, the `GitCache` passed to the Gatekeeper will always provide
   * access to all objects which are pending a push (part of a submitted but not-yet-applied
   * action). See `GitCache` for more info.
   */
  pushedCommits?: string[];
  /** Brief one-line summary of the action, like an email subject line, to display in a list. */
  title: string;
};

/**
 * One value an approver reviews, carried as data so surfaces show it literally. `label` is the
 * gatekeeper's own name for the value; everything else is the value as the action will send it.
 */
export type ActionField = {
  items: string[];
  kind: "list";
  /** The gatekeeper's name for the value, such as "Body" or "To". Plain text. */
  label: string;
  /**
   * Present when `value` or `items` is not the whole value: the UTF-8 bytes shown and the bytes
   * the whole value has. `shownBytes` of 0 means the field was omitted for lack of room.
   */
  truncated?: {
    shownBytes: number;
    totalBytes: number;
  };
} | {
  kind: "file";
  /** The gatekeeper's name for the value, such as "Body" or "To". Plain text. */
  label: string;
  mediaType: string;
  name: string;
  origin: "agent" | "provider";
  sha256?: string;
  size: number;
  /**
   * Present when `value` or `items` is not the whole value: the UTF-8 bytes shown and the bytes
   * the whole value has. `shownBytes` of 0 means the field was omitted for lack of room.
   */
  truncated?: {
    shownBytes: number;
    totalBytes: number;
  };
} | {
  kind: "inline";
  /** The gatekeeper's name for the value, such as "Body" or "To". Plain text. */
  label: string;
  /**
   * Present when `value` or `items` is not the whole value: the UTF-8 bytes shown and the bytes
   * the whole value has. `shownBytes` of 0 means the field was omitted for lack of room.
   */
  truncated?: {
    shownBytes: number;
    totalBytes: number;
  };
  value: string;
} | {
  kind: "json";
  /** The gatekeeper's name for the value, such as "Body" or "To". Plain text. */
  label: string;
  /**
   * Present when `value` or `items` is not the whole value: the UTF-8 bytes shown and the bytes
   * the whole value has. `shownBytes` of 0 means the field was omitted for lack of room.
   */
  truncated?: {
    shownBytes: number;
    totalBytes: number;
  };
  value: string;
} | {
  kind: "text";
  /** The gatekeeper's name for the value, such as "Body" or "To". Plain text. */
  label: string;
  syntax?: ActionFieldSyntax;
  /**
   * Present when `value` or `items` is not the whole value: the UTF-8 bytes shown and the bytes
   * the whole value has. `shownBytes` of 0 means the field was omitted for lack of room.
   */
  truncated?: {
    shownBytes: number;
    totalBytes: number;
  };
  value: string;
};

/** The language a `text` action field is written in, named so the approver knows how it is read. */
export type ActionFieldSyntax = "html" | "markdown" | "sql";

/**
 * Filter for listActions(): "all" for every record, one specific record type, or "pending" for
 * only the currently-pending records (of any type). Pending records appear in the type views and
 * "all" too, so history shows everything the agent has attempted.
 */
export type ActionHistoryFilter = "action" | "all" | "bindHook" | "observation" | "pending";

/** One page of action history from listActions(). */
export type ActionHistoryPage = {
  /** Matching records, descending id (creation order, newest first). */
  entries: ActionLogEntry[];
  /**
   * Id of the last returned entry; pass as `beforeId` for the next-older page. Absent when the
   * page reached the start of the history.
   */
  nextBeforeId?: number;
};

/**
 * A stable, machine-readable tag for an action paired with its human-readable display name; the two
 * always travel together. Policy decisions key on `tag` (auto-approval rules group on it today, and
 * the future policy / danger-level engine will too -- treat it as a stable enum; multiple action
 * kinds MAY share a tag to be governed as one group). `label` is shown in the auto-approval UI in
 * place of the raw tag, which is not meant for display.
 */
export type ActionKind = {
  label: string;
  tag: string;
};

/**
 * One entry in a workspace's action log, discriminated by `type`: an action a gadget asked a
 * gatekeeper to take, an observation it made, or a hook it bound.
 */
export type ActionLogEntry = {
  appliedAt?: Date;
  /**
   * True when the action was applied automatically by an auto-approval rule rather than by a human
   * clicking Approve. Only ever set alongside state "approved" (there is no automatic rejection).
   */
  autoApproved?: boolean;
  createdAt: Date;
  /**
   * True for the creation queued by createExternalResource. Approving it requires one of the
   * approver's accounts for the gatekeeper's vendor (see GatekeeperClient.getCreationSpec()), in
   * which the resource is created.
   */
  creation?: true;
  description: ActionDescription;
  /**
   * Which gatekeeper produced this action? Omitted if the log entry came from a non-gatekeeper
   * source (e.g. webFetch tool).
   */
  gatekeeperId?: number;
  /** Sequential ID number for the action. Counts up from when the workspace was created. */
  id: number;
  /**
   * Who resolved the action (approved or rejected it). Set when the action leaves "pending"; absent
   * while still pending (or for legacy actions resolved before this was tracked). For an
   * auto-approved action this is the user who enabled the rule -- auto-approvals run under their
   * authority (see `autoApproved`).
   */
  resolvedBy?: AiChatAuthorInfo;
  resourceTitle: string;
  resourceUrl?: string;
  state: ActionState;
  type: "action";
} | {
  appliedAt?: Date;
  createdAt: Date;
  description: HookDescription;
  /** Is the hook currently enabled? */
  enabled: boolean;
  /**
   * Which gatekeeper produced this action? Omitted if the log entry came from a non-gatekeeper
   * source (e.g. webFetch tool).
   */
  gatekeeperId?: number;
  /** Hook that was created by this action. `undefined` if it was later deleted. */
  hookId?: number;
  /** Sequential ID number for the action. Counts up from when the workspace was created. */
  id: number;
  resourceTitle: string;
  resourceUrl?: string;
  state: ActionState;
  type: "bindHook";
} | {
  appliedAt?: Date;
  createdAt: Date;
  description: ObservationDescription;
  /**
   * Which gatekeeper produced this action? Omitted if the log entry came from a non-gatekeeper
   * source (e.g. webFetch tool).
   */
  gatekeeperId?: number;
  /** Sequential ID number for the action. Counts up from when the workspace was created. */
  id: number;
  resourceTitle: string;
  resourceUrl?: string;
  state: ActionState;
  type: "observation";
};

/**
 * Specifies the state of an action in the action log:
 * * pending: Action has not been applied yet. It is waiting for approval.
 * * approved: Action was approved and applied.
 * * rejected: Action was rejected by the user.
 */
export type ActionState = "approved" | "pending" | "rejected";

/**
 * One promoted blueprint, as the admin Formats panel sees it: the deployment's curation plus
 * enough of the blueprint to show what is being curated.
 */
export type AdminFormat = {
  /** One line telling the agent when to prefer this format. */
  agentHint: string;
  /**
   * The blueprint's own description, which is the rest of the catalog entry the agent reads;
   * `agentHint` is only its last line.
   */
  blueprintDescription: string;
  blueprintId: string;
  blueprintTitle: string;
  /**
   * The blueprint ships with the deployment (see packages/bundled-blueprints and the
   * BUNDLED_BLUEPRINTS the backend's build generates from it), so an upgrade can replace its contents. Curation stays the admin's: an upgrade never re-promotes something they
   * removed, nor resets their overrides.
   */
  bundled: boolean;
  /** What the blueprint itself declares, so the panel can show which fields are overridden. */
  declared?: BlueprintOutput;
  enabled: boolean;
  /**
   * The promoted blueprint no longer exists (deleted after promotion). Such an entry is skipped
   * everywhere else; the panel surfaces it so the admin can remove it.
   */
  missing: boolean;
  /** Presentation after the deployment's overrides are applied. */
  output?: BlueprintOutput;
  /** The deployment's presentation overrides, if any. */
  overrides?: {
    icon?: "appWindow" | "chartBar" | "fileText" | "flowArrow" | "gridNine" | "kanban" | "listChecks" | "notebook" | "presentation" | "table";
    /**
     * Stable grouping slug, e.g. "document". Outputs sharing an id are grouped together on the
     * outputs page.
     */
    id?: string;
    noun?: string;
    plural?: string;
  };
};

/** A partial edit to one promoted format. Absent fields are left alone. */
export type AdminFormatPatch = {
  agentHint?: string;
  enabled?: boolean;
  /**
   * Per-field presentation overrides. A field set to null reverts to the blueprint's declaration;
   * a field left absent is unchanged.
   */
  overrides?: {
    icon?: "appWindow" | "chartBar" | "fileText" | "flowArrow" | "gridNine" | "kanban" | "listChecks" | "notebook" | "presentation" | "table" | null;
    /**
     * Stable grouping slug, e.g. "document". Outputs sharing an id are grouped together on the
     * outputs page.
     */
    id?: null | string;
    noun?: null | string;
    plural?: null | string;
  };
};

/** One of the providers AI Gateway serves, as a deployment's admin sees it. */
export type AdminGatewayProvider = {
  /**
   * Who enabled the provider: the CF_AI_GATEWAY_PROVIDERS environment variable, or an admin (see
   * AdminApi.setGatewayProviderEnabled). Absent while the provider is off.
   */
  enabledBy?: "admin" | "environment";
  /**
   * Whether the provider's requests need CF_AI_GATEWAY_API_TOKEN on a deployment that has none,
   * so that they fail until it is set. It says nothing of the provider keys the gateway holds,
   * which the Workshop can't see (see AdminApi.testGatewayProvider).
   */
  needsApiToken: boolean;
  /** The provider. */
  provider: AiModelProvider;
};

/** An AdminModel with what the admin UI needs in order to offer its settings. */
export type AdminModelView = {
  /** Whether the admin added the model, rather than SUGGESTED_MODELS listing it. */
  added: boolean;
  /**
   * The ID of a model of the same provider that the model runtime knows. While the runtime has
   * no entry for this model's own ID, the model borrows that one's runtime flags: its request
   * formats and, for what `capabilities` leaves unstated, its reasoning levels and the kinds of
   * input it takes. Its name, limits and cost stay its own.
   */
  behavesLike?: string;
  /**
   * For a model with a `behavesLike`, whether the model runtime knows the model it names. When
   * it does not, there is nothing to borrow, and the model runs as one the runtime does not know
   * for as long as it has no entry for the model's own ID either.
   */
  behavesLikeKnown?: boolean;
  /** The compaction budget the model has while GatewayModelSettings sets none. */
  builtInCompactionInputBudget: number;
  /**
   * What the model is asked for while neither its settings nor the deployment's default give it
   * a reasoning level.
   */
  builtInReasoning: BuiltInReasoning;
  /**
   * What the model is stated to do. Used only while the runtime has no entry for this model's
   * own ID, where each stated fact comes ahead of what `behavesLike` lends.
   */
  capabilities?: GatewayModelCapabilities;
  /** The maximum tokens one request may total. */
  contextWindow: number;
  /**
   * The mode the model has while the admin leaves it alone: SUGGESTED_MODELS decides it for a
   * suggested model, and an added model's is 'enabled'.
   */
  defaultMode: "disabled" | "enabled" | "hidden";
  /**
   * Name of the model as specified to the provider's API, which is also the ID chats and
   * preferences refer to it by.
   */
  id: string;
  /**
   * The largest compaction budget the model may be given: the room its context window leaves for
   * a prompt.
   */
  maxCompactionInputBudget: number;
  /** How the deployment offers the model. */
  mode: "disabled" | "enabled" | "hidden";
  /** Display name. */
  name: string;
  /** When present, both the requested response cap and the space reserved for it. */
  outputLimit?: number;
  /** Which AI provider hosts the model. */
  provider: AiModelProvider;
  /** The reasoning levels the model can be sent, least to most. Empty when it takes none. */
  reasoningLevels: ("high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh")[];
  /**
   * Whether the model runtime has an entry for the model's own ID. When it has, the runtime's
   * entry is used, and neither `behavesLike` nor `capabilities` is.
   */
  runtimeKnown: boolean;
  /** What the admin set for the model. Absent while nothing is set. */
  settings?: GatewayModelSettings;
};

/** A single gatekeeper resource type in the admin resource-config UI. */
export type AdminResource = {
  description: string;
  /** Whether this resource is currently enabled (not in the admin disabled set). */
  enabled: boolean;
  icon?: AvatarImage;
  title: string;
  /** The resource's urlPattern, used as its stable identifier. */
  urlPattern: string;
};

/**
 * A bound gatekeeper in the admin gatekeeper-config UI, discriminated by `autoProvisions`:
 *   - an ordinary OAuth/resource gatekeeper has a binary `enabled` flag and `resources` to toggle;
 *   - an auto-provisioning ("ambient") gatekeeper has a three-state `ambientMode` and no resources.
 */
export type AdminResourceVendor = {
  ambientMode: "disabled" | "enabled" | "optional";
  autoProvisions: true;
  displayName: string;
  logo?: AvatarImage;
  vendorId: string;
} | {
  autoProvisions: false;
  displayName: string;
  enabled: boolean;
  logo?: AvatarImage;
  resources: AdminResource[];
  vendorId: string;
};

/** All admin-managed deployment settings, returned by AdminApi.getSettings() for the admin UI. */
export type AdminSettingsView = {
  /** Accent color hex, or "" for the default theme. */
  accentColor: string;
  /** Top-bar notice text ("" when unset). */
  announcement: string;
  /** Full-width banner (text + accent color). */
  banner: BannerConfig;
  /** The blueprints promoted as standard output formats, in menu order (including disabled ones). */
  formats: AdminFormat[];
  /** The models the deployment provides through AI Gateway. Absent outside AI Gateway mode. */
  gatewayModels?: {
    /**
     * The reasoning level of each gateway model that has none of its own (see
     * AdminApi.setDefaultReasoning), or null while the deployment sets none.
     */
    defaultReasoning: "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh" | null;
    /** Every gateway model, in any mode, in listing order. */
    models: AdminModelView[];
    /**
     * Whether the admin UI may suggest models from models.dev while an admin adds one (see
     * AdminApi.setModelsDevSuggestions).
     */
    modelsDevSuggestions: boolean;
    /** Every provider the gateway serves, on or off, in the order the models are listed in. */
    providerSettings: AdminGatewayProvider[];
    /** The providers a model may be added under: the ones the gateway both enables and serves. */
    providers: AiModelProvider[];
    /** Whether users may add models of their own (see AdminApi.setUserModelsEnabled). */
    userModelsEnabled: boolean;
  };
  /** Agent system-prompt instructions ("" when unset). */
  instanceInstructions: string;
  /** Every bound gatekeeper and its resource types, with enabled state (not hidden when disabled). */
  resourceVendors: AdminResourceVendor[];
  /** Whether new account signups are allowed. */
  signupsEnabled: boolean;
  /** Custom deployment logo, or undefined to use the default Cloudflare OS mark. */
  siteLogo?: AvatarImage;
  /** Site name shown next to the top-bar logo ("" falls back to DEFAULT_SITE_NAME). */
  siteName: string;
  /** Whether users may search the user directory to find collaborators. */
  userSearchEnabled: boolean;
};

/**
 * Describes a collaborator whose access would change (or did change) as a result of a removal or
 * share key revocation. Used by the preview/confirm flow, which must surface not only users who
 * lose access entirely but also users who would be downgraded to a lower role.
 */
export type AffectedCollaborator = {
  addedBy: PermissionEdge[];
  /** The effective role after the change, or null if the user loses access entirely. */
  newRole: null | CollaboratorRole;
  /** The effective role before the change. */
  oldRole: CollaboratorRole;
  profile: AiChatAuthorInfo;
};

/** The discovery metadata returned for one gatekeeper session. */
export type AgentCatalog = {
  /**
   * The discoverable items, in the gatekeeper's priority order: the Workshop clamps the list by
   * dropping from the tail, so entries that must survive belong first.
   */
  entries: AgentCatalogEntry[];
  /** True if entries were dropped to fit the caps, so the agent knows the list is partial. */
  truncated?: boolean;
};

/** One discoverable item within a gatekeeper's session. */
export type AgentCatalogEntry = {
  /** One-line description of what the item is, to help the agent decide if it's relevant. */
  description: string;
  /** Opaque, gatekeeper-defined identifier the agent passes back to the session to act on this item. */
  id: string;
  /** Short human/agent-readable label (e.g. a collection name). */
  title: string;
};

/**
 * Configuration for an AI spawner binding. This binding allows the gadget to programmatically
 * create new agents, that is, start new agent chat threads, which appear in the gadget's agent
 * chat UI as new conversations. Agents created this way don't typically edit the gadget code, but
 * rather use the `executeCode` tool to directly invoke the gadget's bindings to perform tasks.
 * Beyond the bindings configured here, a gadget hands an agent per-task capabilities -- RPC stubs
 * representing specific resources or callbacks relevant to that agent session -- as the arguments
 * of calls made on the stub that the binding's `spawnCallable()` returns.
 *
 * For example, a gadget that responds to emails might invoke an agent for each email message that
 * arrives, with an RPC stub that allows it to reply to that email -- but prohibits the agent from
 * seeing or replying to any other email, to guard against prompt injection or information leakage
 * between email threads.
 */
export type AgentSpawnerConfig = {
  /** Display name for the binding, shown in the binding list. */
  displayName: string;
  /**
   * The bindings available to agents spawned by this spawner: binding name (as it appears as
   * `env.NAME` in the spawned agent's executeCode environment) -> target workpiece. This is the
   * spawner's initial set: afterwards the chat agent may add more with `setGadgetBinding`, each
   * a proposal that takes effect once the user accepts the chat's changes. When an agent is
   * spawned, the spawner's bindings are snapshotted into the spawned chat's seed binding layer
   * (entries whose targets no longer exist are dropped); the spawned agent sees only these
   * bindings, never the workspace's default binding list.
   *
   * The entries are deliberately not limited to bindings held by the gadget that owns the
   * spawner: a spawner may define bindings of its own, with its own names and targets.
   *
   * Once a gadget binds the spawner, every binding target joins each "use" collaborator's
   * verification scope transitively: spawning is reachable from the gadget UI, and the spawned
   * agent reads these bindings with the spawner creator's authority.
   */
  env: {
    [key: string]: number;
  };
  /**
   * Model ID to run, of the gadget owner's available models. Can be `null` to just create a chat
   * that doesn't actually run an agent -- the prompt, or the calls made on a callable agent, are
   * appended to the chat for a human to pick up.
   */
  modelId: null | string;
};

/** Who wrote a chat message, or is responding to a chat: a user, an agent's model, or a gadget. */
export type AiChatAuthorInfo = {
  /**
   * The user's preferred email address for git commits they author, set via
   * `AuthenticatedApi.setOwnCommitEmail()`. When absent, commits derive an address from `id`.
   * Self-asserted and unverified: it is attribution only and must never be read as identity.
   */
  commitEmail?: string;
  /** Unique user identifier, e.g. "kenton@cloudflare.com" or "gpt-5.1-pro". */
  id: string;
  /** Display name for author, e.g. "Kenton Varda" or "GPT" */
  name: string;
  /**
   * Is the author a human, AI, or Gadget?
   *
   * "gadget" means this is a prompt sent to an agent spawner -- i.e. a gadget spawned an
   * agent programmatically. In this case `id` is the gadget's owner's ID (for accounting purposes)
   * and `name` is the gadget title.
   */
  type: "agent" | "gadget" | "user";
};

/**
 * One page of a chat's history, bounded below by a compaction checkpoint. Compaction doesn't delete
 * messages, so a long thread is read one checkpoint-delimited page at a time.
 */
export type AiChatHistoryPage = {
  /** The checkpoint bounding this page below, absent once the page reaches the thread's start. */
  compacted?: {
    /**
     * Changes still proposed before `to`, composed into one code change, so the client can show
     * pending changes without loading the messages that recorded them. Composes over the base
     * trees of the pins the compacted messages established (which remain in ChatCodeBase.pins),
     * before any later messages' changes.
     */
    proposedChange?: CodeChange;
    /**
     * Summary that replaces the messages before `to` in subsequent model prompts, exposed so the
     * user can inspect the context kept across the boundary.
     */
    summary: string;
    /** First sequence in this page. Pass as `getChatHistory`'s `beforeSequence` for the page before. */
    to: number;
  };
  /** The page's messages, ascending by sequence. */
  messages: AiChatMessage[];
};

/** One message in a chat: where it is in the chat, when and by whom it was written, and its body. */
export type AiChatMessage = {
  actionId: number;
  /**
   * Denormalized description of the action.
   *
   * This is inlined into the message at the time of query, so it is always present and always
   * current in messages delivered to the client. It is marked optional only because it is not
   * present in messages stored in the chat table on the server side.
   */
  actionLog?: ActionLogEntry;
  author: AiChatAuthorInfo;
  chatId: number;
  sequence: number;
  timestamp: Date;
  /** Indicates that the agent in this chat performed an action. */
  type: "action";
} | {
  /**
   * Binding edges added to gadgets as part of this batch of changes (by the agent's
   * setGadgetBinding tool, or by the user binding a connection with a chat open -- in the latter
   * case `change` is omitted). Like `createdGadgets`, the additions are
   * provisional: the edge is visible only from this chat until a merge through this message
   * makes it permanent, and a revert covering it deletes the edge. `name` is the binding's name
   * within the gadget (or agent spawner) identified by `gadgetId`; `target` is the bound
   * workpiece.
   */
  addedBindings?: {
    gadgetId: number;
    name: string;
    target: number;
  }[];
  author: AiChatAuthorInfo;
  /**
   * Blueprint releases this batch proposes to merge into gadgets: recorded by
   * GadgetClient.applyBlueprint(), and by the agent's `createGadget` tool when it builds the new
   * gadget from a blueprint.
   *
   * A proposal that GadgetClient.applyBlueprint() records is one message with no `change`. Its
   * merge was written as a commit, whose parents are the gadget's head and the release, and
   * which marks the release as merged. The batch's `pins` re-root the gadget at that commit,
   * with the head as the declaration's `mergedCommit` (see ChatGadgetPinRecord). The agent's
   * `createGadget` instead delivers the release's files as the batch's `change`, since a gadget
   * still pending in the chat has no head to commit on.
   *
   * Like the rest of the batch this is provisional. A merge through this message makes each
   * gadget follow the blueprint named (see GadgetUpstream) and records the release in the
   * gadget's history; a revert covering it withdraws the proposal, and until one or the other
   * the gadget is as it was.
   *
   * A proposal whose release is already in the gadget's history writes no commit and pins
   * nothing, so it does not put its gadget in AiChatMetadata.proposedChangeWorkpieces: this
   * record is then the only sign that the chat has something to accept.
   */
  blueprintMerges?: BlueprintMerge[];
  /**
   * The code changes themselves, composed from the changes this batch materialized (see
   * `watermark`). Applies to the chat content produced by the current epoch's earlier messages,
   * with this message's own `pins` established first (see ChatGadgetPin). Absent when the
   * batch records only gadget creations and/or binding additions with no accompanying code
   * edits, and on pre-conversion messages (see `conversionBoundary`).
   */
  change?: CodeChange;
  chatId: number;
  /**
   * Present on the synthetic message that converted this chat from the pre-git-storage
   * representation: its `change` collapses every uncommitted edit the chat had at migration time
   * into one diff against the chat's pinned commits. It acts as an epoch boundary: messages
   * before it are text-only history whose code payloads are no longer available. Present even
   * when the chat had nothing to convert (then with no `change` and no `pins`), because
   * ChatCodeBase.epoch needs a message to point at. The conversion change is all-or-nothing:
   * Overseer.revertChanges() refuses a range that erases this message while keeping any earlier
   * still-proposed batch (those batches' content was collapsed into this one and cannot survive
   * it), so the boundary and the pre-migration batches it collapsed are only ever discarded
   * together. Clients never display this message: the user took no action, and the migration it
   * records is not theirs to action.
   */
  conversionBoundary?: true;
  /**
   * Gadgets created as part of this batch of changes (by the agent's `createGadget` tool, or by
   * the user via Overseer.createGadget() with a chat open -- in the latter case `change` is
   * omitted). Like the code changes themselves, the creations are provisional: a merge
   * through this message makes them permanent, and a revert covering it deletes them. Titles are
   * denormalized for display, since a reverted creation's registry record is gone. `bindingName`
   * is the name under which the gadget appears in the creating chat's env (and, once merged, the
   * workspace default binding list); recording it here lets the creating chat pick the name back
   * up on replay.
   */
  createdGadgets?: {
    bindingName: string;
    gadgetId: number;
    title: string;
  }[];
  /**
   * Worktrees created as part of this batch of changes (by the agent's `createWorktree` tool).
   * Deliberately separate from `createdGadgets` so a client can never mistake a worktree for a
   * gadget creation. Unlike a gadget creation, a worktree creation is not a proposed change (see
   * AiChatMetadata.proposedChangeWorkpieces), so it is not provisional either: recording this
   * message makes each worktree permanent (though private to this chat for life), nothing needs
   * accepting until the worktree is first modified, and a revert covering this message rolls
   * back the worktree's content and head but never deletes it. A creation pins nothing: like a
   * gadget, a worktree joins `pins` when it is first modified (see ChatGadgetPin). Batches
   * written before that was so carry the worktree's birth pin `{gadgetId: worktreeId,
   * baseCommit}` alongside the creation, which readers honor as an ordinary pin. `bindingName`
   * is the name in the creating chat's env, recorded so replay can pick it back up. The worktree
   * itself reaches the client as a WorktreeSummary on the workpiece subscription, and its
   * content rides `change` and `pins` like a gadget's.
   */
  createdWorktrees?: {
    bindingName: string;
    title: string;
    worktreeId: number;
  }[];
  /**
   * Present when this batch was produced by Overseer.updateChatFromMainline(). `conflictPaths`
   * lists the files whose 3-way merge was not clean, in sorted order, each qualified by its
   * gadget's binding name (`GADGET_NAME/path/to/file`); their merged contents carry inline
   * conflict markers (or, for delete-vs-modify, the surviving side's content) for the user or
   * their agent to resolve.
   *
   * `gadgets` records each gadget's part of the merge, whose result is a commit: the batch has
   * no `change`, and its `pins` re-root each gadget merged at that commit, with the head merged
   * as the declaration's `mergedCommit` (see ChatGadgetPinRecord). Each entry also records what
   * the pin's `mergedCommit` was before the update, which a revert covering this message puts
   * back (see Overseer.revertChanges()).
   *
   * A batch without `gadgets` was recorded before merges were commits. Its `change` merged
   * mainline commits into the chat, or is absent when the chat's content already matched them,
   * and it advanced the chat's pins with no record of their earlier values, so it cannot be
   * reverted while still proposed (Overseer.revertChanges() refuses). Erasing its content while
   * keeping the advanced pins would let a later accept silently overwrite the mainline changes
   * it delivered.
   */
  mainlineMerge?: {
    conflictPaths: string[];
    gadgets?: MainlineMergeGadget[];
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the message's
   * changes were built against. It survives only as stored data on old messages and drives
   * nothing.
   */
  observedCodeVersion?: number;
  /**
   * Pins this batch declares. For each gadget listed, the chat's content restarts at the pinned
   * commit's tree, dropping whatever earlier messages of the epoch changed in it (see
   * ChatGadgetPinRecord), and this message's `change` applies on top. Usually the declaration
   * accompanies the epoch's first modification of the gadget's code.
   */
  pins?: ChatGadgetPinRecord[];
  sequence: number;
  timestamp: Date;
  /**
   * Represents changes made to the code by an agent tool call or by a collaborating user as part
   * of a chat. These changes are provisional until they are accepted.
   */
  type: "changes";
  /**
   * The span of the change stream this batch materialized: this message's `change` is the
   * composition of generation `changesGeneration`'s changes from just past the previous
   * materialization's watermark through `throughRevision`. On receiving the message, clients drop
   * their local copies of the covered changes -- and a client that already applied them must not
   * apply `change` on top: the message re-records content those changes already delivered, it does
   * not add to it. The generation is included because revisions restart per generation; a delayed
   * message must never clear another generation's changes. Absent when the batch materialized no
   * changes (e.g. it records only creations/bindings), and on pre-conversion messages.
   */
  watermark?: {
    changesGeneration: number;
    throughRevision: number;
  };
  /**
   * Explicit worktree commits made as part of this batch: the agent's `commit()` calls on the
   * Worktree binding, each advancing the worktree's head from `previousHead` to `commit` (the
   * new head; also the call's return value). This is the durable, sequence-bearing record of the
   * advancement: the worktree registry record's head is updated in the same synchronous step
   * this message is written, and a revert covering this message rolls each affected worktree's
   * head back to its earliest reverted entry's `previousHead` (entries are ordered within the
   * message and messages by sequence, so multiple commits per step or per reverted range
   * compose). The commit objects themselves always remain -- content-addressed, and merely
   * dangling after a rollback -- so a queued push naming a rolled-back commit stays valid.
   */
  worktreeCommits?: {
    commit: string;
    previousHead: string;
    worktreeId: number;
  }[];
} | {
  /** A depth-limited summary string of the arguments for the agent's context window. */
  argsSummary: string;
  author: AiChatAuthorInfo;
  /**
   * Name under which the arguments appear in the agent's `env`. Absent on messages from before
   * callable agents became durable, whose arguments are no longer available.
   */
  bindingName?: string;
  chatId: number;
  /** The method name that was called. */
  methodName: string;
  sequence: number;
  timestamp: Date;
  /**
   * Indicates that a call was delivered to the agent: a method was called on its `self` object
   * (which code run by the agent's `executeCode` tool receives, and may pass along or store) or on
   * the stub an agent spawner's `spawnCallable()` returned. The call activates the agent to
   * respond; nothing is returned to the caller.
   */
  type: "agentCallback";
} | {
  /** Attachments that were sent with this message. Actual bytes stored separately. */
  attachments?: ChatAttachmentRef[];
  author: AiChatAuthorInfo;
  /**
   * The message may contain "capsules", which are embedded capabilities that reference external
   * resources. See `CapsuleSpecifier` for more.
   */
  capsules?: CapsuleSpecifier[];
  chatId: number;
  /**
   * Standard output formats the message names, e.g. "create a Doc for homework and Slides for the
   * presentation". See `MessageFormatRef`.
   */
  formats?: MessageFormatRef[];
  /**
   * Sequence of the visible slash-command event that generated this agent-visible message.
   * Clients use this to group the two records for display.
   */
  generatedBySlashCommandSequence?: number;
  message: string;
  /**
   * If the AI produces any thinking/reasoning text, this is it. This should be hidden by default
   * but the user should have the option to expand it.
   */
  reasoning?: string;
  sequence: number;
  /**
   * Sent while the agent was working, so it steers that turn rather than prompting one. The agent
   * reads it before its next model request, or, if the turn ended before it could and started no
   * other (it failed, or stopped to wait on the user's decision), when the agent next runs.
   */
  steered?: true;
  timestamp: Date;
  /** Messages from an AI agent can invoke tools. */
  toolCalls?: AiToolCall[];
  /** A regular chat message. */
  type: "message";
} | {
  author: AiChatAuthorInfo;
  /**
   * The name under which the resource will appear in the chat's env (`env.NAME` in executeCode)
   * once the request is accepted. Supplied by the agent as a required parameter of the
   * requestConnection tool -- the agent knows why it is requesting the resource, so it picks the
   * name itself -- and recorded here at request time. The name is claimed in the chat's scope
   * from that moment until the request is denied. Optional only because messages persisted
   * before named chat bindings existed lack it; those are named and stamped lazily at the
   * turn-start naming chokepoint.
   */
  bindingName?: string;
  chatId: number;
  /**
   * Once accepted, the id of the created gatekeeper. The resource is surfaced to the agent as a
   * named binding in the chat's env; the agent can additionally bind it into a gadget via
   * setGadgetBinding if its gadget code needs it.
   */
  gatekeeperId?: number;
  /** Why the agent wants this connection. Shown to the user to inform their decision. */
  reason: string;
  /** Unique id used by acceptConnectionRequest()/denyConnectionRequest(). */
  requestId: string;
  /**
   * Denormalized human-readable resource type/scope being requested (e.g. "Home Assistant
   * Instance", "Gmail Mailbox"), resolved from the vendor's supported resources at request time.
   */
  resourceTitle?: string;
  /**
   * A fully- or partially-specified resource URL, if the agent could infer one. When absent (or
   * incomplete) the accept flow opens the vendor's resource configurator to fill in the gaps.
   */
  resourceUrl?: string;
  /**
   * The urlPattern of the supported resource this request resolved to at request time (one of the
   * vendor's SupportedResource.urlPattern values, e.g. "https://github.com/:owner/:repo" or the
   * whole-instance "https://*"). The backend guarantees every connection request for a vendor
   * resolves to a concrete resource (see resolveRequestedResource), and the accept modal
   * pre-selects exactly this resource — so accepting never opens a blank "create new connection"
   * picker. Absent for an agent spawner, which has no resources: accepting opens its form.
   */
  resourceUrlPattern?: string;
  sequence: number;
  /** Lifecycle state. Starts "pending"; set by the user's accept/deny. */
  state: "accepted" | "denied" | "pending";
  timestamp: Date;
  /**
   * The agent requested that the user connect a gatekeeper (e.g. "I need ClickHouse cluster X").
   * Rendered inline in the chat as an accept/deny card. State is mutated in-place when the user
   * accepts or denies; the message is re-delivered to subscribers so the card updates. On accept the
   * agent is resumed with the outcome (see the history builder in agent.ts); on deny the agent is
   * not resumed (the user drives what happens next).
   */
  type: "connectionRequest";
  /**
   * The gatekeeper vendor the agent is requesting (id + denormalized display name), or
   * AGENT_SPAWNER_CONNECTION_ID for an agent spawner.
   */
  vendorId: string;
  /** Denormalized vendor logo URL, for the connection card icon. */
  vendorLogoUrl?: string;
  vendorName: string;
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  /**
   * Optional machine-readable code so the client can react specially (e.g. "usage_limit" opens
   * the "connect Cloudflare / add credits" modal instead of a generic error + retry).
   */
  code?: string;
  message: string;
  sequence: number;
  timestamp: Date;
  /**
   * Indicates that the agent run ended with an error (e.g. LLM API failure, abort, server
   * restart). This is displayed to the user with a "retry" button, but is NOT included in the
   * chat log sent to the LLM so the agent does not react to it.
   */
  type: "error";
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  /**
   * The commits this merge created: each touched gadget's new head (see
   * WorkpieceSummary.commitId). Empty when the merge created no commits (e.g. it covered only
   * gadget creations / binding additions, with no code changes). Present on every merge
   * message, including pre-migration ones: the git-storage migration synthesized a commit for
   * each historical merge and backfilled this field.
   */
  commits: {
    commitId: string;
    gadgetId: number;
  }[];
  /**
   * This merge closed the chat's epoch: the chat's code base reset to empty and its change stream
   * restarted under a new generation, so content reconstruction starts fresh here (see
   * ChatCodeBase). Present on every merge message except pre-migration ones, which predate
   * epochs.
   */
  epochBoundary?: true;
  mergeThrough: number;
  sequence: number;
  timestamp: Date;
  /**
   * Indicates that at this point in the chat, the user chose to merge all (non-reverted) changes
   * in this chat up to and including the given sequence number. `mergeThrough` is
   * server-computed: always the last sequence recorded before this message, since merges accept
   * everything (see Overseer.mergeChanges()).
   */
  type: "merge";
  /**
   * Obsolete: the workspace-wide code version at which a pre-git-storage merge was applied.
   * Merges now record `commits` instead.
   */
  version?: number;
  /**
   * No longer written; honored when read. Merges from when worktrees were pinned from birth
   * recorded here the re-pin of each live worktree in the new generation, at `baseCommit`: a
   * fresh local auto-commit capturing its uncommitted overlay when the closed epoch left it
   * dirty, else its unchanged base. Content reconstruction and compaction checkpoints still
   * re-root worktree content at these pins so the epochs they open fold as they were written.
   * Today a worktree pins on first modification like a gadget, and an accept merely advances
   * the worktree's accepted commit (to the same auto-commit) with no pin in the new generation,
   * so a merge written now carries no entry here. Auto-commits are internal bookkeeping,
   * squashed out of explicit history -- the worktree's reported head is untouched, and a later
   * explicit commit parents on that head, never on an auto-commit. Clients do not need to read
   * this field: a re-pin that is still in effect is mirrored in ChatCodeBase.pins, which is the
   * only pin source a client uses.
   */
  worktreePins?: {
    baseCommit: string;
    worktreeId: number;
  }[];
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  request: SlashCommandRequest;
  sequence: number;
  /** Provider-supplied skill name for the display badge. Commands without one show no badge. */
  skillName?: string;
  timestamp: Date;
  /**
   * A slash command exactly as requested by the client, retained for display and never included in
   * model context. A gatekeeper command does not itself start an agent turn -- the prompt it expands
   * to arrives as a separate `message`. A built-in command is handled by the Workshop, and this
   * record is what drives the turn it runs.
   */
  type: "slashCommand";
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  /** Each changed or new resource, as it is now. */
  resources: AlwaysAvailableResource[];
  sequence: number;
  timestamp: Date;
  /**
   * The always-available resources changed after the agent's system prompt listed them: a
   * catalog changed, e.g. a skill was added to the Context Library, or the chat gained a resource,
   * e.g. the owner turned on Web Search. The agent writes this before the model request that first
   * sees the change, and tells the model what changed, so the system prompt can stay the same for
   * the whole chat. Clients show nothing for it.
   */
  type: "catalogChange";
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  revertFrom: number;
  sequence: number;
  timestamp: Date;
  /**
   * Indicates that at this point in the chat, the user chose to revert all changes starting at the
   * given sequence number through the end of the chat as of that time. These changes are
   * completely erased from the chat's uncommitted state. Subsequent changes will be based only on
   * what existed before this point, and any later merge will not include the reverted changes.
   */
  type: "revert";
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  sequence: number;
  text: string;
  timestamp: Date;
  /**
   * A model-visible control note for an approved-decision handoff, explicit Retry, or Stop.
   * It also ends the preceding decision segment for recovery. Not rendered in the chat UI:
   * the decision cards and turn controls already show these transitions to the user.
   * Older logs used this variant to nudge an agent whose callbacks were still unresolved.
   */
  type: "agentNudge";
} | {
  author: AiChatAuthorInfo;
  chatId: number;
  sequence: number;
  timestamp: Date;
  /**
   * Indicates that the AI agent accessed the gadget one or more times. This is logged in order
   * to track whether information known to the gadget may have tainted the agent session.
   */
  type: "useGadget";
};

/** Metadata about one chat in a workspace. */
export type AiChatMetadata = {
  /**
   * If present, an LLM (described by the author info) is currently actively responding to the
   * chat.
   */
  activeAgent?: AiChatAuthorInfo;
  /** How many of `promptTokens` the provider read from its prompt cache. */
  cacheReadTokens?: number;
  /** How many of `promptTokens` the provider wrote to its prompt cache. */
  cacheWriteTokens?: number;
  /**
   * The chat's code-branch state for its *current epoch*: which gadgets are pinned (and where),
   * plus the stream position and generation that submitCodeChange() validates against. Delivered
   * via AiChatSubscriber.metadata(), and re-delivered when its shape changes -- a pin
   * established or advanced, a generation bump -- but not on every accepted change: clients track
   * `revision` live via AiChatSubscriber.changeApplied().
   *
   * Absent until something first needs it; an absent record means
   * `{pins: [], generation: 0, revision: 0}`, and both sides use that reading -- a new chat's
   * first submitCodeChange() simply passes `generation: 0, revision: 0`.
   */
  codeBase?: ChatCodeBase;
  /**
   * First sequence this chat still replays. Everything before it is covered by a compaction
   * checkpoint; those messages remain in canonical history but no longer drive current-state reads.
   */
  compactedTo?: number;
  id: number;
  lastActive: Date;
  /**
   * Prompt tokens this conversation has sent to the model so far, including the ones the
   * provider read from or wrote to its prompt cache, if known. A running total, like
   * `totalCost`: compaction does not reset it.
   */
  promptTokens?: number;
  /**
   * The workpieces to which this chat has proposed changes that have not been accepted yet
   * (including changes not yet materialized into a durable `changes` message): gadgets and
   * worktrees whose code the chat modified (pinned in the current epoch -- for a worktree, an
   * explicit commit() counts as a modification), gadgets it provisionally created, and gadgets
   * it added a binding to. A worktree's creation alone is not listed: the worktree is private to
   * the chat either way, so a checkout made only to be read proposes nothing (see
   * AiChatMessageBody.createdWorktrees). Absent (or empty) when the chat proposes nothing --
   * the pending-changes accept/discard affordances and per-workpiece draft previews key off this
   * list. Derived server-side and delivered on metadata updates; never submitted by clients.
   * (This replaces the earlier `hasProposedChanges` boolean; values of that retired field may
   * linger in stored metadata but are never delivered as truth.)
   */
  proposedChangeWorkpieces?: number[];
  /**
   * Messages sent while the agent works that it has not read yet, oldest first (see
   * `Overseer.sendChatMessage`). Each then appears in the chat as a message marked `steered`,
   * unless a turn ends without reading it and without failing or waiting on the user's decision:
   * it then prompts the next turn as an ordinary message. Stopping the agent drops them all (see
   * `Overseer.stopAgent`). Absent when none.
   */
  queuedSteers?: {
    author: AiChatAuthorInfo;
    text: string;
  }[];
  /** If this was started from an agent spawner, the spawner's display name. */
  spawnerName?: string;
  started: Date;
  title: string;
  /** Total cost of this conversation so far, in dollars, if known. */
  totalCost?: number;
  /**
   * Tokens the model reported for this conversation's last step, if known. Cleared when compaction
   * changes what the next prompt will contain, until a step measures it again.
   */
  totalTokens?: number;
};

/**
 * One provisional streaming event emitted while an agent step is still in progress.
 *
 * At most one provisional stream is active per chat at a time. The client should not persist
 * these events. Instead, it should display them temporarily and discard them as soon as the
 * corresponding durable `message()` and/or `changes` message arrives, when the agent stops
 * running (`activeAgent` becomes unset in the chat metadata), or when a `streamReset` event
 * arrives.
 */
export type AiChatStreamEvent = {
  delta: string;
  toolCallId: string;
  /** Appends newly decoded characters to the streaming edit preview's content. */
  type: "editPreviewDelta";
} | {
  delta: string;
  toolCallId: string;
  /**
   * For the executeCode tool specifically, we stream the code as the AI writes it. (writeFile and
   * editFile stream their in-progress content through the editPreview* events below instead; other
   * tool calls' inputs are not streamed.)
   */
  type: "toolCodeDelta";
} | {
  delta: string;
  toolCallId: string;
  type: "toolOutputDelta";
} | {
  delta: string;
  type: "reasoningDelta";
} | {
  delta: string;
  type: "textDelta";
} | {
  file: {
    filename: string;
    workpieceId: number;
  };
  /**
   * For editFile: the exact text being replaced. The client finds its unique match in the file
   * (skipping the preview if there isn't exactly one -- the call itself will then fail). Absent
   * for writeFile, whose streamed content replaces the whole file.
   */
  textToReplace?: string;
  toolCallId: string;
  /**
   * Opens a live preview of a writeFile/editFile call whose content the model is still
   * generating: the streamed value (delivered by editPreviewDelta events) progressively replaces
   * a span of the target file, so the user watches the edit appear as it is written. Emitted
   * once the call's input has streamed far enough to identify the target (which happens when the
   * content/replacement field begins, since it is the input's final field).
   *
   * The event carries no base content: the client locates the span in its own copy of the file
   * -- the chat's content, or the committed head (a worktree's accepted commit) for a workpiece
   * the chat doesn't cover, read via readFilesAtCommit() if not yet loaded -- which mirrors the
   * content the agent computes its edit against (both are the same change stream).
   * The preview is display-only provisional state, never entering the client's own change
   * tracking.
   *
   * At most one preview is *streaming* at a time (a new editPreviewStart ends the previous
   * call's delta stream), but a preview outlives its streaming: tool calls execute only after
   * the whole model response has streamed, so several previews can finish before any of their
   * durable rows exists. The client must keep displaying each finished preview's final text --
   * a call's edits would otherwise vanish until its row lands -- until the preview resolves,
   * which happens in one of two ways: the completed call's change row arrives via
   * AiChatSubscriber.changeApplied() carrying the same final content (the ordinary end), or an
   * editPreviewClear withdraws it because no row will come. Since rows arrive in call order,
   * per-file previews resolve oldest-first. As with all provisional state, the client should
   * also discard whatever remains when the agent stops running.
   */
  type: "editPreviewStart";
} | {
  file: {
    filename: string;
    workpieceId: number;
  };
  toolCallId: string;
  /** Streaming write/edit target file, used by the UI before the finalized tool call arrives. */
  type: "toolCallTarget";
} | {
  file: null | {
    filename: string;
    workpieceId: number;
  };
  /**
   * Indicates which file the agent is currently editing, if any. This is emitted while a
   * writeFile/editFile call is streaming, and set to null when a non-edit tool becomes active.
   */
  type: "setActiveFile";
} | {
  /**
   * Set when the attempt made no checkpoint because nothing precedes the newest message to
   * summarize. Only `/compact` reports this, since an explicit command is otherwise silent.
   */
  nothingToCompact?: boolean;
  /**
   * The compaction attempt ended, whether it compacted, failed, was cancelled, or found nothing to
   * do.
   */
  type: "compacted";
} | {
  output: BlueprintOutput;
  toolCallId: string;
  /**
   * Streaming createGadget output format, used by the UI before the finalized tool call arrives.
   * Has the deployment's overrides applied, so it matches what the gadget is stamped with.
   */
  type: "toolCallOutputFormat";
} | {
  toolCallId: string;
  toolName: "createExternalResource" | "createGadget" | "createWorktree" | "describeBinding" | "editFile" | "executeCode" | "giveUp" | "grep" | "listBlueprints" | "listConnectableResources" | "observeUserChanges" | "readFile" | "requestConnection" | "saveCapsuleAsBinding" | "setBindingHook" | "setGadgetBinding" | "webFetch" | "writeFile";
  type: "toolCallStarted";
} | {
  toolCallId: string;
  /**
   * Withdraws an edit preview whose tool call will produce no change row -- its input failed to
   * parse or validate, the call failed, or the edit turned out to be a no-op. May name any call
   * of the current response, not just the one currently streaming (failures surface at
   * execution, after later calls' previews may have started). The client restores the previewed
   * file to its real content. (Successful calls emit no clear: the durable changeApplied row
   * supersedes the preview instead.)
   */
  type: "editPreviewClear";
} | {
  toolCallId: string;
  /**
   * This is a provisional UI lifecycle event. For most tools it means the full tool call input has
   * been received, so the tool is no longer visually "in progress". executeCode does not emit this
   * during streaming; its provisional card is cleared when the final durable message arrives.
   */
  type: "toolCallFinished";
} | {
  /** The turn is summarizing older context before it can continue, or before `/compact` ends. */
  type: "compacting";
} | {
  /**
   * The in-progress model request failed transiently and will be retried. Nothing it streamed
   * will become durable, so the client should discard the step's provisional state -- streamed
   * text and reasoning, tool-call cards, the active-file marker and all edit previews -- as it
   * would for an error message. The retry then streams afresh.
   */
  type: "streamReset";
};

/** Information about the AI gateway configuration. Returned by `AuthenticatedApi.getAiConfig()`. */
export type AiGatewayInfo = {
  /**
   * The ID of every model the deployment provides through AI Gateway, in any mode (see
   * GatewayModelMode). A user can't edit or delete these, nor add a model under one of these IDs.
   */
  builtInModelIds: string[];
  enabled: true;
  /**
   * The providers the deployment enables: the ones CF_AI_GATEWAY_PROVIDERS lists and the ones its
   * admin turned on (see AdminApi.setGatewayProviderEnabled). A user can add a model of their own
   * under these only.
   */
  enabledProviders: AiModelProvider[];
  /**
   * Whether users may add models of their own (see AdminApi.setUserModelsEnabled). When false,
   * addModel() and updateModel() refuse, and the models the user added are neither listed nor
   * resolved.
   */
  userModelsEnabled: boolean;
} | {
  enabled: false;
};

/** Supported AI providers. */
export type AiModelProvider = "anthropic" | "cloudflare" | "google" | "ollama" | "openai";

/**
 * Describes a tool call performed by an AI agent as part of a message.
 *
 * The agent addresses workpieces by their chat binding name (the `gadget`/`workpiece` parameters
 * on several variants), never by workpiece ID. Logs persisted before multi-gadget workspaces lack
 * these names; when a name is absent, the workspace's `defaultGadgetId` (from `WorkspaceMetadata`)
 * is assumed, and it is an error for it to be omitted when there is no default.
 */
export type AiToolCall = {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    /**
     * Name under which the gadget appears in the chat's env and, once merged, the workspace
     * default binding list (see validateBindingName()).
     */
    bindingName: string;
    /**
     * If present, the new gadget starts with the named blueprint's files (copied into the chat's
     * proposed changes) instead of empty.
     */
    blueprintId?: string;
    /** Human-readable title for the new gadget. Required: the agent always names its creations. */
    title: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /**
   * The created gadget's workpiece ID, recorded when the gadget was actually created. History
   * replay reconstructs tool outputs by re-running persisted calls, but a creation tool can't be
   * re-run; replay returns this recorded result without creating anything.
   *
   * `changeId` is the change number of the "changes" batch that records the creation (see
   * `createdGadgets` on the "changes" message body), reported like writeFile/editFile report
   * theirs so reverts can be referred to precisely.
   *
   * `blueprintNotes` is present for blueprint instantiations: formatted text describing the files
   * copied in and the bindings the blueprint expects the agent to wire up. Recorded so replay
   * doesn't have to re-fetch the blueprint (whose content may have changed since).
   */
  output?: {
    blueprintNotes?: string;
    changeId?: number;
    gadgetId: number;
  };
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /** Create a new gadget workpiece in the workspace, either empty or instantiated from a blueprint. */
  toolName: "createGadget";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    bindingName: string;
    capsuleId: number;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * Obsolete predecessor of `setGadgetBinding`, from before named chat bindings; appears only in
   * old chat logs. Its additions were immediate and permanent (nothing provisional to recover),
   * so replay is a recorded no-op.
   */
  toolName: "saveCapsuleAsBinding";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    /**
     * Name under which the worktree appears in the chat's env (see validateBindingName()). The
     * chat's binding map is the only namespace a worktree name occupies.
     */
    bindingName: string;
    /**
     * The git commit to root the worktree at: a full 40-hex oid, resolved against the
     * workspace's local git store and its gatekeeper-provided metadata (never a remote lookup --
     * remote refs resolve through gatekeeper APIs first). Abbreviated ids are refused, since
     * knowing a commit's id is the capability to read it; logs written before that may carry an
     * unambiguous prefix.
     */
    commitId: string;
    /** Human-readable title for the new worktree. Required, like a gadget's. */
    title: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /**
   * The created worktree's workpiece ID, recorded when the worktree was actually created; like
   * createGadget's output, replay returns this recorded result instead of re-creating.
   *
   * `changeId` is the change number of the "changes" batch that records the creation (see
   * `createdWorktrees` on the "changes" message body), like createGadget's.
   *
   * `baseCommit` is the full oid `input.commitId` resolved to -- the commit the worktree is
   * rooted at, and its accepted commit until the chat's first accept of changes to it. Recorded
   * because the input of an older log may be a prefix and the model is told the resolved oid. The creation pins
   * nothing: the worktree reads as its accepted commit until its first modification pins it
   * (see ChatGadgetPin), so replay serves untouched files from the pin when there is one and
   * from the accepted commit otherwise, never from this field.
   */
  output?: {
    baseCommit: string;
    changeId?: number;
    worktreeId: number;
  };
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * Create a new worktree workpiece: a file tree rooted at a git commit, private to the creating
   * chat, whose files the agent then reads and edits with the regular file tools. Unlike a
   * gadget, a worktree has no output, no bindings, and cannot execute; its name lives only in
   * the chat's binding map, never in the workspace default binding list.
   */
  toolName: "createWorktree";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    bindingName: string;
    entrypoint: null | string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  toolName: "setBindingHook";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    /** Name under which the resource appears in the chat's env (see validateBindingName()). */
    bindingName: string;
    /** `urlPattern` of the creatable resource type. */
    resourceUrlPattern: string;
    /** Title of the new resource, e.g. a document's title. */
    title: string;
    vendorId: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /** The new gatekeeper workpiece; replay re-binds it rather than creating again. */
  output?: {
    gatekeeperId: number;
  };
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * Create a new external resource of a creatable type (see `SupportedResource.creatable`). Its
   * binding is usable at once: the gatekeeper simulates the resource until a user approves the
   * creation action, choosing the account to create it in.
   */
  toolName: "createExternalResource";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    /**
     * Name under which the resource will appear in the chat's env once accepted (see
     * `connectionRequest.bindingName`). Optional only because logs persisted before named chat
     * bindings lack it.
     */
    bindingName?: string;
    reason: string;
    resourceUrl?: string;
    vendorId: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  output?: string;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * Ask the user to connect a gatekeeper, pre-configured as much as the agent can manage. Renders
   * an accept/deny card in the chat; non-blocking (the turn ends, and the agent is resumed if the
   * user accepts; on deny the agent is not resumed).
   */
  toolName: "requestConnection";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    code: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /** Output, if the code actually ran. (Otherwise, `error` should be present.) */
  output?: string;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  toolName: "executeCode";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    content: string;
    filename: string;
    workpiece?: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  toolName: "writeFile";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    error: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * **Obsolete.** Rejected all of the agent's outstanding callbacks with an error. No longer
   * emitted since callable agents stopped returning values; retained so older chat logs remain
   * readable.
   */
  toolName: "giveUp";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    filename: string;
    lineCount?: number;
    /**
     * Optional line window: `startLine` is 1-based and `lineCount` is the number of lines to return
     * from there, each defaulting to the file's edge. A windowed read ends with a line stating the
     * range shown and where to continue. Absent on reads recorded before ranges existed.
     */
    startLine?: number;
    workpiece?: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /**
   * No longer written; honored when read. Before reads were stamped with the blob's oid
   * (`observedOid`), an unpinned read recorded the commit it read at; replay resolves the file's
   * blob from it by path.
   */
  observedCommit?: string;
  /**
   * Present when the read was served from committed code rather than the chat's uncommitted
   * content: the workpiece was not pinned in the chat (see ChatGadgetPin), so the agent read the
   * file at its head -- a gadget's mainline head, a worktree's accepted commit -- and this is
   * the blob oid of the content it saw. History replay reproduces the read's exact text from
   * it, whatever the head holds now, and the agent's read-before-edit gate compares it against
   * the file's oid at the head an edit is about to pin at, refusing an edit anchored to content
   * another chat has since changed. Reads of pinned workpieces come from the chat's content,
   * which cannot go stale within an epoch, and carry no stamp.
   */
  observedOid?: string;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * Any workpiece can potentially export files. Gadgets, in particular, export their source code
   * as files, but other workpieces may export other filesystems. Hence, a file is identified by
   * the pair of a workpiece reference (the `workpiece` chat binding name) and `filename`.
   */
  toolName: "readFile";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    filename: string;
    replacement: string;
    textToReplace: string;
    workpiece?: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  toolName: "editFile";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    /** Chat binding name of the target gadget or agent spawner. */
    gadget: string;
    /** Name to bind the resource under within the gadget; defaults to `source`. */
    name?: string;
    /** Chat binding name of the resource to wire into the gadget. */
    source: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /**
   * The added binding edge as resolved when the tool ran -- the durable record of what the call
   * did, which history replay reproduces instead of re-running the tool, mirroring createGadget's
   * recorded output. `changeId` is the change number of the batch that records the addition (see
   * `addedBindings`). Absent only when the call failed (`error` is set).
   */
  output?: {
    changeId: number;
    gadgetId: number;
    name: string;
    target: number;
  };
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * Wire one of the chat's bindings into a gadget's own binding list, or an agent spawner's. The
   * addition is provisional to the chat, recorded by a "changes" message (see `addedBindings`).
   */
  toolName: "setGadgetBinding";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    /** Chat binding name of a gadget; when present, `name` is a binding in that gadget's env. */
    gadget?: string;
    name: number | string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /**
   * The description, exactly as the model saw it (already bounded), which history replay returns
   * verbatim rather than describing the binding again. Absent when the call failed, and in logs
   * persisted before descriptions were recorded, whose replay elides the result.
   */
  output?: string;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * Describe a binding by name: one of the chat's bindings or, when `gadget` is given, one of
   * that gadget's own bindings. Numeric names appear only in logs persisted before named chat
   * bindings (they were capsule indices).
   */
  toolName: "describeBinding";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    /** A file to search, or a directory to search recursively. Absent means the whole workpiece. */
    path?: string;
    /** JavaScript regular expression, matched against each line. */
    pattern: string;
    workpiece: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  output?: string;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * Search a workpiece's files for lines matching a regular expression, in `grep -n` form. The
   * output, bounded as the model saw it, is recorded so replay doesn't re-run the search.
   */
  toolName: "grep";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    /** If true, return the raw response body without Markdown conversion. */
    raw?: boolean;
    url: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /**
   * Output, if the fetch actually completed. (Otherwise, `error` should be present.) This is
   * stored so that the agent's chat history can be replayed without re-issuing the fetch.
   * Formatted as a YAML-frontmatter header followed by the body (see formatWebFetchResult).
   */
  output?: string;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  toolName: "webFetch";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {
    vendorId: string;
  };
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  output?: string;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * List the resource types a gatekeeper vendor offers, so the agent can construct a resourceUrl
   * for requestConnection. Resource patterns are only surfaced on demand (not in the system prompt).
   */
  toolName: "listConnectableResources";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {};
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  output?: string;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /**
   * List the blueprints the workspace owner could instantiate (their own blueprints, their
   * library, and the deployment's featured blueprints), so the agent can pass a blueprintId to
   * createGadget. The formatted text output is recorded so replay doesn't re-list.
   */
  toolName: "listBlueprints";
} | {
  /** If the tool failed, the error. */
  error?: string;
  input: {};
  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;
  /** This actually shouldn't ever appear in logs unless the agent misunderstands the tool. */
  toolName: "observeUserChanges";
};

/**
 * A resource the agent can always use without requesting it (e.g. the Context Library's read
 * session), as its system prompt lists it.
 */
export type AlwaysAvailableResource = {
  /** The resource's discovery catalog, or null if it has none or it failed to load. */
  catalog: null | AgentCatalog;
  /** The resource's binding name in the agent's `env`. */
  name: string;
  /** The resource's title. */
  title: string;
};

/** Result of GadgetClient.applyBlueprint(). */
export type ApplyBlueprintResult = {
  /** The new chat. */
  chatId: number;
  /** A new chat holds the proposal, to preview and then accept or discard. */
  outcome: "proposed";
} | {
  /**
   * The gadget and the blueprint share a version, but its files are not available to merge
   * against. Nothing was proposed.
   */
  outcome: "baseUnavailable";
} | {
  /**
   * The gadget and the blueprint share no history, and the caller did not allow for that.
   * Nothing was proposed. Calling again with `allowUnrelated` proposes a merge over a guessed
   * base (see BlueprintMerge.unverifiedBase), which the user should be warned of first.
   */
  outcome: "unrelated";
} | {
  /** The gadget already follows this blueprint at its current release. Nothing was proposed. */
  outcome: "upToDate";
};

/** A small image used to identify a vendor, account, or resource type in the UI. */
export type AvatarImage = {
  url: string;
};

/**
 * Accent colors available for the full-width announcement banner. Soft status tints plus the brand
 * color, so a banner need not look like an alert.
 */
export type BannerColor = "brand" | "danger" | "info" | "neutral" | "success" | "warning";

/** The deployment-wide full-width banner configuration. */
export type BannerConfig = {
  /** Accent color. */
  color: BannerColor;
  /** Banner text (Markdown supported). Empty string hides the banner. */
  text: string;
};

/**
 * Describes one binding required by a blueprint. Stored in BlueprintMetadata.bindings as a
 * Record keyed by binding name. Consumers identify bindings by their key (the binding name)
 * while `title` and `description` provide user-facing text.
 */
export type BlueprintBinding = {
  description: string;
  /**
   * Symbolic form of AgentSpawnerConfig.env: env name -> target, resolved to concrete workpiece
   * IDs at instantiation time (see SpawnerEnvTarget).
   */
  env: {
    [key: string]: SpawnerEnvTarget;
  };
  /**
   * If true, this binding exists only to satisfy an agent spawner's env (it is referenced by
   * some spawner's `env` entry as a SpawnerEnvTarget). The user fills it at instantiation time
   * like any other binding, but the created gatekeeper is fed only to the spawner(s) referencing
   * it -- it is not bound into the gadget itself.
   */
  spawnerOnly?: true;
  /**
   * The blueprint creator may suggest a particular model to use, or omit this. (The
   * value is `null` if the suggestion is that AgentSpawnerConfig.modelId should be
   * configured as `null`. This is different from `undefined`, which means no suggestion.)
   */
  suggestedModel?: null | {
    modelName: string;
    provider: string;
  };
  title: string;
  /** An agent spawner binding. */
  type: "agentSpawner";
} | {
  description: string;
  /**
   * Identifies the gatekeeper adapter (currently mapped to the workshop's
   * GATEKEEPER_<name> service binding).
   */
  gatekeeperName: string;
  /** The specific resource URL from the source gadget (suggestion only). */
  resourceUrl?: string;
  /**
   * If true, this binding exists only to satisfy an agent spawner's env (it is referenced by
   * some spawner's `env` entry as a SpawnerEnvTarget). The user fills it at instantiation time
   * like any other binding, but the created gatekeeper is fed only to the spawner(s) referencing
   * it -- it is not bound into the gadget itself.
   */
  spawnerOnly?: true;
  title: string;
  /** A regular external-resource gatekeeper binding. */
  type: "gatekeeper";
  /** URL pattern describing the type of resource this binding accepts. */
  typeUrlPattern: string;
} | {
  description: string;
  /** The source binding's model kind, so installers pick one of that kind; absent: `"language"`. */
  modelKind?: ModelKind;
  /**
   * If true, this binding exists only to satisfy an agent spawner's env (it is referenced by
   * some spawner's `env` entry as a SpawnerEnvTarget). The user fills it at instantiation time
   * like any other binding, but the created gatekeeper is fed only to the spawner(s) referencing
   * it -- it is not bound into the gadget itself.
   */
  spawnerOnly?: true;
  /**
   * The blueprint creator may suggest a particular model to use, or omit this to leave
   * it up to the recipient.
   */
  suggestedModel?: {
    modelName: string;
    provider: string;
  };
  title: string;
  /**
   * An AI model binding. The user instantiating the blueprint picks one of their own
   * configured models.
   */
  type: "aiModel";
};

/**
 * User-provided metadata controlling how a gatekeeper binding should appear in blueprints.
 * Stored on the binding edge (a gadget's binding-name -> gatekeeper mapping), not on the
 * gatekeeper itself: two gadgets binding the same gatekeeper can annotate it differently for
 * their respective blueprints. Optional: when absent, the binding is included in the blueprint
 * with a generated title, empty description, and no resource suggestion.
 *
 * Legacy field `included` may still be present on records written by older versions of
 * the workshop. The backend still honors `included: false`, but new writes omit it.
 */
export type BlueprintBindingAnnotation = {
  description: string;
  suggestValue?: boolean;
  title: string;
};

/**
 * Binding assignment (input to newWorkspaceFromBlueprint).
 * When instantiating a blueprint, the user provides a Record mapping binding name ->
 * assignment. Every required binding in the blueprint must have a corresponding entry.
 */
export type BlueprintBindingAssignment = {
  accountId: number;
  resourceUrl: string;
  type: "gatekeeper";
} | {
  modelId: string;
  type: "aiModel";
} | {
  modelId: null | string;
  type: "agentSpawner";
};

/** Gadget-side summary (returned by Overseer.listBlueprints). */
export type BlueprintGadgetSummary = {
  codeVersionDate: Date;
  description: string;
  dirty?: boolean;
  id: string;
  screenshotUrl?: string;
  title: string;
  /**
   * Present if the gadget the blueprint is published from has committed files other than the
   * ones the blueprint last published: Overseer.updateBlueprint() with `updateCode` would
   * publish them. It goes by the files alone, so a gadget whose history has moved on but whose
   * files are back as they were published has none.
   */
  unpublishedChanges?: true;
  version: number;
};

/** User-side library summary (returned by AuthenticatedApi.listLibraryBlueprints). */
export type BlueprintLibrarySummary = {
  addedAt: Date;
  id: string;
  metadata: BlueprintMetadata;
  pinned?: boolean;
  uploaded: boolean;
};

/**
 * A proposal to merge a release of a blueprint into a gadget (see
 * AiChatMessageBody.blueprintMerges). It records everything about the proposal as it was made,
 * so describing it needs no second look at a blueprint that may have been republished since.
 */
export type BlueprintMerge = {
  /**
   * The commit the merge took as the version the gadget and the release have in common. Absent
   * if there was nothing to merge: the release was already in the gadget's history, or the
   * gadget was created from it.
   */
  baseCommit?: string;
  /** The blueprint, which the gadget follows once the proposal is accepted. */
  blueprintId: string;
  /** The release: the commit that the gadget's history gains as a parent, if it lacks it. */
  commitId: string;
  /**
   * The files whose merge was not clean, as paths within the gadget, in sorted order. Each
   * holds inline conflict markers, or for a file one side deleted and the other changed, the
   * changed content with no markers (as for `mainlineMerge`). Empty unless `kind` is "merge".
   */
  conflictPaths: string[];
  /** The gadget the release is merged into. */
  gadgetId: number;
  /**
   * What the proposal does to the gadget's files, as the result of the merge decides it:
   * - "follow": nothing. Either the release is already in the gadget's history, or the gadget
   *   already has every change the release made since the base.
   * - "fastForward": they become the release's exactly. The gadget had no changes of its own
   *   since the base, or was created from the release.
   * - "merge": the gadget and the blueprint both changed files since the base, and the two
   *   sets of changes were merged, three ways. A merge that conflicted is one even if no file
   *   changes: a file the gadget changed and the release deleted is kept, but whether it
   *   should stay is still to be decided.
   */
  kind: "fastForward" | "follow" | "merge";
  /**
   * The bindings the release declares that the gadget had none named for, by binding name.
   * Absent if there were none. A binding that exists only to feed an agent spawner
   * (`spawnerOnly`) has no name in the gadget to look for, so it is listed only when a missing
   * agent-spawner binding's agents get it.
   */
  missingBindings?: {
    [key: string]: BlueprintBinding;
  };
  /** The blueprint's title at this release. */
  title: string;
  /**
   * Present if the gadget and the release share no history, so that `baseCommit` is a guess at
   * what the gadget was built from. A change the gadget's owner made that the guess happens to
   * include looks like something the blueprint removed, and is undone with no conflict
   * reported.
   */
  unverifiedBase?: true;
  /** The blueprint's version counter at this release (`BlueprintMetadata.version`). */
  version: number;
};

/**
 * General metadata about a blueprint. Stored (in slightly different wrapper records) in
 * three locations: Gadget DO, User DO, and KV.
 */
export type BlueprintMetadata = {
  author: AiChatAuthorInfo;
  /** Key = binding name. */
  bindings: {
    [key: string]: BlueprintBinding;
  };
  /**
   * The git commit this version of the blueprint is: its *release commit*, whose tree holds the
   * blueprint's files. The blueprint's content is a packfile of that commit.
   *
   * Absent on a blueprint stored before releases were commits, whose content is a snapshot of
   * its files alone.
   */
  commitId?: string;
  created: Date;
  description: string;
  lastUpdated: Date;
  /**
   * What instantiating this blueprint produces. Absent means a generic app. Inherited by gadgets
   * created from this blueprint, and preserved when such a gadget is republished as a blueprint.
   */
  output?: BlueprintOutput;
  /**
   * If present, a screenshot is stored separately from the metadata. The server uses this
   * to decide when to include a derived screenshotUrl.
   */
  screenshot?: true;
  title: string;
  version: number;
};

/**
 * What instantiating a blueprint produces: a Document, a Spreadsheet, a Workflow, etc. Declared
 * by the blueprint's author (see `BlueprintMetadata.output`), inherited by every gadget instantiated
 * from it, and used wherever that gadget is shown in place of generic gadget.
 *
 * Declaring this is presentation only. Any user can publish a blueprint calling itself a
 * Document; that must be harmless. Being offered as one of the deployment's standard formats (in
 * the New menu, or the agent's preferred list) is a separate, admin-curated decision.
 */
export type BlueprintOutput = {
  icon: "appWindow" | "chartBar" | "fileText" | "flowArrow" | "gridNine" | "kanban" | "listChecks" | "notebook" | "presentation" | "table";
  /**
   * Stable grouping slug, e.g. "document". Outputs sharing an id are grouped together on the
   * outputs page.
   */
  id: string;
  noun: string;
  plural: string;
};

/** Public view (returned by PublicApi.getBlueprint). */
export type BlueprintPublicInfo = {
  id: string;
  metadata: BlueprintMetadata;
  /** If present, browser-loadable URL for the public screenshot. */
  screenshotUrl?: string;
};

/** A screenshot image uploaded with a blueprint, which stores it apart from its metadata. */
export type BlueprintScreenshotUpload = {
  content: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
};

/**
 * Where a blueprint the user owns came from. This distinguishes the case the UI cares about — the
 * source workspace still exists, so it can be opened and it owns deletion of the blueprint — from
 * the two cases where it does not, so no caller has to infer that from display text. `workspaceId`
 * is reachable only in the case where opening it is meaningful.
 */
export type BlueprintSource = {
  type: "deletedWorkspace";
} | {
  type: "imported";
} | {
  type: "workspace";
  workspaceId: string;
  workspaceTitle: string;
};

/** User-side summary (returned by AuthenticatedApi.listOwnBlueprints and getOwnBlueprint). */
export type BlueprintUserSummary = {
  description: string;
  id: string;
  lastUpdated: Date;
  pinned?: boolean;
  /** Where this blueprint came from, and whether that origin is still openable. */
  source: BlueprintSource;
  title: string;
  version: number;
};

/** A hook bound in a workspace: a gatekeeper event that wakes a gadget's code. */
export type BoundHookInfo = {
  description: HookDescription;
  enabled: boolean;
  /** The gadget whose code this hook wakes. */
  gadgetId: number;
  /** The gatekeeper that delivers this hook. */
  gatekeeperId: number;
  id: number;
  resourceTitle?: string;
  resourceUrl?: string;
};

/**
 * What a model is asked for while no reasoning level is set for it: 'adaptive' when the model
 * itself decides whether and how much to reason, a level when the Workshop asks for that effort,
 * and null when no level is sent.
 */
export type BuiltInReasoning = "adaptive" | "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh" | null;

/** An immutable whole-file Git blob, addressed by the same OID capability as other Git objects. */
export type BytesRef = {
  /** Exact payload length in bytes, checked against the stored blob before use. */
  byteLength: number;
  /** Git blob object ID computed from the complete payload. */
  oid: string;
};

/**
 * Capsules are resource references that are embedded inline in a chat message. The name comes
 * from the fact that they are represented as a pill-shaped inline element, and that they represent
 * a capability (in the capability-based security sense).
 *
 * When the user is typing a chat message and inserts a link into the message, they will be
 * prompted to turn the link into a capsule. Doing so implicitly creates a gatekeeper and grants
 * the agent permission to use it.
 */
export type CapsuleSpecifier = {
  /**
   * The name under which the pasted resource appears in the chat's env (`env.NAME` in
   * executeCode). Stamped onto the persisted message at the turn-start naming chokepoint; absent
   * until then. Messages from before named chat bindings existed are stamped lazily the same
   * way. If the same workpiece already has a name in the chat's scope, that name is reused
   * rather than minting a new one.
   */
  bindingName?: string;
  /**
   * Denormalized resource description from calling GatekeeperClient.describe() at the time of
   * insertion. We store this in the chat message to avoid the need to start up the gatekeeper
   * to ask for it again every time the message is displayed.
   */
  description: ResourceDescription;
  /**
   * ID of the workpiece, which should have been created using newGatekeeper() or similar.
   *
   * This can reference any workpiece, including gadgets. It should be called `workpieceId`, but
   * when it was introduced it could only point to gatekeepers, and a name change would break
   * existing storage.
   */
  gatekeeperId: number;
  length: number;
  /**
   * Position and length of the text within the chat message which should be replaced by the
   * capsule. The chat message contains some placeholder text which the capsule replaces. This
   * placeholder text exists mostly for ease of debugging -- it is never actually displayed to
   * the user nor the agent. Typically, the placeholder text should be an integer in square
   * brackets, where the integer is the position of the capsule within the message's capsule
   * list, e.g. `[0]`, `[1]`, etc. However, nothing should actually depend on the placeholder
   * text's content; the CapsuleSpecifier itself is all that matters.
   */
  position: number;
  /**
   * Vendor whose gatekeeper the resource came from, denormalized at insertion like `description`
   * and trusted no more than it is, so the message can show the vendor's logo without starting the
   * gatekeeper. Display metadata only, never authority.
   */
  vendorId?: string;
};

/**
 * A previously uploaded blob to attach to a chat message, with display/model-input metadata.
 * The blob must be present in this workspace's Git store. Attachment limits and MIME signatures
 * are checked when sending. The ID-only variant accepts legacy staged uploads.
 */
export type ChatAttachmentHandle = {
  /** Legacy staged-upload ID; new clients use a blob OID instead. */
  id: string;
} | {
  /** MIME type of this use of the blob; it does not change the stored bytes. */
  mimeType: string;
  /** Original display filename, sanitized when sending. */
  name?: string;
  /** Immutable Git blob returned by `uploadBlob()`. */
  oid: string;
};

/**
 * Attachment metadata returned to clients.
 *
 * For supported inline image formats, `content` carries the image bytes so the client can render
 * them without an extra round trip. For other attachments, fetch the bytes on demand via
 * `Overseer.getChatAttachmentContent()`.
 */
export type ChatAttachmentRef = {
  /** Inlined bytes for small image attachments. Present only for images. */
  content?: Uint8Array;
  /** Chat-owned attachment identity used for downloads and message rendering. */
  id: string;
  mimeType: string;
  name?: string;
  /** Original immutable upload blob. Absent on legacy attachments. */
  oid?: string;
  size: number;
  /**
   * Path in the chat's scratch worktree, preserving uploaded bytes for every file format.
   * Absent only on legacy attachments committed before workspace ingress was introduced.
   */
  workspacePath?: string;
};

/**
 * A chat's code-branch state (see AiChatMetadata.codeBase). A chat behaves like a branch: its
 * uncommitted changes are one revisioned stream of code changes (see
 * `@gadgets/workshop-shared/code-change`) applied on top of pinned commits, and accepting the
 * changes fast-forwards each touched gadget's head (see Overseer.mergeChanges()). A gadget
 * joins the stream only when its code is first *modified* in the chat -- at that moment it is
 * pinned at a commit, whose tree its changes apply on top of. Unpinned gadgets always track
 * mainline head, live, and are read via Overseer.listTree()/readFilesAtCommit(). One exception:
 * a gadget created within this chat and still pending has no head commit to pin, so it stays
 * unpinned while its changes build its content up from nothing (every file starts with a
 * `set`); the merge that makes it permanent ends the epoch anyway, and in later epochs it pins
 * like any other gadget. A worktree (see createdWorktrees) follows the same rule with its
 * accepted commit in the role of the head: unpinned it reads as that commit's tree, its first
 * modification pins it there, and an accept advances the accepted commit rather than creating a
 * mainline commit.
 *
 * Clients derive the chat's content themselves: for each pin, start from `baseCommit`'s tree
 * (Overseer.listTree(baseCommit), with each file's text read by path via readFilesAtCommit()
 * only when something needs it -- an `edit` to apply, or a file the user opens; a whole
 * repository tree is never fetched); apply the current epoch's non-reverted `changes` messages'
 * changes in log order, from the pin's last declaration on (see ChatGadgetPinRecord, and
 * `composeEpochChanges` in `@gadgets/workshop-shared/code-change`); then apply the changes not
 * yet materialized into a message, delivered
 * in revision order via AiChatSubscriber.changeApplied(). Accepting changes ends the epoch: the
 * pin set resets to empty and the change stream restarts.
 */
export type ChatCodeBase = {
  /**
   * Sequence number of the message that opened the current epoch: an `epochBoundary` merge
   * message, or a migrated chat's `conversionBoundary` changes message. Absent when the epoch
   * runs from the start of the chat. Only `changes` messages after this point contribute to the
   * chat's current content.
   */
  epoch?: number;
  /**
   * Identifies the chat's current change stream. submitCodeChange() validates against this; it is
   * bumped by every operation that invalidates the stream clients are rooted in. Bumps come in
   * two classes. **Content-preserving** (a merge's epoch reset): the stream identity changes
   * but the content carries over -- `prior` describes the closed stream, and in-flight
   * submissions are transformed onto the new generation (see submitCodeChange()). **Destructive**
   * (a revert, draft discard, or agent turn abort erased already-applied changes, or
   * updateChatFromMainline() re-rooted pins): content other clients may have transformed against
   * is gone, so they must discard local state and rebuild. Pin additions do *not* bump -- they
   * only append changes.
   */
  generation: number;
  /**
   * Per-workpiece pins: every permanent gadget, and every worktree, whose code has been modified
   * in the current epoch.
   */
  pins: ChatGadgetPinState[];
  /**
   * Present after a content-preserving generation bump (a merge's epoch reset): describes the
   * closed generation so clients can hand off to the new one without losing anything. A client
   * still processing generation `prior.generation` first applies its remaining changeApplied()
   * deliveries -- that stream is complete once seen through `finalRevision` -- and then
   * switches. Content is identical across the boundary for every gadget except those listed in
   * `discontinuousGadgets`, which must be rebuilt from head (dropping pending local changes that
   * touch them; the server would reject those anyway). Absent after a destructive bump, whose
   * closed stream is unusable anyway.
   */
  prior?: {
    /**
     * Gadgets whose chat content did not carry across the epoch reset: the pin was dropped
     * while the chat's content for the gadget differed from the new head (it was pinned but had
     * no net change to commit, and mainline had moved past its pin). Usually empty.
     */
    discontinuousGadgets: number[];
    /** The closed generation's terminal revision: its stream is complete through here. */
    finalRevision: number;
    /** The closed generation. */
    generation: number;
  };
  /**
   * Revision of the most recently accepted change of the current generation's stream (changes are
   * numbered sequentially from 1; 0 means none yet). Restarts with each generation, so
   * `(generation, revision)` identifies a point in the chat's uncommitted-change stream. This
   * field is a snapshot as of this metadata delivery; clients track the live position via
   * AiChatSubscriber.changeApplied().
   */
  revision: number;
};

/**
 * One workpiece's pin within a chat (see ChatCodeBase): the record that the gadget's (or
 * worktree's) code was modified for the first time in the chat's current epoch, fixing the
 * commit its uncommitted changes apply on top of. A pin is established by that first
 * modification -- a submitCodeChange() pin declaration, or the agent's first write (for a
 * worktree, also its first commit()), which pins at the then-current head (a worktree's
 * accepted commit) -- and lasts until the epoch ends or the declaring message is reverted.
 *
 * This shape is the declaration a client submits with a first modification
 * (CodeChangeSubmission.pins). Its permanent record in the chat log and in compaction
 * checkpoints is a ChatGadgetPinRecord, which only the server writes.
 */
export type ChatGadgetPin = {
  /**
   * The commit whose tree the chat's uncommitted changes for this gadget apply on top of. Fixed
   * until a later declaration re-roots the gadget (see ChatGadgetPinRecord): every change
   * recorded for this gadget since is expressed against content rooted here, so nothing else
   * moves it.
   */
  baseCommit: string;
  /** The pinned gadget. */
  gadgetId: number;
};

/**
 * A pin declaration as the chat log records it: the `pins` of a "changes" message, and of a
 * compaction checkpoint. A declaration **re-roots** its gadget: the gadget's chat content
 * becomes `baseCommit`'s tree, and any changes that earlier messages of the epoch recorded for
 * the gadget no longer count. Every fold of the log applies that one rule, so a closed epoch's
 * content is reconstructed by starting each gadget from its last surviving declaration's tree
 * and applying the changes recorded from that message on. A reverted message declares nothing,
 * so reverting a re-root brings back the declaration before it and the changes recorded since.
 */
export type ChatGadgetPinRecord = {
  /**
   * The commit whose tree the chat's uncommitted changes for this gadget apply on top of. Fixed
   * until a later declaration re-roots the gadget (see ChatGadgetPinRecord): every change
   * recorded for this gadget since is expressed against content rooted here, so nothing else
   * moves it.
   */
  baseCommit: string;
  /** The pinned gadget. */
  gadgetId: number;
  /**
   * ChatGadgetPinState.mergedCommit as of the declaration, for whoever describes it. Absent
   * when it equals `baseCommit`. A record of the past only: the pin's live `mergedCommit` is
   * never set from it.
   */
  mergedCommit?: string;
};

/**
 * A pin's current state within a chat (see ChatCodeBase.pins): its current declaration, plus how
 * far mainline has been merged into the chat since. That addition is live state rather than
 * history, which is why it is absent from the declaration a client submits.
 */
export type ChatGadgetPinState = {
  /**
   * The commit whose tree the chat's uncommitted changes for this gadget apply on top of. Fixed
   * until a later declaration re-roots the gadget (see ChatGadgetPinRecord): every change
   * recorded for this gadget since is expressed against content rooted here, so nothing else
   * moves it.
   */
  baseCommit: string;
  /** The pinned gadget. */
  gadgetId: number;
  /**
   * The most recent mainline commit whose content the chat's content for this gadget includes.
   * Accepting the chat's changes requires this to equal the gadget's current head
   * (WorkpieceSummary.commitId); a difference means the chat is stale and the UI should offer
   * updating from mainline.
   *
   * It starts equal to `baseCommit`. An update from mainline recorded before re-roots existed
   * advanced it to a descendant of `baseCommit`. A re-root that merges mainline into the chat
   * declares a merge commit as `baseCommit` and sets this to the merge's first parent, the head
   * that was merged; accepting then fast-forwards the head from here through the merge commit
   * (see Overseer.mergeChanges()). A revert puts back what the earliest update it covers
   * records the pin had before (see AiChatMessageBody.mainlineMerge).
   */
  mergedCommit: string;
};

/** A Cloudflare account available to a connected user. Returned by `listCloudflareAccounts()`. */
export type CloudflareAccountOption = {
  accountId: string;
  accountName: string;
};

/**
 * Usage + Cloudflare-connection status for the optional limits flow. Returned by
 * `AuthenticatedApi.getCloudflareUsage()`.
 */
export type CloudflareUsageInfo = {
  accountId?: string;
  accountName?: string;
  /** The connected account's AI Gateway credit balance (USD), or null if unknown/not connected. */
  balance: null | number;
  /** Whether the limits flow is enabled at all. When false, the rest is informational only. */
  cloudflareLimitsEnabled: boolean;
  /** Whether the user has connected a Cloudflare account. */
  connected: boolean;
  dailyLimit: number;
  /** Free-tier daily usage. */
  dailyUsed: number;
  /**
   * True when connected but the user has multiple Cloudflare accounts and must pick which one to
   * bill before usage can proceed. The client should prompt with selectCloudflareAccount().
   */
  needsAccountSelection?: boolean;
  remaining: number;
  /** ISO timestamp when the daily window resets. */
  resetAt?: string;
  /** When true, the user has unlimited access (limits disabled) and counters are not tracked. */
  unlimited: boolean;
};

/**
 * One code change: for each touched gadget, a list of `[path, FileChange]` entries. Keys of the
 * outer object are gadget ids (WorkpieceIds) in canonical decimal form; an empty object is the
 * identity change, and a present gadget entry must be a non-empty list with no duplicate paths.
 * The index signature is `number`, but object keys are strings at runtime and on the wire, so
 * canonical decimal form is an invariant `validateCodeChangeSchema` enforces rather than one the
 * type states -- and iteration still yields string keys (see `gadgetEntries`).
 * Plain JSON, treated as immutable everywhere -- functions in this module share subtrees
 * between inputs and outputs rather than copying. Changes produced by this module list entries
 * in sorted path order, but consumers must not require that of received changes (entry order has
 * no meaning; only duplicates are illegal).
 *
 * The per-gadget entries are deliberately a list rather than a path-keyed object: paths may be
 * any non-empty string, including names that collide with `Object.prototype` members (git
 * content can legitimately contain a file named `__proto__` or `constructor`), and such names
 * must never be object keys on the wire -- Cap'n Web deletes prototype-shadowing keys (and
 * `toJSON`) from every object it deserializes, so a path-keyed map would silently lose those
 * files in RPC transit. Gadget ids are safe as keys precisely because the canonical-decimal
 * rule excludes every such name.
 */
export type CodeChange = {
  [key: string]: [string, FileChange][];
};

/**
 * One client code-change submission (see Overseer.submitCodeChange() for the full validation and
 * retry contract).
 */
export type CodeChangeSubmission = {
  /** The change itself. */
  change: CodeChange;
  /**
   * Identifies the client's editing session: a client-generated random token (e.g. a UUID),
   * minted fresh each time the client builds or rebuilds its local editing state and never
   * shared between concurrent sessions (two tabs are two clients). Together with `seq` this
   * makes submissions idempotent: the server remembers each session's last accepted submission
   * and recognizes retries. Sessions are scoped to the authenticated user, so the token only
   * needs to be unique among that user's own sessions. See Overseer.submitCodeChange() for the full
   * contract.
   */
  clientId: string;
  /**
   * The generation of the chat's change stream the submission is rooted in (see
   * ChatCodeBase.generation).
   */
  generation: number;
  /**
   * Pin declarations, one per permanent gadget this change touches that is not yet pinned in the
   * chat (a gadget still pending in the chat is never pinned or declared), and one per worktree
   * it touches that is not yet pinned -- pending or not, since a worktree's content is its
   * accepted commit's tree, never built up from nothing. The same shape is what the chat log
   * keeps permanently; see Overseer.submitCodeChange() for the validation rules.
   */
  pins?: ChatGadgetPin[];
  /**
   * The revision within `generation` the change is expressed against: the submitter has applied
   * every accepted change up to and including this revision (0 = none). The server transforms the
   * change over any changes accepted since.
   */
  revision: number;
  /**
   * This submission's sequence number within the client session, starting at 1 and incrementing
   * by 1 per change. Retry a transport failure with the same seq and an identical payload -- never
   * renumber or re-compose a submitted change; the server rejects a reused seq whose content
   * differs. Because the server remembers only the last accepted seq per session, at most one
   * submission may be in flight at a time (see Overseer.submitCodeChange()).
   */
  seq: number;
};

/** Information about a single collaborator, returned by list/add operations. */
export type CollaboratorInfo = {
  addedBy: PermissionEdge[];
  profile: AiChatAuthorInfo;
  /**
   * The collaborator's effective role (the maximum role reachable from the owner). Absent implies
   * "build" for backwards compatibility.
   */
  role?: CollaboratorRole;
};

/**
 * The level of access a collaborator (or share key) grants.
 *
 * - "build": full access -- edit code, use and participate in chats, manage bindings, etc. (the
 *   same access the owner has, modulo the owner-only exceptions documented in sharing.md).
 * - "use": may only render, interact with, and export the gadget's deployed UI (getUiBundle(),
 *   connectToGadget(), getExportFormats(), and export()), plus read basic metadata.
 *
 * Roles are ordered build > use. A collaborator's effective role is the maximum role reachable
 * from the owner through their valid permission edges, where each edge grants
 * min(edge role, sharer's effective role). The owner is the implicit root at "build".
 */
export type CollaboratorRole = "build" | "use";

/**
 * A git author/committer identity, as recorded in commits in a workspace's git object store.
 * Derived from the committing user's profile: the display name becomes `name` and the profile ID
 * the `email` (profile IDs that aren't email addresses get an `@localhost` placeholder appended).
 */
export type CommitIdentity = {
  /** Email address, e.g. "kenton@cloudflare.com" or "kenton@localhost". */
  email: string;
  /** Human-readable name, e.g. "Kenton Varda". */
  name: string;
};

/**
 * Metadata of one commit in a workspace's git object store, as returned by
 * Overseer.getCommitLog(). Commits are immutable, so results may be cached by oid.
 */
export type CommitInfo = {
  /** The commit author. */
  author: CommitIdentity;
  /** The commit message, as stored (git normalization gives it a trailing newline). */
  message: string;
  /** The commit's oid (40-hex SHA-1), as found in e.g. WorkpieceSummary.commitId. */
  oid: string;
  /** Parent commit oids; empty for a root commit. */
  parents: string[];
  /** The author timestamp. */
  timestamp: Date;
};

/**
 * How a connect, reconnect, ensure-resources or sign-in flow starts, as returned by
 * `AuthenticatedApi.connectAccount()` and its siblings. `url` is the gatekeeper's flow URL, which
 * the Workshop opens as a disowned popup. `nonce` is a 64-lowercase-hex secret minted for this
 * flow, which the Workshop writes into that popup's own sessionStorage before navigating it and
 * nowhere else: sessionStorage is per top-level browsing context and per origin, so it survives the
 * trip through the gatekeeper and the provider and is readable again once the popup is back on the
 * Workshop's origin. When the flow finishes, the popup lands on the Workshop's /connect/handoff
 * page, which presents the ticket from its URL fragment together with the nonce
 * (`AuthenticatedApi.completeConnectHandoff()` / `PublicApi.confirmLogin()`). A handoff page opened
 * any other way holds no nonce and redeems nothing. The nonce is single-use and dies with the flow:
 * a connect's after CONNECT_FLOW_LIFETIME_MS (30 minutes, server-side), a sign-in's with its
 * `PendingLogin` attempt.
 */
export type ConnectFlowStart = {
  nonce: string;
  url: string;
};

/** Options for subscribing to connected accounts. */
export type ConnectedAccountsFilter = {
  /** Ensure and include auto-provisioned accounts forced by deployment policy. */
  includeForcedAutoProvisionedAccounts?: boolean;
  /** Filter for vendors that can connect to the given resource. */
  resourceUrl?: string;
};

/** One console call made by a gadget's code. */
export type ConsoleLogEvent = {
  level: "debug" | "error" | "info" | "log" | "warn";
  /**
   * The parameters that were passed to the log function, represented as an array of serializable
   * values.
   */
  message: unknown[];
  timestamp: Date;
};

/** How the approver of a creation (see ActionLogEntry.creation) chose to make it. */
export type CreationApproval = {
  /** The approver's connected account, for the gatekeeper's vendor, to create the resource in. */
  accountId: number;
  /**
   * What the approver chose in that account's creation configurator (see
   * AuthenticatedApi.startCreationConfigurator()): a vendor-defined URL only the gatekeeper reads.
   * Omitted when they made no choice, as for a type without one.
   */
  configuration?: string;
};

/**
 * Whether a newer release is available for a deployment the deploy flow installed, returned by
 * AdminApi.getUpdateStatus(). The check fields describe the last successful update check made for
 * the release this backend runs: until one succeeds, `latestReleaseId`, `availableSince` and
 * `checkedAt` are absent and `updateAvailable` is false.
 */
export type DeploymentUpdateStatus = {
  /**
   * When the first release newer than `currentReleaseId` was published. Absent unless
   * `updateAvailable`.
   */
  availableSince?: Date;
  /**
   * The deployment's check interval: how many minutes a successful check is relied on before the
   * deployment asks again (see AdminApi.setUpdateCheckIntervalMinutes).
   */
  checkIntervalMinutes: number;
  /** When the last successful check for `currentReleaseId` was made. */
  checkedAt?: Date;
  /**
   * Whether the deployment checks for updates by itself (see AdminApi.setUpdateChecksEnabled).
   * When false, `notify` is false and only AdminApi.checkForUpdates() asks for the newest release.
   */
  checksEnabled: boolean;
  /** The release this backend runs. */
  currentReleaseId: string;
  /** The newest release the last successful check for `currentReleaseId` reported. */
  latestReleaseId?: string;
  /**
   * The deployment's minimum age: how many hours a newer release must have been available before
   * `notify` is true (see AdminApi.setUpdateMinimumAgeHours).
   */
  minimumAgeHours: number;
  /**
   * Whether this deployment's running code differs from what the deploy flow installed: true
   * exactly when `modifiedWorkers` is non-empty. The deploy flow refuses to upgrade a modified
   * deployment.
   */
  modified: boolean;
  /**
   * The Workers whose running version is neither this installation's current one nor another
   * release of it: they have no version tag, or one the deploy flow did not write for this
   * installation. Each is "backend", "router", or a gatekeeper's install slug. A Worker that did
   * not report its version is in neither this list nor `unfinishedWorkers`.
   */
  modifiedWorkers: string[];
  /**
   * The deployment's notice snooze: how many hours a browser hides the notice after an admin
   * dismisses it there (see AdminApi.setUpdateNoticeSnoozeHours).
   */
  noticeSnoozeHours: number;
  /**
   * Whether the home page should show admins the update notice now, before the browser applies
   * its own dismissal (see `noticeSnoozeHours`). True exactly when `checksEnabled`, the check says
   * `updateAvailable`, the deployment is not `modified`, and `availableSince` is at least
   * `minimumAgeHours` ago.
   */
  notify: boolean;
  /**
   * The Workers still running another release of this installation: an update that did not
   * finish, which the deploy flow can finish once no Worker is modified. Named as in
   * `modifiedWorkers`. Unlike those, they do not affect `notify`.
   */
  unfinishedWorkers: string[];
  /** Whether that check said a release newer than `currentReleaseId` exists. */
  updateAvailable: boolean;
  /** The opaque link that opens the deploy flow for this installation. */
  updateUrl: string;
};

/** Routing identity and one-use proof posted by the authenticated browser to redeem a transfer. */
export type DeviceSessionHandoffStart = {
  /** Single-use 256-bit secret in lowercase hex; only its hash is stored server-side. */
  ticket: string;
  /** Durable Object identifier for the staging user; this value is not secret. */
  userDoId: string;
};

/**
 * One file's content at a commit, as returned by Overseer.readFilesAtCommit(). `text` carries
 * the file's UTF-8 content; `absent` means the path names no entry at that commit (or names a
 * directory); `unreadable` means the entry exists but cannot be presented as text -- a symlink,
 * a submodule, binary content, or a blob over the git store's per-object size cap -- and carries
 * a descriptive, path-flavored message suitable for display in place of the file.
 */
export type FileAtCommit = {
  kind: "absent";
} | {
  kind: "text";
  text: string;
} | {
  kind: "unreadable";
  message: string;
};

/**
 * One file's part of a `CodeChange`. A file is text, a byte postimage, or absent. Exactly one
 * variant applies; byte operations never reinterpret text's UTF-16 coordinates:
 * - `{edit}`: transform the existing text (invalid if the file is absent, or if its length
 *   doesn't match the change's before-length);
 * - `{set}`: create the file or wholesale-replace its content -- valid against any state,
 *   including absent;
 * - `{remove}`: delete the file. Valid against any state (deleting an absent file is a no-op),
 *   which keeps `remove` composable and transformable without knowing the base.
 * - `{setBytes}`: create/replace with an immutable byte postimage, against any state;
 */
export type FileChange = {
  edit: (number | [number, ...string[]])[];
} | {
  remove: true;
} | {
  set: string;
} | {
  setBytes: BytesRef;
};

/**
 * Information about one of a gadget's bindings, for display in the Connections tab. Returned by
 * GadgetClient.listBindings().
 */
export type GadgetBindingInfo = {
  /**
   * If present, this binding is still provisional to the given chat (which is necessarily the
   * `chatId` passed to listBindings(); edges pending in other chats are never listed). It becomes
   * permanent when the user accepts that chat's changes through the message that recorded it, and
   * is deleted if those changes are reverted.
   */
  chatId?: number;
  /** The binding name, as it appears in the gadget worker's `env`. */
  name: string;
  /** Denormalized display info about the target. */
  resourceTitle: string;
  /** The workpiece that the binding points at. */
  target: number;
  vendorId?: string;
};

/** Describes a file export format supported by a Gadget. */
export type GadgetExportFormat = {
  /** Media type of the exported file. */
  contentType: string;
  /** File extension, including the leading dot. */
  fileExtension: string;
  /** Suggested download filename, including its extension. Defaults to the Gadget title plus fileExtension when unset. */
  fileName?: string;
  /** Unique, non-empty identifier for this format. */
  id: string;
  /** User-facing label for the format. */
  label: string;
  /** Whether the Workshop captures a browser or invokes a server-side handler. */
  mode: "browser" | "server";
};

/** The WorkpieceSummary of a gadget: an app built from code, with a committed mainline head. */
export type GadgetSummary = {
  /**
   * If present, this workpiece exists only in the context of the given chat. The UI should display
   * it only while the given chat is open.
   *
   * For gadgets, this means the gadget is still provisional: it becomes permanent when the user
   * accepts the chat's changes through its creation message, and is deleted if those changes are
   * reverted (or the chat is deleted).
   */
  chatId?: number;
  /**
   * The gadget's head commit (40-hex hash) in the workspace's git object store -- i.e. its
   * committed mainline code, readable via Overseer.listTree() / readFilesAtCommit() /
   * getCommitLog(). Advances when a chat's changes are accepted; subscribeToWorkpieces()
   * delivers a fresh entry() whenever it does. Absent only while the gadget is still pending in
   * a chat (see `chatId`): every permanent gadget has a head, even before it has any code (an
   * empty initial commit), so a chat's first edit always has a commit to pin (see ChatGadgetPin).
   */
  commitId?: string;
  id: number;
  /**
   * The format this workpiece was built as, inherited from the blueprint it was instantiated
   * from. Absent means a generic app. The UI names and draws the workpiece from this.
   */
  output?: BlueprintOutput;
  /** Display title: the gadget's user-renamable title. */
  title: string;
  type: "gadget";
  /**
   * Where this gadget's code came from: the blueprint it follows, or that it was built from
   * scratch (see GadgetUpstream). Absent if that is not known, as for a gadget made before it
   * was recorded. Delivered only to subscribers with the "build" role: a blueprint id is a share
   * link to the blueprint's code, which a "use" collaborator cannot otherwise read.
   */
  upstream?: GadgetUpstream;
};

/**
 * The blueprint a gadget follows: the one it takes updates from, and how much of it the gadget
 * already has. An update is available when the blueprint names a current release
 * (`BlueprintMetadata.commitId`, from `PublicApi.getBlueprint()`) other than a known `commitId`.
 *
 * A gadget built from scratch in its workspace follows no blueprint, and its upstream says so
 * by naming none. That differs from a gadget with no upstream at all, whose origin is unknown.
 */
export type GadgetUpstream = {
  /**
   * The blueprint's id. Absent if the gadget was built from scratch: there is then no blueprint
   * to offer it updates from, and no `commitId` either. GadgetClient.applyBlueprint() treats
   * such a gadget like one of unknown origin, and gives it a blueprint to follow if its
   * proposal is accepted.
   */
  blueprintId?: string;
  /**
   * The release of that blueprint the gadget most recently merged: a release commit, and an
   * ancestor of the gadget's head. For a blueprint stored before releases were commits, it is
   * the commit that everyone who reads that content derives from its files.
   *
   * Absent if the gadget was created from the blueprint before gadgets recorded the release
   * they took. Which release that was is then unknown: whether an update is available cannot
   * be told, and applying the blueprint merges over a guessed base (see
   * BlueprintMerge.unverifiedBase), as for a gadget that follows no blueprint. Accepting that
   * proposal records the release.
   */
  commitId?: string;
};

/** Describes a gatekeeper's management app, for the Workshop nav + page. */
export type GatekeeperAppInfo = {
  /** Optional icon. */
  icon?: AvatarImage;
  /**
   * The vendor id (the GATEKEEPER_<ID> binding suffix, lowercased), used as the URL slug at
   * /gatekeepers/$id. This is the vendor, not a specific account: it assumes one management-UI
   * account per vendor per user, which holds for today's auto-provisioned singletons.
   */
  id: string;
  /** Title for the nav entry / page header. */
  title: string;
};

/**
 * Describes how a gatekeeper was originally created. Stored on each GatekeeperRecord so that
 * bindings can be recreated and blueprint metadata can be derived.
 */
export type GatekeeperCreationSpec = {
  accountId: number;
  /**
   * A singleton gatekeeper account (e.g. the Context Library) auto-provided to every gadget as an
   * unnamed capsule so the agent can read/search it in code. Not user-configured, so excluded from
   * blueprints; re-added automatically if missing.
   */
  type: "ambient";
  vendorId: string;
} | {
  /**
   * The spawner's config, less `env`: its bindings change after creation, so they are binding
   * edges of the spawner instead, added with the agent's setGadgetBinding tool.
   */
  config: {
    /** Display name for the binding, shown in the binding list. */
    displayName: string;
    /**
     * Model ID to run, of the gadget owner's available models. Can be `null` to just create a chat
     * that doesn't actually run an agent -- the prompt, or the calls made on a callable agent, are
     * appended to the chat for a human to pick up.
     */
    modelId: null | string;
  };
  modelName?: string;
  /**
   * Denormalized from the creating user's model config at binding creation time.
   * Absent when config.modelId is null. Used to populate blueprint suggestedModel
   * without requiring a live lookup.
   */
  modelProvider?: string;
  type: "agentSpawner";
} | {
  modelId: string;
  modelName: string;
  provider: string;
  type: "aiModel";
} | {
  resourceUrl?: string;
  type: "gatekeeper";
  typeUrlPattern: string;
  vendorId: string;
};

/**
 * A self-contained sandboxed UI served by a gatekeeper: complete HTML hosted in a
 * sandbox="allow-scripts" iframe, plus an arbitrary gatekeeper-defined capability exposed to the
 * iframe over a MessagePort RPC session. Used both for the small resource-configurator form
 * (startResourceConfigurator, hosted in the connect modal) and for full-page gatekeeper management
 * apps (startAppUi, e.g. the Context Library file manager, hosted on its own Workshop page).
 */
export type GatekeeperUiFrame = {
  /** Complete HTML for the UI. Workshop hosts it in a sandboxed iframe. */
  iframeHtml: string;
  /**
   * Capability exposed to the iframe for any RPCs needed by the UI. A gatekeeper app's (see
   * AuthenticatedApi.getGatekeeperApp()) implements the interface its package.json names as
   * `cloudflareOs.appApi`; a configurator's, that vendor's `*ConfiguratorUI` class in
   * `packages/gatekeeper-<vendor>/src/`, which helps look up what fills the URL the configurator
   * yields: for a resource configurator, the resource URL Overseer.newGatekeeper() takes (see
   * AuthenticatedApi.startResourceConfigurator()); for a creation configurator, the
   * CreationApproval.configuration Overseer.approveAction() takes (see
   * AuthenticatedApi.startCreationConfigurator()).
   */
  ui: UntypedStub;
};

/**
 * Presentation-only snapshot of a Workshop user. Carries no authority and
 * should not be used as an identity: it is not unique, not verified, and can
 * change from one snapshot to the next.
 */
export type GatekeeperUserProfileSnapshot = {
  /** The user's Workshop display name at the time of the snapshot. */
  displayName: string;
};

/**
 * One user selected in the Workshop-owned user picker, as delivered to the
 * gatekeeper's management UI (see GatekeeperUserSelectionReceiver). The
 * Workshop hands this to the iframe, not to the gatekeeper's server: the UI
 * decides whether to send the ticket to its backend right away or to hold it in
 * local form state and submit it later (within the ticket's lifetime).
 */
export type GatekeeperUserSelection = {
  /**
   * Snapshot for rendering the selected user immediately; see
   * GatekeeperUserProfileSnapshot.
   */
  profile: GatekeeperUserProfileSnapshot;
  /**
   * Opaque, single-use ticket for the selected user. It conveys nothing on its
   * own and can only be redeemed through the `GatekeeperUserSelectionExchange`
   * capability provided by the Workshop.
   */
  ticket: string;
};

/**
 * When listing gatekeeper vendors or connected accounts, you can filter to only vendors/accounts
 * that support certain features. This type specifies the filter.
 */
export type GatekeeperVendorFilter = {
  /** Filter for vendors that can connect to the given resource. */
  resourceUrl?: string;
};

/**
 * A connectable third-party service: its vendor id, display metadata, and the resource types it
 * offers (empty for an auto-provisioning gatekeeper like the Context Library). Returned by both
 * listGatekeeperVendors and listAddableGatekeepers so the connect UI treats both uniformly.
 */
export type GatekeeperVendorInfo = {
  description: VendorDescription;
  id: string;
  supportedResources: SupportedResource[];
  /**
   * Present when a bound gatekeeper could not be queried. UIs should surface this to the user but
   * not offer it as connectable.
   */
  unavailable?: boolean;
};

/**
 * The description of a model a deployment provides through AI Gateway. Its admin supplies one to
 * add a model beside the SUGGESTED_MODELS of the providers the gateway enables.
 */
export type GatewayModel = {
  /**
   * The ID of a model of the same provider that the model runtime knows. While the runtime has
   * no entry for this model's own ID, the model borrows that one's runtime flags: its request
   * formats and, for what `capabilities` leaves unstated, its reasoning levels and the kinds of
   * input it takes. Its name, limits and cost stay its own.
   */
  behavesLike?: string;
  /**
   * What the model is stated to do. Used only while the runtime has no entry for this model's
   * own ID, where each stated fact comes ahead of what `behavesLike` lends.
   */
  capabilities?: GatewayModelCapabilities;
  /** The maximum tokens one request may total. */
  contextWindow: number;
  /**
   * Name of the model as specified to the provider's API, which is also the ID chats and
   * preferences refer to it by.
   */
  id: string;
  /** Display name. */
  name: string;
  /** When present, both the requested response cap and the space reserved for it. */
  outputLimit?: number;
  /** Which AI provider hosts the model. */
  provider: AiModelProvider;
};

/**
 * What a deployment's admin states that a model it adds can do. Nothing checks a stated fact
 * against the provider: requests are built from it as it stands.
 */
export type GatewayModelCapabilities = {
  /** Whether the model takes images as input, beside text. Absent while not stated. */
  imageInput?: boolean;
  /**
   * The reasoning levels the model can be sent. A list with no level above 'off' states a model
   * that does no reasoning. Absent while not stated.
   */
  reasoningLevels?: ("high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh")[];
};

/**
 * One request of AdminApi.testNewGatewayModel(): its result, and the reasoning level it asked
 * for. Null is the request sent with no level set.
 */
export type GatewayModelLevelTest = {
  message: string;
  model: string;
  ok: false;
  reasoning: "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh" | null;
  status?: number;
} | {
  model: string;
  ok: true;
  reasoning: "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh" | null;
};

/**
 * What a deployment's admin sets for one of its AI Gateway models. A field left out is unset: the
 * model then has its built-in behaviour, or for `reasoning` the deployment's default level where
 * one is set.
 */
export type GatewayModelSettings = {
  /**
   * The prompt budget, in tokens, that a chat on the model compacts against (see
   * COMPACTION_TRIGGER_RATIO), in place of the model's built-in one. A positive whole number, at
   * most the model's AdminModelView.maxCompactionInputBudget.
   */
  compactionInputBudget?: number;
  /**
   * The reasoning level of the agent's turns on the model, ahead of the deployment's default
   * (see AdminApi.setDefaultReasoning). One-shot calls, such as titles, compaction summaries
   * and gadget model bindings, ask for none either way.
   */
  reasoning?: "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh";
};

/**
 * What one request of AdminApi.testGatewayProvider(), AdminApi.testGatewayModel() or
 * AdminApi.testNewGatewayModel() found: the model asked, and whether it answered. A failure
 * carries a message on one line, cut short: what the provider or the gateway answered, or why no
 * answer came. It carries the HTTP status of the response only when the model runtime reports
 * one, which it does not for every provider (a failed Google request has none): the message then
 * says what there is.
 */
export type GatewayModelTest = {
  message: string;
  model: string;
  ok: false;
  status?: number;
} | {
  model: string;
  ok: true;
};

/**
 * Describes a registered hook, for display purposes (e.g. so the user can see what hooks are
 * registered and choose whether to enable / disable a hook).
 */
export type HookDescription = {
  description: string;
  title: string;
};

/** The result of `AuthenticatedApi.listOutputs()`. */
export type ListOutputsResult = {
  /**
   * Set while workspaces predating the index are still being swept into it, which happens once per
   * user after a deployment upgrades. Each call sweeps a bounded number of them, so a caller that
   * wants the rest calls again until this is false.
   *
   * False means stop asking, not that the index is complete. A workspace that couldn't be reached
   * is passed over rather than retried forever, and a sweep that reached none of them gives up for
   * now instead of spinning. Either way the gap closes when the workspace is next opened, and the
   * next call to this method resumes any sweep that was left unfinished.
   */
  catchingUp: boolean;
  /** Every output indexed so far. */
  outputs: OutputSummary[];
};

/**
 * One gadget's part of an update from mainline (see AiChatMessageBody.mainlineMerge): the three
 * sides of its merge, as commits, and what did not merge cleanly. The other two sides are on
 * the message's pin declaration for the gadget: its `mergedCommit` is the head that was
 * merged, and its `baseCommit` the merge commit, whose parents are that head and
 * `chatCommit`. Where the chat had nothing of its own to merge, no merge commit was written,
 * and the declaration's `baseCommit` is the head itself.
 */
export type MainlineMergeGadget = {
  /**
   * The base of the merge: the mainline commit the chat had last merged for this gadget, which
   * is the pin's ChatGadgetPinState.mergedCommit as it was before the update. A revert of the
   * update puts the pin's `mergedCommit` back to this.
   */
  baseCommit: string;
  /**
   * A commit of the chat's files for the gadget as they were before the update. Its parent is
   * the pin's `baseCommit` as it was then, the commit the chat's changes were made on; where the
   * files were that commit's own, it is that commit.
   */
  chatCommit: string;
  /**
   * The files whose merge was not clean, as paths within the gadget, in sorted order (see
   * BlueprintMerge.conflictPaths).
   */
  conflictPaths: string[];
  /** The pinned gadget that was brought up to date. */
  gadgetId: number;
};

/**
 * Result of Overseer.mergeChanges(). A stale chat is an expected outcome of the accept flow --
 * someone else's accept can land at any time -- so it is reported as a value for ordinary
 * control flow, not thrown as an error.
 */
export type MergeChangesResult = {
  /**
   * "merged": the changes were accepted; every touched gadget's head fast-forwarded (also the
   * outcome when there was nothing to merge). "stale": nothing was merged -- mainline advanced
   * past one of the chat's pins, so the accept could not fast-forward; call
   * updateChatFromMainline(), resolve any conflicts, and retry.
   */
  outcome: "merged" | "stale";
};

/**
 * A standard output format named inline in a chat message, recorded so the message can be redrawn
 * the way it was composed. Display only: the agent reads the noun as ordinary text and resolves it
 * against the deployment's live catalog, so no blueprint id is carried here.
 *
 * Shaped like `CapsuleSpecifier`, but carries no authority: naming a format grants nothing, so
 * there is no workpiece behind it.
 */
export type MessageFormatRef = {
  icon: "appWindow" | "chartBar" | "fileText" | "flowArrow" | "gridNine" | "kanban" | "listChecks" | "notebook" | "presentation" | "table";
  length: number;
  /** Denormalized so an old message still displays after the format is renamed or un-promoted. */
  noun: string;
  /**
   * Position and length of the format's name within the message text. Exists so we can render as
   * format with icon in chat UI.
   */
  position: number;
};

/**
 * What a model does, which decides where it can be used. A `"language"` model writes text: it can
 * chat and back a `LanguageModelBinding`. A `"decision"` model answers typed questions with
 * probabilities: gadgets can bind it as a `DecisionModelBinding`, but it can't chat.
 */
export type ModelKind = "decision" | "language";

/** How long a workspace's notifications stay muted: until a time, or until the user unmutes it. */
export type NotificationMute = {
  indefinite: true;
  until?: undefined;
} | {
  indefinite?: undefined;
  until: Date;
};

/** What a gadget is about to read from an external service, for `authorizeObservation()`. */
export type ObservationDescription = {
  /**
   * If true, then this observation contains sensitive information that must only be shown to
   * people who are verified to have access to the same data. This means:
   * - Every collaborator must pass this gatekeeper's `addObserver()` to open the gadget, so a
   *   gatekeeper whose `addObserver()` always throws makes the gadget effectively unshareable
   *   once it has made one of these observations.
   * - Once observed, the gadget enters a restricted mode: no public-web fetches, and every action
   *   requires manual approval -- auto-approval rules are suspended. The approver is shown the
   *   action's full `description` and is responsible for checking it contains none of the
   *   restricted data. An action whose description is not complete
   *   (`ActionDescription.descriptionIsComplete`) is accepted and flagged to the approver; only
   *   git pushes are refused. The kernel does not restrict which connections may be acted on.
   *
   * TODO(someday): The restricted mode is a blunt instrument. It should be possible to perform
   *   actions whose visibility is limited to people verified to have access to the same data: an
   *   action should declare who can see its effects, and each restricted producer verify that
   *   every such person can already see the data.
   */
  containsRestrictedData?: boolean;
  /**
   * A complete description of the action to be taken, in Markdown-formatted natural language.
   * This will be displayed to the approver. It must include all details that might be relevant to
   * consider before approving.
   */
  description: string;
  /**
   * If present, then this observation includes data that must not be revealed to the given
   * observer IDs, who were previously added via `Gatekeeper.addObserver()`.
   *
   * If the call to authorizeObservation() succeeds, then the overseer is promising to ensure that
   * these users will not see this observation. How it does this is up to the overseer, but in
   * practice it may be one of:
   * - The user had already been removed.
   * - The overseer revoked the user's access synchronously (however, in practice, we don't do
   *   this, because it would be weird UX).
   * - The observation occurred in a specific agent thread, and the overseer can prevent the
   *   observer from viewing that thread.
   *
   * If authorizeObservation() throws, then the gatekeeper should allow the exception to propagate
   * out to the caller, blocking the observation from taking place at all. The overseer will
   * throw in cases where it would not otherwise be able to prevent the given observer from seeing
   * the observation.
   */
  excludeObservers?: string[];
  /** Values shown literally after `description`, as in `ActionDescription.fields`. */
  fields?: ActionField[];
  /**
   * If true, then once any observation carrying this flag is authorized, only collaborators the
   * owner added directly keep access: share links stop granting anything (none can be created,
   * copied, or redeemed), and people who joined through a link or through another collaborator
   * lose access, restarting the gadget if any are present. After that, only the owner can add
   * collaborators, one at a time. Those who remain are still subject to `addObserver()`
   * verification on every open.
   *
   * Typically paired with `containsRestrictedData`, for data sources whose own sharing model
   * requires each recipient to be granted access individually.
   */
  ownerInvitesOnly?: boolean;
  /** Brief one-line summary of the observation, like an email subject line, to display in a list. */
  title: string;
};

/**
 * The opening user's chosen account for a single gatekeeper binding. Returned from
 * ObserverConfigCallback.configure().
 */
export type ObserverAccountChoice = {
  /** An account in the opening user's own User DO (a ConnectedAccountRecord id). */
  accountId: number;
  /** Matches the ObserverBindingNeed.gatekeeperId being satisfied. */
  gatekeeperId: number;
};

/**
 * Why a previously-configured observer binding failed verification on this open attempt. Attached to
 * the ObserverBindingNeed the overseer re-prompts with, so the client can explain what went wrong
 * instead of dead-ending the open.
 */
export type ObserverBindingFailure = {
  /**
   * The account that was tried and rejected (a ConnectedAccountRecord id in the opening user's own
   * User DO). Re-authenticating it in place is usually the fix, so the client should pre-select it
   * and aim its re-authenticate affordance at it. May no longer exist, if the user disconnected it.
   */
  accountId: number;
  /**
   * Human-readable explanation for display: either the error the gatekeeper threw when it refused
   * the account, or a message the overseer authored itself for a cause it can see directly (e.g.
   * the chosen account is no longer connected). Free text: MUST NOT be parsed or matched on.
   */
  reason: string;
};

/**
 * Describes one connection a non-owner must verify using one of their own accounts. Passed to
 * ObserverConfigCallback.configure() when the opening user needs to choose an account; its result
 * echoes `gatekeeperId` in an ObserverAccountChoice.
 */
export type ObserverBindingNeed = {
  /**
   * Set only when this binding was already configured but its chosen account failed verification on
   * this attempt (expired credentials, a revoked grant, an upstream outage, or a genuine denial).
   * Absent for a binding that has simply never been configured. Deliberately carries no
   * "credentials valid" flag: the client already has that live from subscribeConnectedAccounts, and
   * a copy on the wire would go stale while the modal is open across an OAuth round trip.
   */
  failure?: ObserverBindingFailure;
  /** The overseer-assigned gatekeeper id (a workpiece id). */
  gatekeeperId: number;
  /** Human-readable resource title, for display in the configuration modal. */
  resourceTitle: string;
  /** Canonical resource URL, if known, for display. */
  resourceUrl?: string;
  /**
   * The vendor the user must have a connected account for (e.g. "google"). The frontend filters
   * the user's connected accounts by this to find candidates.
   */
  vendorId: string;
};

/**
 * One entry of the "New ..." menu, as returned by `listOutputFormats()`. This names a blueprint the
 * deployment has promoted, instantiated with `newWorkspaceFromBlueprint(blueprintId, ...)` like any
 * other.
 */
export type OutputFormatOffer = {
  blueprintId: string;
  /** The blueprint's description. */
  description: string;
  /**
   * How to name and draw it: the blueprint's own declaration with any deployment override
   * applied. Also what the created gadget inherits.
   */
  output: BlueprintOutput;
  /** The blueprint needs bindings wired up before it can run. */
  requiresSetup: boolean;
};

/**
 * One entry in the user's output index: something a workspace produced that the user can open
 * directly.
 */
export type OutputSummary = {
  created: Date;
  /**
   * When the containing workspace was last active. Outputs have no activity timestamp of their
   * own yet, so all outputs of a workspace share this value.
   */
  lastActive: Date;
  /**
   * The format this output was built as, if it came from a blueprint declaring one. Absent for a
   * gadget built from scratch, which displays as a generic app.
   */
  output?: BlueprintOutput;
  /**
   * Set when the containing workspace is owned by someone else (i.e. it was shared with the
   * caller).
   */
  owner?: AiChatAuthorInfo;
  /**
   * The caller's role, cached on their last open and refreshed when a revocation downgrades them,
   * so a listing can offer only the actions it permits; the workspace still authorizes each one
   * when attempted. Absent for the caller's own workspaces, and for a shared one whose last open
   * predates this field.
   */
  role?: CollaboratorRole;
  title: string;
  /**
   * The workpiece within that workspace. `(workspaceId, workpieceId)` uniquely identifies an
   * output.
   */
  workpieceId: number;
  /** The workspace that contains this output (an `openWorkspace()` id). */
  workspaceId: string;
  workspaceTitle: string;
};

/** Describes how one user came to have collaborator access. */
export type PermissionEdge = {
  created: Date;
  /**
   * The id of the share link that was redeemed (the hash of its first key). Every key of the link
   * resolves to this id, so redeeming any of them yields this one edge.
   */
  keyId: string;
  /**
   * The role granted by this edge. Absent on edges created before roles were introduced; such
   * edges are treated as "build" for backwards compatibility.
   */
  role?: CollaboratorRole;
  /** Gained by redeeming a share key. */
  type: "shareKey";
} | {
  created: Date;
  note?: string;
  /**
   * The role granted by this edge. Absent on edges created before roles were introduced; such
   * edges are treated as "build" for backwards compatibility.
   */
  role?: CollaboratorRole;
  sharer: string;
  /** Granted directly by another user. */
  type: "user";
};

/**
 * An auto-approvable action kind offered by a specific connection. Aggregated from each bound
 * gatekeeper's getAutoApprovableActions(); `alreadyEnabled` reports whether a matching rule exists.
 */
export type PreApprovableAction = {
  actionKind: ActionKind;
  alreadyEnabled: boolean;
  gatekeeperId: number;
  resourceTitle: string;
  /** Vendor of the gatekeeper holding this connection. Absent for vendorless gatekeepers. */
  vendorId?: string;
};

/** One person currently connected to a gadget. */
export type PresenceParticipant = {
  /** Opaque key matching this participant across add/remove events. */
  key: string;
  role: CollaboratorRole;
  user: AiChatAuthorInfo;
};

/**
 * An `AiModelConfig` whose secrets may be withheld, so that a stored configuration can be shown
 * and edited without the client ever receiving its secrets. As returned by
 * `AuthenticatedApi.getModelConfig()`, a `null` secret is a non-empty value that was withheld. As
 * passed to `AuthenticatedApi.updateModel()` or `addModel()`, a `null` secret keeps (or copies)
 * the stored value. It has none of the fields that only a deployment sets on its own models.
 */
export type RedactedAiModelConfig = {
  /**
   * Cloudflare account ID owning the Workers AI deployment the token authorizes. Required for
   * provider "cloudflare" (whose REST endpoint is account-scoped); unused for other providers.
   */
  accountId?: string;
  /**
   * `AiModelConfig.apiToken`, or null if withheld.
   * @secret
   */
  apiToken: null | string;
  /**
   * URL of the API. If not specified, use the default for the provider. Overriding the URL is
   * useful in order to use AI proxy products like Cloudflare's AI gateway, or even to use an
   * alternative provider that provides a compatible API.
   */
  apiUrl?: string;
  /**
   * The maximum tokens one request may total, overriding the Workshop's built-in value for this
   * model. Useful for a model the Workshop doesn't know, which is otherwise assumed to be small.
   */
  contextWindow?: number;
  /**
   * `AiModelConfig.extraHeaders`, with each value null if withheld.
   * @secret
   */
  extraHeaders?: {
    [key: string]: null | string;
  };
  /** Name of the specific model, as specified to the provider's API. */
  model: string;
  /**
   * Overrides the built-in response cap for this model. Like `outputLimit` in the suggested-model
   * table, it is both the requested response cap and the space reserved for it in the window.
   */
  outputLimit?: number;
  /** Which AI provider hosts the model? */
  provider: AiModelProvider;
};

/** Describes metadata about a specific instance of a resource. Returned by Gatekeeper.describe(). */
export type ResourceDescription = {
  /** Indicates that getSlashCommandProvider() is available. */
  hasSlashCommands?: true;
  /**
   * Some resources implement the ability for the client to subscribe to events. The application
   * implements a "hook", which is a WorkerEntrypoint that implements the TypeScript interface
   * named by `hookTsType` (which must be one of the exports from `getTypescriptTypes()`).
   */
  hookTsType?: string;
  snippet: string;
  /**
   * When the binding is first created, it will be given this name (but the user can change it).
   * This is just a convenience so that the user doesn't have to type their own name, although
   * they are free to rename it.
   *
   * This name should usually be based on the binding's type, not the specific resource title,
   * since the coding agent will be able to see the name and the user may or may not intend to
   * reveal the resource title to the agent, or may intend the same Gadget to be connected to
   * different resources (of the same type) at different times.
   */
  suggestedBindingName: string;
  /** Metadata for display. */
  title: string;
  /**
   * TypeScript type name. Must be the name of one of the exports returned by this gatekeeper's
   * `getTypeScriptTypes()` method.
   */
  tsType: string;
  /**
   * The resource's canonical URL. This can differ from the one passed to `newGatekeeper()`, if the
   * resource has more than one possible URL. Visiting this URL in a browser should actually open
   * the resource's natural UI.
   */
  url: string;
};

/**
 * Information about a share link, for the management UI. Each link may have one or more keys.
 * When users "copy" an existing link, they are getting a new key.
 */
export type ShareLinkInfo = {
  created: Date;
  createdBy: AiChatAuthorInfo;
  linkId: string;
  note?: string;
  /**
   * The role granted to anyone who redeems this link. Absent implies "build" for links created
   * before roles were introduced.
   */
  role?: CollaboratorRole;
};

/** One slash command as shown in the Workshop picker. */
export type SlashCommandChoice = {
  /** Short description shown in the picker. */
  description: string;
  /** Name shown after `/`. */
  name: string;
  /**
   * Name of the command's provider: the offering Gatekeeper's title, or the Workshop itself for a
   * built-in command.
   */
  providerLabel: string;
  /** Optional resource label used when multiple commands share a name. */
  resourceLabel?: string;
  /** Selection to pass back when invoking this command. */
  selection: SlashCommandId;
};

/** Identifies a Gatekeeper slash command or the built-in `/compact` command. */
export type SlashCommandId = {
  builtin: true;
  commandId: "compact";
} | {
  builtin?: undefined;
  commandId: string;
  gatekeeperId: number;
};

/** A slash command invocation parsed by the client. */
export type SlashCommandRequest = {
  /**
   * Unparsed natural-language arguments surrounding the command, with the command itself removed.
   * The provider may consume or transform these into an agent-visible message.
   */
  args: string;
  /**
   * Index in `args` where the user typed the command, so a transcript can show it where they put it
   * rather than implying it led the line. Display only.
   */
  commandPosition?: number;
  id: SlashCommandId;
};

/**
 * Symbolic target of one agent-spawner env entry in a blueprint. Workpiece IDs are
 * workspace-local, so a spawner's `env` (see AgentSpawnerConfig.env) can't transfer into a
 * blueprint as-is; instead each entry references either one of the blueprint's own bindings by
 * name -- the user fills it at instantiation time like any other binding, and the spawner env
 * entry resolves to the gatekeeper created for it -- or the blueprint's gadget itself, resolving
 * to the newly instantiated gadget.
 */
export type SpawnerEnvTarget = {
  /**
   * Key into BlueprintMetadata.bindings. May reference a binding that is also bound into the
   * gadget, or one synthesized purely to feed this spawner (see BlueprintBinding.spawnerOnly).
   */
  name: string;
  type: "binding";
} | {
  /**
   * This spawner binding refers back to the gadget itself (the one instantiated from the
   * blueprint).
   */
  type: "gadget";
};

/**
 * Describes a kind of resource that a vendor can provide access to (e.g. "Jira Issue", "Gmail
 * Mailbox") rather than a specific instance.
 */
export type SupportedResource = {
  /**
   * If true, an agent may create a new resource of this type with the createExternalResource tool
   * (see GatekeeperVendor.createResource()).
   */
  creatable?: boolean;
  /**
   * With `creatable`: the approver of a creation of this type configures it, in the account they
   * create it in, through that account's GatekeeperUser.startCreationConfigurator(). Callers gate
   * on this flag rather than probing, since RPC stubs cannot report optional-method presence.
   */
  creationConfigurator?: boolean;
  /** Short description of what this resource provides. */
  description: string;
  /**
   * If true, this resource type is independently grantable. The user can enable or disable it at
   * account-connection time, and the Workshop will request only the underlying authorization (e.g.
   * OAuth scopes) needed for the resource types they enable.
   *
   * If omitted/false, the resource type is not separately grantable.
   */
  grantable?: boolean;
  /**
   * The urlPattern of the type whose connect card this type appears on, instead of a card of its
   * own. A card's types share one configurator, which may return a URL of any of them, so
   * startResourceConfigurator must return that configurator for each of them.
   *
   * Each type is still granted separately: holding a grant for one does not cover the others. The
   * configurator offers only the types the account has granted, and the Workshop asks for the rest
   * in a single consent request, so group only types that need the same authorization.
   */
  groupedWith?: string;
  /** Optional icon for display in Workshop UI. */
  icon?: AvatarImage;
  /** Human-readable title for this resource type, e.g. "Jira Issue" */
  title: string;
  /** URLPattern string for matching URLs, e.g. "https://jira.cfdata.org/*" */
  urlPattern: string;
};

/**
 * One entry of a commit's tree, as returned by Overseer.listTree(): a directory carrying its own
 * entries, or a leaf of one of git's four non-directory modes. `name` is a single path segment
 * (never containing `/`); a file's path is the `/`-join of the names down to it. A `symlink` and
 * a `submodule` (gitlink) are listed with their kind and have no readable text (see
 * FileAtCommit). Nested rather than a flat path list so the tree needs one call per commit and
 * no parsing, and each name travels once. Carries no oids or sizes.
 */
export type TreeNode = {
  children: TreeNode[];
  kind: "dir";
  name: string;
} | {
  kind: "executable" | "file" | "submodule" | "symlink";
  name: string;
};

/**
 * Describes the client-side UI code for a Gadget. Such code is intended to run inside an iframe
 * sandbox with no access to the outside world except through an RPC interface to the Workshop
 * and to the Gadget's server.
 */
export type UiBundle = {
  /**
   * Returns the raw JS code to execute in the Gadget iframe.
   * TODO: For now we just return the code but we should switch to serving over HTTP as described
   *   above, for caching. Or... maybe we should actually serve over RPC, but also employ the
   *   Cache API in the browser? Or some other local storage?
   */
  jsCode: string;
};

/** Resolved boolean values for every registered UI feature flag. */
export type UiFeatureFlags = {
  "placeholder-flag": boolean;
};

/**
 * One user as listed in the deployment-wide user directory (see
 * `AuthenticatedApi.searchUsers`).
 */
export type UserDirectoryRecord = {
  /**
   * Canonical user identifier: email for Access / sign-in accounts, username
   * for password accounts.
   */
  id: string;
  /** The user's current display name. */
  name: string;
};

/** A notification delivered to one authenticated user. */
export type UserNotification = {
  /** Chat containing the task. */
  chatId: number;
  /** Current human-readable chat title. */
  chatTitle: string;
  /** Stable identifier shared by the live and push delivery attempts. */
  id: string;
  /** Whether the task finished or is paused on a connection or action-approval prompt. */
  kind: "permissionRequested" | "taskCompleted";
  /** Workspace containing the task. */
  workspaceId: string;
};

/** Describes a connected GatekeeperVendor, for display purposes. */
export type VendorDescription = {
  /**
   * If set, this vendor can mint a connected account with no OAuth flow (see
   * GatekeeperVendor.createAccount) and recommends the Workshop auto-provision one account per user.
   * The account — not the vendor — declares whether it provides an agent singleton and/or a
   * management UI (see AccountDescription.singleton / .providesUi).
   */
  autoProvisionsAccount?: boolean;
  /** Background color used behind the logo in connector UI. */
  color?: string;
  /**
   * 2-3 sentence description of what this Gatekeeper does and enables users to build.
   * This is shown in detail modals on the Connectors page.
   * E.g. "Connect your Google account to give Gadgets access to Gmail, Google Docs, and BigQuery.
   * Build agents that triage email, draft and edit documents, or run analytics queries on your data."
   */
  description?: string;
  /** Human-readable name of the service, e.g. "Google", "GitHub", etc. */
  displayName: string;
  /** Logo for the service. */
  logo?: AvatarImage;
  /**
   * True if this vendor can authenticate a user for sign-in: i.e. its connect flow yields a
   * provider-verified email (via GatekeeperUser.getAuthenticatedEmail()). The Workshop may offer
   * such a vendor as a login method, subject to its own auth allowlist. Defaults to false.
   */
  providesAuth?: boolean;
  /**
   * Short tagline shown beneath the name on cards on the Connectors page.
   * E.g., "Draft replies, edit docs, and analyze data"
   */
  tagline?: string;
  /** URL of the service's home page. */
  url: string;
};

/** A browser's Web Push subscription: the endpoint its push service issued, and the keys that encrypt pushes to it. */
export type WebPushSubscription = {
  /** Push service URL the browser issued for this subscription. */
  endpoint: string;
  /** The browser's encryption keys, base64url-encoded as `PushSubscription.toJSON()` returns them. */
  keys: {
    auth: string;
    p256dh: string;
  };
};

/**
 * Summary of one workpiece, delivered via Overseer.subscribeToWorkpieces(), discriminated by
 * `type`. Gadgets and worktrees are published (gatekeeper workpieces -- chat capsules, ambient
 * singletons, connections -- are not listed). Worktrees are published only to subscriptions that
 * include pending workpieces (build role): like a pending gadget, a worktree belongs to one chat
 * (its `chatId` is always set) and the UI shows it only while that chat is selected.
 */
export type WorkpieceSummary = GadgetSummary | WorktreeSummary;

/**
 * Metadata about a workspace (one Overseer DO and everything in it). Includes everything needed
 * to render the workspace list on the front page.
 */
export type WorkspaceMetadata = {
  /**
   * True when the workspace has observed data marked `containsRestrictedData` (see
   * `ObservationDescription`). It can still be shared, with collaborators verified per
   * gatekeeper (if `ownerInvitesOnly` is also set, only the owner can add them), but can no longer
   * fetch from the public web, and every action requires manual approval.
   */
  containsRestrictedData?: boolean;
  /**
   * Various objects in the API specify a gadgetId, but make the property optional. When omitted,
   * the default gadget ID should be assumed. This is largely for backwards compatibility with
   * records that were stored before workspaces could have multiple gadgets.
   *
   * TODO(multi-gadget): Do a migration to backfill all gadget IDs, then eliminate the concept of
   * a default gadget from the API.
   */
  defaultGadgetId?: number;
  /**
   * Unique ID for this workspace, used with `openWorkspace()`. This is a url-safe base64 value
   * chosen randomly when the workspace is created.
   */
  id: string;
  /** Set while the user has muted this workspace's notifications. */
  notificationMute?: NotificationMute;
  /**
   * Set when the workspace is not owned by the current user. Presence of this field indicates the
   * user is a collaborator, not the owner.
   */
  owner?: AiChatAuthorInfo;
  /**
   * True when the workspace has observed data marked `ownerInvitesOnly` (see
   * `ObservationDescription`). Only collaborators the owner added directly have access: share
   * links can no longer be created, copied, or redeemed, and only the owner can add collaborators.
   */
  ownerInvitesOnly?: boolean;
  /** Whether the user has pinned this workspace to the top of their list. */
  pinned?: boolean;
  /**
   * The viewing user's effective role for this workspace. The owner is always "build". Used by the
   * frontend to decide whether to render the full editor ("build") or the UI-only shell ("use").
   * Absent implies "build" for backwards compatibility.
   */
  role?: CollaboratorRole;
  /**
   * Human-readable workspace title. Can be modified. (Per-gadget titles live on the gadget
   * workpieces themselves; see WorkpieceSummary.)
   */
  title: string;
  /** Total cost of AI inference in dollars, if known. */
  totalCost?: number;
};

/**
 * WorkspaceMetadata extended with timestamps. These are available when listing workspaces from the
 * user's collection (listWorkspaces()), but not from the Overseer (which doesn't track them).
 */
export type WorkspaceMetadataWithTimestamps = {
  /**
   * True when the workspace has observed data marked `containsRestrictedData` (see
   * `ObservationDescription`). It can still be shared, with collaborators verified per
   * gatekeeper (if `ownerInvitesOnly` is also set, only the owner can add them), but can no longer
   * fetch from the public web, and every action requires manual approval.
   */
  containsRestrictedData?: boolean;
  created: Date;
  /**
   * Various objects in the API specify a gadgetId, but make the property optional. When omitted,
   * the default gadget ID should be assumed. This is largely for backwards compatibility with
   * records that were stored before workspaces could have multiple gadgets.
   *
   * TODO(multi-gadget): Do a migration to backfill all gadget IDs, then eliminate the concept of
   * a default gadget from the API.
   */
  defaultGadgetId?: number;
  /**
   * Unique ID for this workspace, used with `openWorkspace()`. This is a url-safe base64 value
   * chosen randomly when the workspace is created.
   */
  id: string;
  lastActive: Date;
  /** Set while the user has muted this workspace's notifications. */
  notificationMute?: NotificationMute;
  /**
   * Set when the workspace is not owned by the current user. Presence of this field indicates the
   * user is a collaborator, not the owner.
   */
  owner?: AiChatAuthorInfo;
  /**
   * True when the workspace has observed data marked `ownerInvitesOnly` (see
   * `ObservationDescription`). Only collaborators the owner added directly have access: share
   * links can no longer be created, copied, or redeemed, and only the owner can add collaborators.
   */
  ownerInvitesOnly?: boolean;
  /** Whether the user has pinned this workspace to the top of their list. */
  pinned?: boolean;
  /**
   * The viewing user's effective role for this workspace. The owner is always "build". Used by the
   * frontend to decide whether to render the full editor ("build") or the UI-only shell ("use").
   * Absent implies "build" for backwards compatibility.
   */
  role?: CollaboratorRole;
  /**
   * Human-readable workspace title. Can be modified. (Per-gadget titles live on the gadget
   * workpieces themselves; see WorkpieceSummary.)
   */
  title: string;
  /** Total cost of AI inference in dollars, if known. */
  totalCost?: number;
};

/**
 * The WorkpieceSummary of a worktree: a checkout of an external git repository that an agent
 * works in (see AiChatMessageBody.createdWorktrees). It has no app and no bindings; the UI shows
 * only its code. Its three commits are the worktree's state as the chat sees it; the OT rows of
 * the chat's current epoch compose on `pinBase`.
 */
export type WorktreeSummary = {
  /** The commit the worktree was created at. Immutable; informational. */
  baseCommit: string;
  /**
   * The chat this worktree belongs to, for its whole life (a worktree is never shared across
   * chats). Always set: the UI displays the worktree only while this chat is selected, as it
   * does a pending gadget, and the worktree is deleted with the chat.
   */
  chatId: number;
  /**
   * The last explicit commit the agent made (initially `baseCommit`): what the worktree's own
   * API reports as HEAD. Header display only -- it plays no role in what the UI shows as changed,
   * which is always relative to `pinBase`. Re-delivered whenever it advances, and rolled back
   * with the changes that advanced it when they are reverted.
   */
  headCommit: string;
  id: number;
  /**
   * The accepted commit (40-hex hash): the worktree's content as of the chat's last accept, and
   * the worktree analog of a gadget's `commitId`. While the worktree is unpinned in its chat, its
   * content reads as this commit's tree (via Overseer.listTree()/readFilesAtCommit()), and a
   * client's pin declaration (CodeChangeSubmission.pins) is accepted iff its `baseCommit` equals
   * this. Advances when the chat's changes are accepted (to the accept's auto-commit of the
   * changed content); subscribeToWorkpieces() delivers a fresh entry() whenever it does.
   */
  pinBase: string;
  /** Display title: the name the worktree was created under. */
  title: string;
  type: "worktree";
};

/**
 * A value, or a promise of it. What a call accepts for a value parameter: Cap'n Web resolves a
 * promise argument before delivering the call, so one call's result is passed to the next without
 * waiting for it, `root.set(root.get())`. And what a function or a method the caller
 * implements may return: its result as is, or from an `async` function.
 */
export type Awaitable<T> = T | Promise<T>;

/**
 * What a call returning a capability returns: a promise of the capability, whose methods can be
 * called before it resolves (promise pipelining): `root.open(id).list()` sends both calls at
 * once, the second to whatever the first returns. Disposing it disposes the capability.
 */
export type Pipelined<T> = Promise<T> & T;

/**
 * A capability whose interface the API does not declare (an `RpcStub<any>`). `unknown`, so that
 * calling it takes a deliberate cast to the interface it is known to have: `any` would let every
 * call through unchecked, and an invented interface would be a guess.
 */
export type UntypedStub = unknown;
