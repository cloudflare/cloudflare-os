import { classifyRpcError, logRpcFailure } from "../rpcErrors";
import { useState, useEffect, useRef, useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useKumoToastManager } from "@cloudflare/kumo";
import { ChatInput } from "../ChatInput";
import MeshBackground from "../components/MeshBackground";
import HomeTaskSuggestions from "../components/AppShell/HomeTaskSuggestions";
import { useAuthenticatedApi } from "../AuthContext";
import { RpcStub } from "capnweb";
import {
  Overseer,
  AiChatAuthorInfo,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  SlashCommandRequest,
  FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID,
} from "@gadgets/workshop-shared/api";
import {
  getStoredSelectedModel,
  persistSelectedModel,
} from "../modelSelection";
import { useDocumentTitle } from "../useDocumentTitle";
import { homePromptFromSearch } from "../homePrompt";
import { composerDraftStorageKey } from "../composerDraft";
import { HUB_DETAILS, useHub } from "../HubContext";

type HomeSearch = { prompt?: string };

export const Route = createFileRoute("/")({
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    prompt: homePromptFromSearch(search.prompt),
  }),
});

// The Home page is the "new workspace" launcher. Persistent navigation (recents, favorites) lives
// in the AppShell rail, so this page focuses on a single thing: composing the first message of a
// new gadget — a centered column with a hero, the prompt composer, and a few task suggestions.
function HomePage() {
  return <HomePageContent prompt={Route.useSearch().prompt} />;
}

export function HomePageContent({ prompt }: HomeSearch) {
  const { hub } = useHub();
  if (hub === 'finance') return <FinanceHomePageContent />;
  return <GenericHomePageContent prompt={prompt} />;
}

function FinanceHomePageContent() {
  const { financeStatus } = useHub();
  const { authenticatedApi } = useAuthenticatedApi();
  const navigate = useNavigate();
  const toasts = useKumoToastManager();
  const [creating, setCreating] = useState(false);
  useDocumentTitle('Finance');

  if (!financeStatus?.authorized) return null;

  const openOrCreate = async () => {
    if ('workspaceId' in financeStatus) {
      navigate({ to: '/workspace/$id', params: { id: financeStatus.workspaceId }, search: {} });
      return;
    }
    if (!financeStatus.canCreate || creating) return;

    setCreating(true);
    const overseer = authenticatedApi.newGadgetFromBlueprint(
      FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID,
      {},
      'finance',
    );
    try {
      const { id } = await overseer.getMetadata();
      navigate({ to: '/workspace/$id', params: { id }, search: {} });
    } catch (err) {
      logRpcFailure('Failed to create Finance workspace:', err, { reportSite: 'finance.create' });
      toasts.add({ title: 'Failed to create Finance workspace', variant: 'error' });
    } finally {
      overseer[Symbol.dispose]();
      setCreating(false);
    }
  };

  return (
    <div className="relative isolate flex min-h-full w-full items-start justify-center px-4 pb-16 pt-12 sm:px-8 sm:pt-20">
      <section className="w-full max-w-3xl overflow-hidden rounded-3xl border border-kumo-line bg-kumo-base shadow-sm">
        <div className="border-b border-kumo-line bg-kumo-tint/60 px-6 py-5 sm:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-kumo-brand">Invite-only Finance hub</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-kumo-default">Finance Operations Workbench</h1>
        </div>
        <div className="px-6 py-7 sm:px-8 sm:py-9">
          <p className="max-w-2xl text-[15px] leading-6 text-kumo-subtle">
            Review bounded finance working data, evidence, variances, contract findings, and forecasts in one shared workspace. Access is managed through direct collaborator invitations.
          </p>
          <button
            type="button"
            onClick={openOrCreate}
            disabled={creating}
            className="mt-7 inline-flex h-10 items-center justify-center rounded-xl bg-kumo-brand px-5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
          >
            {'workspaceId' in financeStatus
              ? 'Open Finance Operations Workbench'
              : creating ? 'Creating workbench…' : 'Create Finance Operations Workbench'}
          </button>
          <p className="mt-4 text-xs leading-5 text-kumo-inactive">
            Collaborators receive Gadget-only access. Bearer share links are disabled.
          </p>
        </div>
      </section>
    </div>
  );
}

