import { Banner } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import {
  WORKSPACE_FILE_QUOTA_BYTES,
  WORKSPACE_STORAGE_LIMIT_BYTES,
  WORKSPACE_TURN_QUOTA_BYTES,
} from "@gadgets/workshop-shared/api";

const gigabytes = (bytes: number) => (bytes / 1e9).toFixed(1);

/**
 * Warns that the workspace's storage is filling up, once its metadata reports how much it holds
 * (`WorkspaceMetadata.storageBytes`), and says what has stopped working as it fills.
 */
export const WorkspaceStorageBanner = ({ storageBytes }: { storageBytes: number }) => {
  const used = `${gigabytes(storageBytes)} of ${WORKSPACE_STORAGE_LIMIT_BYTES / 1e9} GB used.`;
  // Nothing frees a workspace's storage yet, so the way on is another workspace.
  const elsewhere = "To keep working with large files, use another workspace.";
  const notice = storageBytes >= WORKSPACE_TURN_QUOTA_BYTES
    ? {
      variant: "error" as const,
      title: "This workspace's storage is full",
      description: `${used} Agents can't run here, and new files over 1 MB can't be stored. ${elsewhere}`,
    }
    : storageBytes >= WORKSPACE_FILE_QUOTA_BYTES
      ? {
        variant: "error" as const,
        title: "This workspace's storage is nearly full",
        description: `${used} New files over 1 MB, such as attachments, can't be stored. ${elsewhere}`,
      }
      : {
        variant: "alert" as const,
        title: "This workspace's storage is filling up",
        description: `${used} From ${WORKSPACE_FILE_QUOTA_BYTES / 1e9} GB, new files over 1 MB can't be stored.`,
      };
  return <Banner icon={<WarningIcon />} {...notice} />;
};
