import { DropdownMenu, Tooltip } from "@cloudflare/kumo";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { ChatMode } from "@gadgets/workshop-shared/api";

const MODES: readonly { mode: ChatMode; name: string; description: string }[] = [
  {
    mode: "auto",
    name: "Auto",
    description: "Applies the agent's changes when its turn ends, unless one needs your review.",
  },
  { mode: "review", name: "Review", description: "Holds the agent's changes until you accept them." },
  {
    mode: "fork",
    name: "Fork",
    description: "Holds every change, including your own in gadgets, until you accept.",
  },
];

const RESTRICTED_COPY = "Unavailable: this workspace has read sensitive data, so every change is reviewed.";

/** The composer's chat mode (see ChatMode), and how it may be changed. */
export type ComposerMode = {
  mode: ChatMode;
  /**
   * The workspace has read restricted data (WorkspaceMetadata.containsRestrictedData), which does
   * not permit Auto.
   */
  restricted: boolean;
  /** Absent for a user who may not change the mode, who is shown it read-only. */
  onModeChange?: (mode: ChatMode) => void;
};

const triggerClass =
  "inline-flex h-10 flex-shrink-0 items-center gap-1.5 rounded-lg px-2 text-[14px] leading-5 text-kumo-subtle sm:h-8 sm:text-[13px]";

export const ComposerModeSelector = ({ mode, restricted, onModeChange }: ComposerMode) => {
  const current = MODES.find((entry) => entry.mode === mode) ?? MODES[0];

  if (!onModeChange) {
    return (
      <Tooltip content={`${current.description} You can't change the mode in this workspace.`} asChild>
        <span tabIndex={0} aria-label={`Mode: ${current.name}`} className={triggerClass}>
          {current.name}
        </span>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className={`group cursor-pointer transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default ${triggerClass}`}
            aria-label={`Mode: ${current.name}`}
          >
            <span>{current.name}</span>
            <CaretDown
              size={12}
              weight="bold"
              className="flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
            />
          </button>
        }
      />
      <DropdownMenu.Content className="themed-floating-shadow-lg !z-[1100] w-[min(280px,calc(100vw-32px))] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1">
        {MODES.map((entry) => {
          const unavailable = restricted && entry.mode === "auto";
          return (
            <DropdownMenu.Item
              key={entry.mode}
              disabled={unavailable}
              onClick={() => {
                if (entry.mode !== mode) onModeChange(entry.mode);
              }}
              className="!h-auto items-start rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-kumo-default">{entry.name}</span>
                <span className="block text-[11px] text-kumo-inactive">
                  {unavailable ? RESTRICTED_COPY : entry.description}
                </span>
              </span>
              {entry.mode === mode && (
                <Check size={12} weight="bold" className="ml-1 mt-0.5 flex-shrink-0 text-kumo-inactive" />
              )}
            </DropdownMenu.Item>
          );
        })}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
};
