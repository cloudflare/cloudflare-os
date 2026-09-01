import { DropdownMenu } from "@cloudflare/kumo";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

type ComposerModelSelectorProps = {
  models: readonly AiChatAuthorInfo[];
  selectedModel: string | null;
  onModelChange: (modelId: string | null) => void;
};

export const ComposerModelSelector = ({
  models,
  selectedModel,
  onModelChange,
}: ComposerModelSelectorProps) => {
  const selectedModelLabel = selectedModel == null
    ? "No agent"
    : models.find((model) => model.id === selectedModel)?.name ?? selectedModel;

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
          const active = selectedModel === model.id;
          return (
            <DropdownMenu.Item
              key={model.id}
              onClick={() => onModelChange(model.id)}
              className="!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
            >
              <span className="min-w-0 flex-1 truncate">{model.name}</span>
              {active && (
                <Check
                  size={12}
                  weight="bold"
                  className="ml-3 flex-shrink-0 text-kumo-inactive"
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
              className="ml-3 flex-shrink-0 text-kumo-inactive"
            />
          )}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
};
