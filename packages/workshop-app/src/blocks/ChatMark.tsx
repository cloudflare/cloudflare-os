import { LogoIcon } from '@/components/LogoIcon'

/**
 * A chat's icon, as a workspace's is its folder: the app's cloud in the contrast colour, a little
 * lighter as the folder is, the sparkle a hole in it, in the room a workspace's icon takes so that
 * the two line up.
 */
export const ChatMark = () => (
  <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center text-[1.75rem] text-kumo-contrast/80">
    <LogoIcon mono />
  </span>
)
