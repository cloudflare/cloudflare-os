import { Banner } from "@cloudflare/kumo/components/banner";
import { Component, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { ConfiguratorUIValues } from "../index.ts";
import { NoticeAnnouncer } from "./Notice.tsx";
import { reportFrontendIssue } from "./reporting.ts";
import type { ConfiguratorSession } from "./session.ts";
import { StoreContext } from "./storeContext.ts";
import { useKeepFocusInForm } from "./useKeepFocusInForm.ts";

type Rendered =
  | { ok: true; tree: ReactNode; ready: boolean }
  | { ok: false; error: unknown };

const renderModule = (session: ConfiguratorSession, values: ConfiguratorUIValues): Rendered => {
  const { acceptedResourceUrlPatterns } = session;
  try {
    const tree = session.spec.render({
      values,
      setValues: session.store.setValues,
      clearFields: session.store.clearFields,
      ensureResources: session.ensureResources,
      ui: session.ui,
      acceptedResourceUrlPatterns,
    }) as ReactNode;
    const ready = session.spec.isReady
      ? Boolean(session.spec.isReady({ values, acceptedResourceUrlPatterns }))
      : true;
    return { ok: true, tree, ready };
  } catch (error) {
    return { ok: false, error };
  }
};

/** Shown in place of a configurator that could not render. */
export const ErrorNotice = ({ error }: { error: unknown }) => (
  <Banner
    variant="error"
    size="sm"
    className="whitespace-pre-wrap"
    description={error instanceof Error ? error.stack || error.message : String(error)}
  />
);

/**
 * Renders the module for the current state and tells the host whether it is ready.
 *
 * When the module's `render` throws, the last tree that rendered stays on screen, so the controls
 * that could put it right are still there, and readiness is withdrawn until a render succeeds.
 */
export const ConfiguratorRoot = ({ session }: { session: ConfiguratorSession }) => {
  const { store } = session;
  // Only what the module or readiness depends on, so a host scrolling its modal re-renders nothing.
  const values = useSyncExternalStore(store.subscribe, () => store.getState().values);
  // Never read here: subscribed so that a field placing or releasing a hold on collection re-runs
  // the readiness effect.
  useSyncExternalStore(store.subscribe, () => store.getState().holds);
  const rendered = renderModule(session, values);
  // Read during render on purpose: it is the fallback for this very render, and is only written
  // after a successful one commits.
  const lastGoodTree = useRef<{ tree: ReactNode } | null>(null);
  const form = useRef<HTMLDivElement>(null);
  useKeepFocusInForm(form);

  useLayoutEffect(() => {
    session.renderFailed = !rendered.ok;
    if (rendered.ok) {
      session.moduleReady = rendered.ready;
      lastGoodTree.current = { tree: rendered.tree };
    } else {
      reportFrontendIssue("configurator.render", rendered.error, { handled: false });
    }
    session.postReadiness();
  });

  const tree = rendered.ok
    ? rendered.tree
    : lastGoodTree.current?.tree ?? <ErrorNotice error={rendered.error} />;
  return (
    <StoreContext.Provider value={store}>
      <div ref={form} id="layout-root" className="grid gap-4 p-0.5 pb-1">
        <TreeBoundary session={session}>{tree}</TreeBoundary>
      </div>
      <NoticeAnnouncer form={form} />
    </StoreContext.Provider>
  );
};

type TreeBoundaryProps = { session: ConfiguratorSession; children: ReactNode };
type TreeBoundaryState = { children: ReactNode; error: { value: unknown } | null };

/**
 * Catches a runtime component that throws while rendering the module's tree. Reset whenever the
 * root renders a new tree, so a change to the values retries it.
 */
class TreeBoundary extends Component<TreeBoundaryProps, TreeBoundaryState> {
  state: TreeBoundaryState = { children: this.props.children, error: null };

  static getDerivedStateFromProps(
    props: TreeBoundaryProps,
    state: TreeBoundaryState,
  ): Partial<TreeBoundaryState> | null {
    return props.children === state.children ? null : { children: props.children, error: null };
  }

  static getDerivedStateFromError(error: unknown): Partial<TreeBoundaryState> {
    return { error: { value: error } };
  }

  componentDidCatch(error: unknown) {
    reportFrontendIssue("configurator.render", error, { handled: false });
  }

  // From what was committed rather than in `componentDidCatch`: the commit in which a child throws
  // still shows the boundary's previous state, and the notice only commits with the next one, a
  // microtask later -- before any message from the host can ask to collect.
  componentDidMount() {
    this.#syncFailure();
  }

  componentDidUpdate() {
    this.#syncFailure();
  }

  #syncFailure() {
    this.props.session.treeFailed = this.state.error !== null;
    this.props.session.postReadiness();
  }

  render() {
    return this.state.error ? <ErrorNotice error={this.state.error.value} /> : this.props.children;
  }
}
