import { useSyncExternalStore } from 'react'
import type { WorkspaceColor } from '@/components/workspaceLook'
import { gadgetColorKey, GadgetColors } from './GadgetColors'

// One for the page, as the colours are this device's and every gadget's mark draws from them.
const colors = new GadgetColors()

/** The colour a gadget's mark is drawn in on this device (`GadgetColors`), if one was chosen. */
export const useGadgetColor = (workspaceId: string, workpieceId: number): WorkspaceColor | undefined =>
  useSyncExternalStore(colors.subscribe, colors.snapshot)[gadgetColorKey(workspaceId, workpieceId)]

/** Has a gadget's mark drawn in another colour, wherever it is drawn. */
export const setGadgetColor = (workspaceId: string, workpieceId: number, color: WorkspaceColor) =>
  colors.set(gadgetColorKey(workspaceId, workpieceId), color)
