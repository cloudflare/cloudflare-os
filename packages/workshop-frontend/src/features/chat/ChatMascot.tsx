import type { CSSProperties } from "react";
import styles from "./ChatMascot.module.css";

/** What a chat's mascot can show (see chatActivity() in ChatInterface). */
export type MascotFace = "idle" | "thinking" | "working" | "waiting" | "review";

// Chat ids count up from 0 within a workspace, so stepping the hue by the golden angle per id
// gives every chat a fixed colour, as far from its neighbours' as the wheel allows.
const GOLDEN_ANGLE = 137.50776405003785;
const FIRST_HUE = 35;

/**
 * A chat's mascot: a tile in the chat's own colour whose eyes show what its agent is doing.
 * Decorative; the caller states the activity in text.
 */
export const ChatMascot = ({ chatId, face, needsYou }: {
  chatId: number;
  face: MascotFace;
  /** The chat is waiting on the user's decision; marked with a badge whatever the face. */
  needsYou: boolean;
}) => {
  const style: CSSProperties & Record<"--mascot-hue" | "--mascot-phase", string> = {
    "--mascot-hue": String((FIRST_HUE + chatId * GOLDEN_ANGLE) % 360),
    // Offsets each chat's loops so a list of busy mascots doesn't move in lockstep.
    "--mascot-phase": `${-((chatId * 0.618034) % 1) * 2.4}s`,
  };

  return (
    <span className={styles.mascot} data-face={face} data-needs-you={needsYou || undefined}
      style={style} aria-hidden="true">
      <span className={styles.tile}>
        <span className={styles.eyes}>
          <span className={styles.eye} />
          <span className={styles.eye} />
        </span>
      </span>
      {needsYou && <span className={styles.badge} />}
    </span>
  );
};
