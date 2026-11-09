import { AgentMark, ChatCloudMark, FolderBadge } from '../../components/icons/brandMarks'
import { workspaceInitials } from '../workspaces/workspaceInitials'

/** What a chat row's glyph stands for. */
export type ChatGlyphKind =
  | { kind: 'workspace'; title: string }
  | { kind: 'agent' }
  | { kind: 'chat' }

/**
 * The 35px mark at the start of a chat row (Figma "Frame 735"): the folder badge of the named
 * workspace a chat belongs to, the sparkle cloud for a chat an agent started, or the plain cloud for
 * a chat in no workspace.
 */
export const ChatGlyph = ({ glyph, size = 35 }: { glyph: ChatGlyphKind; size?: number }) => (
  <span className="flex shrink-0 items-center justify-center text-kumo-default" style={{ width: size, height: size }}>
    {glyph.kind === 'workspace' ? (
      <FolderBadge initials={workspaceInitials(glyph.title)} size={size} />
    ) : glyph.kind === 'agent' ? (
      <AgentMark size={size} />
    ) : (
      <ChatCloudMark size={size * 30 / 35} />
    )}
  </span>
)
