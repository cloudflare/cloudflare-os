/** Formats a timestamp as a compact age for skill-row metadata. */
export const formatSkillUpdatedAt = (date: Date, now = Date.now()): string => {
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
};

/** Describes a skill timestamp without relying on compact-unit abbreviations. */
export const skillUpdatedAtLabel = (date: Date, now = Date.now()): string => {
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `Updated ${days} day${days === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `Updated ${years} year${years === 1 ? "" : "s"} ago`;
};
