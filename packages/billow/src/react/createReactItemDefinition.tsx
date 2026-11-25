import type {
  ItemAccessibilityAttributes,
  ItemDefinition,
  ItemRenderContext,
} from "../index.js";
import { Component, createElement, type ErrorInfo, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

export interface ReactItemDefinitionOptions<Data, Serialized = Data, Presentation = unknown> {
  render(data: Data, context: ItemRenderContext<string, Presentation>): ReactNode;
  toPlainText(data: Data): string;
  serialize?(data: Data): Serialized;
  deserialize?(value: unknown): Data;
  getLabel?(data: Data): string;
  getAccessibilityAttributes?(
    data: Data,
    context: ItemRenderContext<string, Presentation>,
  ): ItemAccessibilityAttributes;
}

interface ErrorBoundaryProps {
  readonly children?: ReactNode;
  readonly reportError: (error: unknown) => void;
}

class ItemErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.reportError(error);
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (this.state.failed && previousProps.children !== this.props.children) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function createReactItemDefinition<Data, Presentation = unknown>(
  options: ReactItemDefinitionOptions<Data, Data, Presentation>,
): ItemDefinition<Data, Data, Presentation>;
export function createReactItemDefinition<Data, Serialized, Presentation = unknown>(
  options: ReactItemDefinitionOptions<Data, Serialized, Presentation>,
): ItemDefinition<Data, Serialized, Presentation>;
export function createReactItemDefinition<Data, Serialized, Presentation>(
  options: ReactItemDefinitionOptions<Data, Serialized, Presentation>,
): ItemDefinition<Data, Serialized, Presentation> {
  const roots = new WeakMap<HTMLElement, { root: Root; reportError: (error: unknown) => void }>();
  const render = (root: Root, data: Data, context: ItemRenderContext<string, Presentation>): void => {
    root.render(createElement(
      ItemErrorBoundary,
      { reportError: context.reportError },
      options.render(data, context),
    ));
  };
  return {
    render(data, context) {
      context.element.dataset.billowReactRoot = "";
      const root = createRoot(context.element);
      roots.set(context.element, { root, reportError: context.reportError });
      render(root, data, context);
    },
    update(element, _previousData, data, context) {
      const entry = roots.get(element);
      if (!entry) throw new TypeError("React item root is unavailable");
      entry.reportError = context.reportError;
      render(entry.root, data, context);
    },
    destroy(element) {
      const entry = roots.get(element);
      roots.delete(element);
      if (entry) queueMicrotask(() => {
        try {
          flushSync(() => entry.root.render(createElement(ItemErrorBoundary, {
            reportError: entry.reportError,
          })));
          entry.root.unmount();
        } catch (error) {
          entry.reportError(error);
        }
      });
    },
    toPlainText: options.toPlainText,
    ...(options.deserialize === undefined ? {} : { deserialize: options.deserialize }),
    ...(options.serialize === undefined ? {} : { serialize: options.serialize }),
    ...(options.getLabel === undefined ? {} : { getLabel: options.getLabel }),
    ...(options.getAccessibilityAttributes === undefined
      ? {}
      : { getAccessibilityAttributes: options.getAccessibilityAttributes }),
  };
}
