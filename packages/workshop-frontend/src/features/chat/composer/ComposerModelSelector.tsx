import { DropdownMenu } from "@cloudflare/kumo";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

/**
 * The composer's model, or null for "No agent". `name` labels it when `models` doesn't offer it,
 * such as a hidden model an existing chat last ran on; the raw id is shown when that is absent too.
 */
export type SelectedModel = { id: string; name?: string } | null;

type ComposerModelSelectorProps = {
  models: readonly AiChatAuthorInfo[];
  selectedModel: SelectedModel;
  /**
   * True until the user's models and preferred model are known. With no model selected, a
   * placeholder then stands in for the selector, since "No agent" would read as a choice.
   */
  loading?: boolean;
  onModelChange: (modelId: string | null) => void;
};

export const ComposerModelSelector = ({
  models,
  selectedModel,
  loading = false,
  onModelChange,
}: ComposerModelSelectorProps) => {
  if (loading && selectedModel == null) {
    return (
      <span
        role="status"
        aria-label="Loading models"
        className="inline-flex h-10 items-center gap-1.5 px-2 sm:h-8"
      >
        {/* The trigger's own box and caret, so only the label changes when the models arrive.
            The bar stays hidden for the first 200ms, which a load on a healthy connection beats. */}
        <span className="h-2 w-16 animate-pulse rounded-full bg-kumo-tint opacity-0 [animation-delay:200ms]" />
        <CaretDown size={12} weight="bold" className="flex-shrink-0 text-kumo-inactive opacity-50" />
      </span>
    );
  }

  const selectedModelLabel = selectedModel == null
    ? "No agent"
    : models.find((model) => model.id === selectedModel.id)?.name ??
      selectedModel.name ?? selectedModel.id;

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="group inline-flex h-10 min-w-0 max-w-[110px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[14px] leading-5 text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default sm:h-8 sm:max-w-[180px] sm:text-[13px]"
            aria-label="Select model"
          >
            <span className="min-w-0 truncate">{selectedModelLabel}</span>
            <CaretDown
              size={12}
              weight="bold"
              className="flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
            />
          </button>
        }
      />
      <DropdownMenu.Content className="themed-floating-shadow-lg !z-[1100] !min-w-[190px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1">
        {models.map((model) => {
          const active = selectedModel?.id === model.id;
          return (
            <DropdownMenu.Item
              key={model.id}
              onClick={() => onModelChange(model.id)}
              className="!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{model.name}</span>
                {model.description && (
                  <span className="block truncate text-[11px] text-kumo-inactive">
                    {model.description}
                  </span>
                )}
              </span>
              {active && (
                <Check
                  size={12}
                  weight="bold"
                  className="ml-1 flex-shrink-0 text-kumo-inactive"
                />
              )}
            </DropdownMenu.Item>
          );
        })}
        <div className="my-1 border-t border-kumo-line/70" />
        <DropdownMenu.Item
          onClick={() => onModelChange(null)}
          className="!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
        >
          <span className="min-w-0 flex-1 truncate">No agent</span>
          {selectedModel == null && (
            <Check
              size={12}
              weight="bold"
              className="ml-1 flex-shrink-0 text-kumo-inactive"
            />
          )}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
};