function GenericHomePageContent({ prompt }: HomeSearch) {
  const { hub } = useHub();
  const hubDetails = HUB_DETAILS[hub];
  useDocumentTitle(hubDetails.label);

  const { authenticatedApi, currentUser } = useAuthenticatedApi();
  const navigate = useNavigate();
  const toasts = useKumoToastManager();

  const [models, setModels] = useState<AiChatAuthorInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const sendPendingRef = useRef(false);
  // Bumped each time a task suggestion is picked; the composer re-seeds its text off the nonce.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);

  useEffect(() => {
    if (!prompt) return;
    setSeed((previous) => ({ text: prompt, nonce: (previous?.nonce ?? 0) + 1 }));
    navigate({ to: "/", search: {}, replace: true });
  }, [navigate, prompt]);

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

  // Pre-create a provisional gadget as soon as the user starts interacting, so that navigation
  // after submit is instant. Same pattern as before — disposed on unmount if never consumed.
  const provisionalOverseerRef = useRef<{ stub: RpcStub<Overseer>; hub: string } | null>(null);

  const ensureProvisionalGadget = useCallback(() => {
    if (!provisionalOverseerRef.current) {
      const overseer = authenticatedApi.newGadget(hub);
      provisionalOverseerRef.current = { stub: overseer, hub };
    }
  }, [authenticatedApi, hub]);

  useEffect(() => {
    return () => {
      provisionalOverseerRef.current?.stub[Symbol.dispose]();
      provisionalOverseerRef.current = null;
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
      if (sendPendingRef.current) return;
      sendPendingRef.current = true;
      try {
        ensureProvisionalGadget();
        const provisional = provisionalOverseerRef.current!;
        const overseer = provisional.stub;
        const { id } = await overseer.getMetadata();
        // If the workspace was pre-created for the currently selected hub, skip the extra round-trip.
        // A last-second hub switch is still stamped immediately before starting activity.
        if (provisional.hub !== hub) {
          await authenticatedApi.updateProvisionalWorkspaceOrigin(id, hub);
        }
        const chat = await overseer.newChat(message, modelId, capsules, attachments, formats);
        provisionalOverseerRef.current?.stub[Symbol.dispose]();
        provisionalOverseerRef.current = null;
        // Open the conversation we just started.
        navigate({ to: "/workspace/$id", params: { id }, search: { chat } });
      } catch (err) {
        const transient = logRpcFailure("Failed to create gadget:", err,
            { reportSite: "workspace.create" });
        // A retry reuses the provisional gadget while the draft contains gadget-scoped references.
        if (!attachments?.length && !capsules?.length) {
          provisionalOverseerRef.current?.stub[Symbol.dispose]();
          provisionalOverseerRef.current = null;
        }
        if (!transient) {
          toasts.add({ title: "Failed to create workspace", variant: "error" });
        }
        throw err;
      } finally {
        sendPendingRef.current = false;
      }
    },
    [authenticatedApi, ensureProvisionalGadget, hub, navigate, toasts],
  );

  const getOverseer = useCallback((): RpcStub<Overseer> => {
    ensureProvisionalGadget();
    return provisionalOverseerRef.current!.stub;
  }, [ensureProvisionalGadget]);

  const createCapsuleGatekeeper = useCallback(
    (accountId: number, url: string) => {
      ensureProvisionalGadget();
      return provisionalOverseerRef.current!.stub.newGatekeeper(accountId, url);
    },
    [ensureProvisionalGadget],
  );

  return (
    // Flat enterprise treatment: no mesh, no watermark hexagon, no prompt-glow. The AppShell's
    // <main> already supplies a faint dotted grid as the page background.
    <div className="relative isolate flex min-h-full w-full flex-col items-center justify-start px-4 pb-16 pt-10 sm:px-8 sm:pt-16 lg:pt-24">
      {/* The brand hex mesh, restored and de-warmed for the new system: a gentle perspective hex
          grid receding upward. Masked to fade out before the composer so it stays a quiet backdrop. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[460px] overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
        }}
      >
        <MeshBackground />
      </div>
      <div className="flex w-full max-w-2xl flex-col items-stretch gap-8">
        {/* Hero */}
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight leading-tight text-kumo-default sm:text-4xl">
            {hubDetails.heading}
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
            {hubDetails.description}
          </p>
        </header>

        {/* Composer */}
        <ChatInput
          createCapsuleGatekeeper={createCapsuleGatekeeper}
          getOverseer={getOverseer}
          onSend={handleSend}
          isAgentActive={false}
          models={models}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          newChat
          offerFormats
          autoFocus
          minRows={3}
          seedText={seed?.text}
          seedNonce={seed?.nonce}
          onInputIntent={ensureProvisionalGadget}
          sendingStatusLabel="Starting workspace…"
          draftStorageKey={currentUser
            ? composerDraftStorageKey(currentUser.id, `home:${hub}`)
            : undefined}
        />

        {/* A few example work tasks to spark ideas. Picking one seeds the composer above. */}
        <HomeTaskSuggestions
          hub={hub}
          onPick={(suggestion) =>
            setSeed((prev) => ({ text: suggestion, nonce: (prev?.nonce ?? 0) + 1 }))
          }
        />
      </div>
    </div>
  );
}
