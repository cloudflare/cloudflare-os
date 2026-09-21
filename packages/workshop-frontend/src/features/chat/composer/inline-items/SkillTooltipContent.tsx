import { ScrollIcon } from "@phosphor-icons/react";

const SkillTooltipContent = ({
  name,
  description,
  providerLabel,
  resourceLabel,
  onMouseEnter,
  onMouseLeave,
}: {
  name: string;
  description: string;
  providerLabel: string;
  resourceLabel?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) => (
  <div
    data-skill-tooltip
    className="pointer-events-auto w-fit max-w-60 px-0.5 py-1.5 text-left"
    onMouseEnter={onMouseEnter}
    onMouseLeave={onMouseLeave}
  >
    <div className="flex items-center gap-1.5 text-[14px] font-medium text-kumo-default">
      <ScrollIcon size={14} className="shrink-0 text-kumo-default" />
      <span className="min-w-0 truncate">{name}</span>
    </div>
    <p className="m-0 mt-2 line-clamp-3 text-[13px] leading-[18px] text-kumo-subtle">
      {description}
    </p>
    <div className="mt-2.5 flex min-w-0 items-center gap-1.5 border-t border-kumo-line/70 pt-2.5 text-[12px] text-kumo-subtle">
      <span className="min-w-0 truncate font-medium">{providerLabel}</span>
      {resourceLabel && (
        <>
          <span className="shrink-0 text-kumo-inactive" aria-hidden="true">{"\u00b7"}</span>
          <span className="min-w-0 truncate text-kumo-inactive">{resourceLabel}</span>
        </>
      )}
    </div>
  </div>
);

export default SkillTooltipContent;
