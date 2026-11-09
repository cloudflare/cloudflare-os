import { createFileRoute } from "@tanstack/react-router";
import { homePromptFromSearch } from "../homePrompt";
import { HomePage } from "../pages/home/HomePage";

type HomeSearch = {
  prompt?: string;
  /** Starts the composer in this workspace, as a workspace's "New chat" does. */
  workspace?: string;
  cfos_native_state?: string;
  cfos_native_key?: string;
};

export const Route = createFileRoute("/")({
  component: HomeRoute,
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    prompt: homePromptFromSearch(search.prompt),
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    cfos_native_state: typeof search.cfos_native_state === "string"
      ? search.cfos_native_state : undefined,
    cfos_native_key: typeof search.cfos_native_key === "string"
      ? search.cfos_native_key : undefined,
  }),
});

function HomeRoute() {
  const { prompt, workspace } = Route.useSearch();
  return <HomePage prompt={prompt} workspace={workspace} />;
}
