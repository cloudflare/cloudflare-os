import {
  WORKSPACE_FILE_QUOTA_BYTES,
  WORKSPACE_STORAGE_LIMIT_BYTES,
  WORKSPACE_TURN_QUOTA_BYTES,
} from "@gadgets/workshop-shared/api";

const gigabytes = (bytes: number) => (bytes / 1e9).toFixed(1);

/**
 * What to tell someone about a workspace's storage once it is filling up: how much it holds, and
 * what has stopped working as it fills.
 */
export const storageNotice = (storageBytes: number) => {
  const used = `${gigabytes(storageBytes)} of ${WORKSPACE_STORAGE_LIMIT_BYTES / 1e9} GB used.`;
  // Nothing frees a workspace's storage yet, so the way on is another workspace.
  const elsewhere = "To keep working with large files, use another workspace.";
  if (storageBytes >= WORKSPACE_TURN_QUOTA_BYTES) {
    return {
      variant: "error" as const,
      title: "This workspace's storage is full",
      description: `${used} Agents can't run here, and new files over 1 MB can't be stored. ${elsewhere}`,
    };
  }
  if (storageBytes >= WORKSPACE_FILE_QUOTA_BYTES) {
    return {
      variant: "error" as const,
      title: "This workspace's storage is nearly full",
      description: `${used} New files over 1 MB, such as attachments, can't be stored. ${elsewhere}`,
    };
  }
  return {
    variant: "alert" as const,
    title: "This workspace's storage is filling up",
    description: `${used} New files over 1 MB are stored only while the workspace stays within ` +
      `${WORKSPACE_FILE_QUOTA_BYTES / 1e9} GB.`,
  };
};
