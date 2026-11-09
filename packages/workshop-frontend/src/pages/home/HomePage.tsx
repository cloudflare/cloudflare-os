import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useKumoToastManager } from "@cloudflare/kumo";
import { RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  Overseer,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import { classifyRpcError, logRpcFailure, rpcFailureDescription } from "../../rpcErrors";
import { ChatComposer } from "../../features/chat/composer/ChatComposer";
import { composerDraftStorageKey } from "../../features/chat/composer/draft/composerDraft";
import { UpdateAvailableNotice } from "../../features/deployment-updates/UpdateAvailableNotice";
import { CreateWorkspaceDialog } from "../../features/workspaces/CreateWorkspaceDialog";
import { WorkspacePicker } from "../../features/workspaces/WorkspacePicker";
import { useAuthenticatedApi } from "../../AuthContext";
import { getStoredSelectedModel, persistSelectedModel } from "../../modelSelection";
import { useDocumentTitle } from "../../useDocumentTitle";
import { CloudMark } from "../../components/icons/brandMarks";
import { AutomationIcon, FolderIcon, TemplateIcon } from "../../components/icons/designIcons";
import { openSidebarDrawer } from "../../components/AppShell/commandPaletteBus";
import { roundButtonClass } from "../../components/RoundButton";
import SiteLogo from "../../components/SiteLogo";

// The Scheduled Tasks gatekeeper's app, where automations are set up, when the deployment has it.
const AUTOMATION_PROMPT = "Every weekday morning, ";

/** The user's first name for the greeting, falling back to their whole display name. */
const firstName = (name: string | undefined) => name?.trim().split(/\s+/)[0] || "there";

/** One of Home's quick actions (Figma "Frame 723"): a white pill with an icon and a label. */
const QuickAction = ({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-kumo-base px-2.5 text-[13px] leading-4 text-kumo-default/70 ring-1 ring-kumo-fill-hover transition-colors hover:bg-kumo-elevated hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
  >
    <span className="shrink-0">{icon}</span>
    {label}
  </button>
);

type HomeSearch = { prompt?: string; workspace?: string };

/**
 * Home (Figma "MacBook Pro 14\" - 1"): the brand cloud, a greeting, three quick actions and the
 * composer at the foot of the page. Sending starts a chat in the workspace the composer's picker
 * names, or in a workspace of its own when the picker says "No workspace", then opens it.
 */
export const HomePageContent = ({ prompt, workspace }: HomeSearch) => {
  useDocumentTitle("Home");
  const { authenticatedApi, currentUser } = useAuthenticatedApi();
  const navigate = useNavigate();
  const toasts = useKumoToastManager();
  const [models, setModels] = useState<AiChatAuthorInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // Bumped each time something seeds the composer; it re-reads its text off the nonce.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  // A workspace's "New chat" arrives with that workspace already picked.
  const [targetWorkspace, setTargetWorkspace] = useState<string | null>(workspace ?? null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);

  const seedComposer = (text: string) => setSeed((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }));

  useEffect(() => {
    if (workspace) setTargetWorkspace(workspace);
    if (!prompt && !workspace) return;
    if (prompt) seedComposer(prompt);
    navigate({ to: "/", search: {}, replace: true });
  }, [navigate, prompt, workspace]);

  useEffect(() => {
    let cancelled = false;
    authenticatedApi.listModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setSelectedModel(getStoredSelectedModel(list));
      })
      .catch((err) => {
        logRpcFailure("Failed to fetch models:", err);
        // Toast unless it's a connection error (reconnect refetches); a do-reset here already
        // survived the Worker's same-colo retry, so the user should hear about it.
        if (classifyRpcError(err) !== "connection") {
          toasts.add({ title: "Couldn't load AI models", variant: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi]);

  const handleModelChange = useCallback((value: string | null) => {
    setSelectedModel(value);
    persistSelectedModel(value);
  }, []);

  // The workspace the chat will start in, opened as soon as the user starts interacting so that
  // navigation after sending is instant. With no workspace picked it is a provisional workspace of
  // its own, which nothing lists until the chat begins; it is let go if never used.
  const overseerRef = useRef<{ stub: RpcStub<Overseer>; target: string | null } | null>(null);
  const ensureOverseer = useCallback((): RpcStub<Overseer> => {
    if (overseerRef.current?.target !== targetWorkspace) {
      overseerRef.current?.stub[Symbol.dispose]();
      const stub = targetWorkspace === null
        ? authenticatedApi.newWorkspace()
        : authenticatedApi.openWorkspace(targetWorkspace);
      overseerRef.current = { stub, target: targetWorkspace };
    }
    return overseerRef.current.stub;
  }, [authenticatedApi, targetWorkspace]);
  useEffect(() => {
    return () => {
      overseerRef.current?.stub[Symbol.dispose]();
      overseerRef.current = null;
    };
  }, []);

  const handleSend = useCallback(
    async (
      message: string | SlashCommandRequest,
      modelId: string | null,
      capsules?: CapsuleSpecifier[],
      attachments?: ChatAttachmentHandle[],
      formats?: MessageFormatRef[],
    ) => {
      try {
        const overseer = ensureOverseer();
        // Pipeline both independent calls in one batch, but settle both before releasing the stub.
        const [chat, { id }] = await Promise.all([
          overseer.newChat(message, modelId, capsules, attachments, formats),
          overseer.getMetadata(),
        ]);
        overseerRef.current?.stub[Symbol.dispose]();
        overseerRef.current = null;
        navigate({ to: "/workspace/$id", params: { id }, search: { chat } });
      } catch (err) {
        const transient = logRpcFailure("Failed to start chat:", err,
            { reportSite: "workspace.create" });
        // A retry reuses the workspace while the draft holds references scoped to it.
        if (!attachments?.length && !capsules?.length) {
          overseerRef.current?.stub[Symbol.dispose]();
          overseerRef.current = null;
        }
        if (!transient) {
          toasts.add({
            title: "Couldn't start the chat",
            description: rpcFailureDescription(err),
            variant: "error",
          });
        }
        throw err;
      }
    },
    [ensureOverseer, navigate, toasts],
  );

  const createCapsuleGatekeeper = useCallback(
    (accountId: number, url: string) => ensureOverseer().newGatekeeper(accountId, url),
    [ensureOverseer],
  );

  // A chat sets an automation up from a sentence, and replies with each run.
  const addAutomation = () => seedComposer(AUTOMATION_PROMPT);

  const picker = (appearance: "chip" | "pill") => (
    <WorkspacePicker
      value={targetWorkspace}
      onValueChange={setTargetWorkspace}
      onCreateWorkspace={() => setCreatingWorkspace(true)}
      appearance={appearance}
    />
  );

  return (
    <div className="flex min-h-full w-full flex-1 flex-col">
      <UpdateAvailableNotice />
      {/* The phone layout's header (Figma "iPhone 18 Pro - 1"): the logo returns to the chat list
          and the workspace picker moves up out of the composer. */}
      <div className="flex items-center justify-between p-4 md:hidden">
        <button type="button" onClick={openSidebarDrawer} aria-label="Chats" className={roundButtonClass("icon", "!size-[46px]")}>
          <SiteLogo size={22}><CloudMark size={22} className="text-kumo-brand" /></SiteLogo>
        </button>
        {picker("pill")}
      </div>
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="flex w-full max-w-[501px] flex-col items-center gap-[31px] px-2">
          <SiteLogo size={41}>
            <CloudMark size={41} className="text-kumo-brand" />
          </SiteLogo>
          <h1 className="text-center text-[15px] font-medium leading-[18px] text-kumo-default">
            Hello {firstName(currentUser?.name)}, what should we do today?
          </h1>
          <div className="flex flex-col items-center gap-2.5 sm:flex-row">
            <QuickAction icon={<TemplateIcon size={16} />} label="Use a template"
              onClick={() => navigate({ to: "/blueprints" })} />
            <QuickAction icon={<AutomationIcon size={16} />} label="Add an automation" onClick={addAutomation} />
            <QuickAction icon={<FolderIcon size={16} />} label="Create a workspace"
              onClick={() => setCreatingWorkspace(true)} />
          </div>
        </div>
      </div>
      <div className="sticky bottom-0 bg-gradient-to-t from-kumo-base to-transparent">
        {/* A new target means a different workspace for uploads and connections, so the composer
            starts over; its draft text is kept under the same storage key. */}
        <ChatComposer
          key={targetWorkspace ?? "none"}
          createCapsuleGatekeeper={createCapsuleGatekeeper}
          getOverseer={ensureOverseer}
          onSend={handleSend}
          isAgentActive={false}
          models={models}
          selectedModel={selectedModel === null ? null : { id: selectedModel }}
          onModelChange={handleModelChange}
          newChat
          offerFormats
          autoFocus
          seedText={seed?.text}
          seedNonce={seed?.nonce}
          draftStorageKey={currentUser ? composerDraftStorageKey(currentUser.id, "home") : undefined}
          trailing={<span className="hidden md:contents">{picker("chip")}</span>}
        />
      </div>
      <CreateWorkspaceDialog open={creatingWorkspace} onOpenChange={setCreatingWorkspace} />
    </div>
  );
};

export const HomePage = ({ prompt, workspace }: HomeSearch) =>
  <HomePageContent prompt={prompt} workspace={workspace} />;
