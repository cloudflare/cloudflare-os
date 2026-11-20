import type { WorkspaceIconColor, WorkspaceIconShape } from '@/prefs/preferenceFields'

/**
 * The name of each shape a workspace's icon can be drawn as (`WORKSPACE_ICON_SHAPES`, the order
 * they are offered in). The folder is first: it is the one until another is chosen.
 */
export const WORKSPACE_SHAPES = {
  folder: 'Folder',
  briefcase: 'Briefcase',
  notepad: 'Notepad',
  stack: 'Stack',
  window: 'Window',
  house: 'House',
  building: 'Building',
  rocket: 'Rocket',
  cloud: 'Cloud',
  cone: 'Traffic cone',
  bulb: 'Light bulb',
  robot: 'Robot',
} as const satisfies Record<WorkspaceIconShape, string>

/**
 * The name of each colour a workspace's icon can be drawn in (`WORKSPACE_ICON_COLORS`, the order
 * they are offered in), and the class that fills with it. `contrast` is first: the page's opposite,
 * which the icon is in until another is chosen. The rest are `theme.css`'s.
 */
export const WORKSPACE_COLORS = {
  contrast: { name: 'Default', fill: 'fill-kumo-contrast' },
  red: { name: 'Red', fill: 'fill-(--color-workspace-red)' },
  orange: { name: 'Orange', fill: 'fill-(--color-workspace-orange)' },
  green: { name: 'Green', fill: 'fill-(--color-workspace-green)' },
  teal: { name: 'Teal', fill: 'fill-(--color-workspace-teal)' },
  blue: { name: 'Blue', fill: 'fill-(--color-workspace-blue)' },
  purple: { name: 'Purple', fill: 'fill-(--color-workspace-purple)' },
  pink: { name: 'Pink', fill: 'fill-(--color-workspace-pink)' },
} as const satisfies Record<WorkspaceIconColor, { name: string; fill: string }>
