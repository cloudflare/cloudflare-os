import type { BoundHookInfo } from '@gadgets/workshop-shared/api'

/** Something set up to run by itself: one of a workspace's hooks (`BoundHookInfo`). */
export type Automation = {
  /** Unique across workspaces. */
  key: string
  workspaceId: string
  hook: BoundHookInfo
}

/** A workspace's hooks as automations, newest first. */
export const automationsOf = (workspaceId: string, hooks: readonly BoundHookInfo[]): Automation[] =>
  hooks.toSorted((a, b) => b.id - a.id).map((hook) => ({ key: `${workspaceId}/${hook.id}`, workspaceId, hook }))

/** Which of a workspace's automations a chat set up: those bound from it. */
export const setUpIn = (chatId: number) => ({ hook }: Automation) => hook.chatId === chatId
