import { createContext, useContext } from "react";
import type { WorkItemProviderRef, WorkItemsManagementApi } from "../src/types";

const WorkItemsApiContext = createContext<WorkItemsManagementApi | null>(null);
const WorkItemsRouteStateContext = createContext<WorkItemsRouteStateHost | null>(null);

export type WorkItemsRouteStateHost = {
  initialRouteState?: string;
  setRouteState?: (value: string) => void;
  codingSessionAvailable?: boolean;
  requestCodingSession?: (target: WorkItemProviderRef, title: string) => void;
  openConnectors?: () => Promise<void>;
  retryProviders?: () => Promise<void>;
};

export const WorkItemsApiProvider = WorkItemsApiContext.Provider;
export const WorkItemsRouteStateProvider = WorkItemsRouteStateContext.Provider;

export function useWorkItemsApi(): WorkItemsManagementApi | null {
  return useContext(WorkItemsApiContext);
}

export function useWorkItemsRouteState(): WorkItemsRouteStateHost | null {
  return useContext(WorkItemsRouteStateContext);
}
