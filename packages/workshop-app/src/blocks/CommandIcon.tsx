import { commandGlyph, type ComposerCommand } from './composerCommand'

/** A command's glyph, drawn. */
export const CommandIcon = ({ command, className }: { command: Pick<ComposerCommand, 'kind' | 'name'>; className?: string }) => {
  const Glyph = commandGlyph(command)
  return <Glyph aria-hidden="true" className={className} />
}
