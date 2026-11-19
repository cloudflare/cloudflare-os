import { classifyRpcError, logRpcFailure, rpcFailureDescription } from "../rpcErrors";
import { useState, useEffect, useRef, useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useKumoToastManager } from "@cloudflare/kumo";
import { ChatComposer } from "../features/chat/composer/ChatComposer";
import MeshBackground from "../components/MeshBackground";
import HomeBackdrop from "../components/AppShell/HomeBackdrop";
import HomeSketchBackdrop from "../components/AppShell/HomeSketchBackdrop";
import HomeTaskSuggestions from "../components/AppShell/HomeTaskSuggestions";
import HomePriorities from "../components/AppShell/HomePriorities";
import HomeEntities from "../components/AppShell/HomeEntities";
import { siteConfig } from "../siteConfig";
import { useSiteTheme } from "../useWorkspaceTheme";
import { UpdateAvailableNotice } from "../features/deployment-updates/UpdateAvailableNotice";
import { useAuthenticatedApi } from "../AuthContext";
import { RpcStub } from "capnweb";
import {
  Overseer,
  AiChatAuthorInfo,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import {
  cacheModels,
  getCachedModels,
  getStoredSelectedModel,
  persistSelectedModel,
  syncSelectedModel,
} from "../modelSelection";
import { useDocumentTitle } from "../useDocumentTitle";
import { homePromptFromSearch } from "../homePrompt";
import { composerDraftStorageKey } from "../features/chat/composer/draft/composerDraft";

type HomeSearch = {
  prompt?: string;
  cfos_native_state?: string;
  cfos_native_key?: string;
};

export const Route = createFileRoute("/")({
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    prompt: homePromptFromSearch(search.prompt),
    cfos_native_state: typeof search.cfos_native_state === "string"
      ? search.cfos_native_state : undefined,
    cfos_native_key: typeof search.cfos_native_key === "string"
      ? search.cfos_native_key : undefined,
  }),
});

// The Home page is the "new workspace" launcher. Persistent navigation (recents, favorites) lives
// in the AppShell rail, so this page focuses on a single thing: composing the first message of a
// new gadget — a centered column with a hero, the prompt composer, and a few task suggestions.
function HomePage() {
  return <HomePageContent prompt={Route.useSearch().prompt} />;
}

