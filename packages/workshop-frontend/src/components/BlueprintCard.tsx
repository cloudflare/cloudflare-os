import { useT, localizeBlueprintDisplay, localizeVendorDisplay } from '../i18n'
import { Link } from "@tanstack/react-router";
import {
  Hexagon,
  Robot,
  Lightning,
  Star,
} from "@phosphor-icons/react";
import {
  BlueprintBinding,
  BlueprintMetadata,
} from "@gadgets/workshop-shared/api";
import { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";

const gradients = [
  "from-[#4A154B] to-[#7C3085]",
  "from-[#0052CC] to-[#2684FF]",
  "from-[#5865F2] to-[#7983F5]",
  "from-[#34A853] to-[#4285F4]",
  "from-[#24292e] to-[#555]",
  "from-[#E01E5A] to-[#ECB22E]",
  "from-orange-600 to-red-600",
  "from-emerald-600 to-teal-600",
];

export function getGradient(id: string) {
  return gradients[id.charCodeAt(0) % gradients.length];
}

export type BindingBadgeInfo = {
  type: BlueprintBinding["type"];
  label: string;
  /** For gatekeeper bindings, the vendor key (e.g. "google", "github"). */
  vendorKey?: string;
};

/** Deduplicate binding types for display. Returns one badge per unique gatekeeper vendor
 *  and one per aiModel / agentSpawner type. */
export function uniqueBindingBadges(
  bindings: Record<string, BlueprintBinding>,
): BindingBadgeInfo[] {
  const seen = new Set<string>();
  const badges: BindingBadgeInfo[] = [];
  for (const b of Object.values(bindings)) {
    let key: string;
    let label: string;
    let vendorKey: string | undefined;
    if (b.type === "gatekeeper") {
      key = `gk:${b.gatekeeperName}`;
      vendorKey = b.gatekeeperName.toLowerCase();
      label =
        b.gatekeeperName.charAt(0).toUpperCase() + b.gatekeeperName.slice(1);
    } else if (b.type === "aiModel") {
      key = "aiModel";
      label = "AI Model";
    } else {
      key = "agentSpawner";
      label = "Agent";
    }
    if (!seen.has(key)) {
      seen.add(key);
      badges.push({ type: b.type, label, vendorKey });
    }
  }
  return badges;
}

export function BindingBadge({
  badge,
  vendorDescriptions,
}: {
  badge: BindingBadgeInfo;
  vendorDescriptions?: Map<string, VendorDescription>;
}) {
  const t = useT()
  const vendorDescription = badge.vendorKey
    ? vendorDescriptions?.get(badge.vendorKey)
    : undefined;

  let icon: React.ReactNode;
  if (vendorDescription?.logo?.url) {
    icon = (
      <img
        src={vendorDescription.logo.url}
        alt=""
        className="h-3 w-3 object-contain"
      />
    );
  } else if (badge.type === "aiModel") {
    icon = <Robot size={11} />;
  } else if (badge.type === "agentSpawner") {
    icon = <Lightning size={11} />;
  } else {
    icon = (
      <span className="text-[10px] font-semibold leading-none">
        {badge.label[0]}
      </span>
    );
  }

  const vendorLabel = vendorDescription
    ? localizeVendorDisplay(t, {
        id: badge.vendorKey,
        displayName: vendorDescription.displayName,
      }).displayName
    : badge.label
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-kumo-fill px-2 py-[3px] text-[11px] font-medium leading-none tracking-[-0.1px] text-kumo-subtle">
      <span className="flex items-center text-kumo-inactive">{icon}</span>
      {vendorLabel}
    </span>
  );
}

export function BlueprintCard({
  id,
  metadata,
  featured,
  vendorDescriptions,
}: {
  id: string;
  metadata: BlueprintMetadata;
  featured?: boolean;
  vendorDescriptions?: Map<string, VendorDescription>;
}) {
  const t = useT()
  const display = localizeBlueprintDisplay(t, { id, metadata })
  const badges = uniqueBindingBadges(metadata.bindings);

  return (
    <div className="themed-card-hover-shadow group relative isolate flex min-h-[150px] flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base text-left transition-[border-color,transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:border-kumo-fill active:scale-[0.995]">
      {featured && (
        <Star
          size={72}
          weight="fill"
          className="pointer-events-none absolute -right-4 -top-4 text-kumo-brand/10"
        />
      )}
      <Link
        to="/blueprint/$id"
        params={{ id }}
        aria-label={`Open blueprint ${display.title}`}
        className="absolute inset-0 z-10 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
      />
      <div className="pointer-events-none relative z-20 flex flex-1 flex-col p-4">
        <div className="flex items-start gap-3">
          <div
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${getGradient(id)}`}
          >
            <Hexagon size={16} className="text-white/75" weight="bold" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="m-0 line-clamp-2 text-[15px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
              {display.title}
            </p>
            <p className={`mt-1.5 line-clamp-2 min-h-8 text-[12px] leading-4 font-normal tracking-[-0.2px] ${metadata.description || display.description ? "text-kumo-subtle" : "text-kumo-inactive italic"}`}>
              {display.description || t('workspaces.noDescription')}
            </p>
          </div>
        </div>

        {badges.length > 0 && (
          <div className="mt-auto flex flex-wrap gap-1 pt-4">
            {badges.map((b) => (
              <BindingBadge
                key={b.vendorKey ?? b.type}
                badge={b}
                vendorDescriptions={vendorDescriptions}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
