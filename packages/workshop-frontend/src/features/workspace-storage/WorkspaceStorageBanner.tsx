import { Banner } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { storageNotice } from "./storageNotice";
import { useShortViewport } from "./useShortViewport";

/**
 * Warns, below the workspace's top bar, that its storage is filling up, once its metadata reports
 * how much it holds (`WorkspaceMetadata.storageBytes`). A window too short to give up the height
 * gets WorkspaceStorageIndicator in the top bar instead.
 */
export const WorkspaceStorageBanner = ({ storageBytes }: { storageBytes: number }) => {
  const short = useShortViewport();
  if (short) return null;
  return (
    <div className="shrink-0 px-4 pt-3 sm:px-6">
      <Banner icon={<WarningIcon />} {...storageNotice(storageBytes)} />
    </div>
  );
};