export function HomePageContent({ prompt }: HomeSearch) {
  useDocumentTitle("Home");

  const { authenticatedApi, currentUser, isCurrentUserConfirmed } = useAuthenticatedApi();
  // Whose remembered models to show: nobody's until the server has confirmed who is signed in.
  const userId = isCurrentUserConfirmed ? currentUser?.id : undefined;
  const navigate = useNavigate();
  // Deployment headline and strategic priorities, when the deploy inlines a site config.
  const home = siteConfig().home;
  useSiteTheme(home?.theme);
  const toasts = useKumoToastManager();

  // Starts on what this browser last saw, so the selector doesn't wait on the server.
  const [models, setModels] = useState<AiChatAuthorInfo[]>(() => getCachedModels(userId));
  const [selectedModel, setSelectedModel] = useState<string | null>(
    () => getStoredSelectedModel(userId, models),
  );
  const [modelsLoading, setModelsLoading] = useState(models.length === 0);
  // Bumped each time a task suggestion is picked; the composer re-seeds its text off the nonce.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);

  useEffect(() => {
    if (!prompt) return;
    setSeed((previous) => ({ text: prompt, nonce: (previous?.nonce ?? 0) + 1 }));
    navigate({ to: "/", search: {}, replace: true });
  }, [navigate, prompt]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([authenticatedApi.listModels(), syncSelectedModel(authenticatedApi)])
      .then(([list, syncedUserId]) => {
        if (cancelled) return;
        cacheModels(syncedUserId, list);
        setModels(list);
        setSelectedModel(getStoredSelectedModel(syncedUserId, list));
        setModelsLoading(false);
      })
      .catch((err) => {
        if (!cancelled) setModelsLoading(false);
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
    persistSelectedModel(authenticatedApi, userId, value);
  }, [authenticatedApi, userId]);

  // Pre-create a provisional gadget as soon as the user starts interacting, so that navigation
  // after submit is instant. Same pattern as before — disposed on unmount if never consumed.
  const provisionalOverseerRef = useRef<{ stub: RpcStub<Overseer> } | null>(null);

  const ensureProvisionalGadget = useCallback(() => {
    if (!provisionalOverseerRef.current) {
      const overseer = authenticatedApi.newWorkspace();
      provisionalOverseerRef.current = { stub: overseer };
    }
  }, [authenticatedApi]);

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
      try {
        ensureProvisionalGadget();
        const overseer = provisionalOverseerRef.current!.stub;
        // Pipeline both independent calls in one batch, but settle both before releasing the stub.
        const [chat, {id}] = await Promise.all([
          overseer.newChat(message, modelId, capsules, attachments, formats),
          overseer.getMetadata(),
        ]);
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
          toasts.add({
            title: "Failed to create workspace",
            description: rpcFailureDescription(err),
            variant: "error",
          });
        }
        throw err;
      }
    },
    [ensureProvisionalGadget, navigate, toasts],
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

  const sketch = home?.backdrop === "sketch";

  return (
    // Flat enterprise treatment: no mesh, no watermark hexagon, no prompt-glow. The AppShell's
    // <main> already supplies a faint dotted grid as the page background.
    <div
      className={`relative isolate flex min-h-full w-full flex-col items-center justify-start px-4 pb-16 sm:px-8 ${
        // Over the sketch backdrop the whole Home (headline, drawing, apps, composer) fits one screen.
        sketch ? "pt-14" : "pt-10 sm:pt-16 lg:pt-24"
      }`}
    >
      <UpdateAvailableNotice />
      {home ? (
        // A deployment with its own Home gets its own backdrop: a faint brand-tinted field and a
        // hairline grid that fade out above the composer, in place of the upstream hex mesh.
        home.backdrop === "sketch" ? <HomeSketchBackdrop /> : <HomeBackdrop />
      ) : (
      /* The brand hex mesh, restored and de-warmed for the new system: a gentle perspective hex
          grid receding upward. Masked to fade out before the composer so it stays a quiet backdrop. */
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
      )}
      {/* The header gets the wider band so a display-size headline holds one line. Over the sketch
          backdrop it also reserves the drawing's height, so the entity row starts below the etch. */}
      <div
        className={`flex w-full max-w-4xl flex-col items-stretch gap-8${
          sketch ? " min-h-[270px]" : ""
        }`}
      >
        {/* Hero */}
        <header className="text-center">
          {home && (
            // Over the sketch backdrop the eyebrow sits at the top edge of the page, clear of the drawing.
            // A deployment whose top bar already names it omits the eyebrow and keeps the date alone.
            <p
              className={`text-[11px] font-semibold uppercase tracking-[0.18em] text-kumo-brand ${
                sketch ? "absolute inset-x-0 top-6 text-center" : "mb-4"
              }`}
            >
              {home.eyebrow && (
                <>
                  {home.eyebrow}
                  <span aria-hidden="true" className="mx-2 text-kumo-inactive">·</span>
                </>
              )}
              <span className="font-medium normal-case tracking-normal text-kumo-subtle">{todayLabel()}</span>
            </p>
          )}
          <h1
            className={sketch
              // Over the sketch backdrop the headline is a single 18px line above the drawing.
              ? "whitespace-nowrap text-[18px] font-medium leading-7 tracking-[-0.01em] text-kumo-strong"
              : home
              ? "text-[40px] font-normal leading-[1.12] tracking-[-0.015em] text-kumo-strong sm:text-[60px] sm:leading-[68px]"
              : "text-3xl font-semibold tracking-tight leading-tight text-kumo-default sm:text-4xl"}
          >
            {home?.title ?? "What are we working on?"}
          </h1>
          {(home ? home.subtitle && !sketch : true) && (
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
              {home
                ? home.subtitle
                : "Ask a question, create an output, or create an app that works with your tools and data."}
            </p>
          )}
        </header>
      </div>

      {/* The deployment's entities, joined to the headline by connector lines. */}
      {home?.entities && home.entities.length > 0 && (
        <div className="mt-2 w-full max-w-4xl">
          <HomeEntities entities={home.entities} />
        </div>
      )}

      {/* Over the sketch backdrop the subtitle moves below the entity row, out of the drawing. */}
      {sketch && home?.subtitle && (
        <p className="mx-auto mt-4 max-w-md text-center text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
          {home.subtitle}
        </p>
      )}

      <div className={`${sketch ? "mt-5" : "mt-8"} flex w-full max-w-2xl flex-col items-stretch gap-8`}>
        {/* Composer */}
        <ChatComposer
          createCapsuleGatekeeper={createCapsuleGatekeeper}
          getOverseer={getOverseer}
          onSend={handleSend}
          isAgentActive={false}
          models={models}
          selectedModel={selectedModel === null ? null : { id: selectedModel }}
          modelsLoading={modelsLoading}
          onModelChange={handleModelChange}
          newChat
          offerFormats
          autoFocus
          minRows={3}
          seedText={seed?.text}
          seedNonce={seed?.nonce}
          draftStorageKey={currentUser
            ? composerDraftStorageKey(currentUser.id, "home")
            : undefined}
        />

        {/* A few example work tasks to spark ideas. Picking one seeds the composer above. */}
        {!home && (
          <HomeTaskSuggestions
            onPick={(suggestion) =>
              setSeed((prev) => ({ text: suggestion, nonce: (prev?.nonce ?? 0) + 1 }))
            }
          />
        )}
      </div>

      {/* The deployment's strategic priorities get a wider band than the composer column, so six
          read as a 3 x 2 grid of cards on desktop. */}
      {home && home.priorities.length > 0 && (
        <div className="mt-12 w-full max-w-4xl">
          <HomePriorities label={home.prioritiesLabel ?? "Priorities"} priorities={home.priorities} />
        </div>
      )}
    </div>
  );
}

/** "Tuesday, October 21" in the viewer's locale and time zone. */
function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
