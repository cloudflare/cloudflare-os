export const prepareChatAttachment = async (
  file: File,
): Promise<{ blob: Blob; mimeType: string }> => {
  // The workspace receives the original file, not a resized/re-encoded model input.
  return { blob: file, mimeType: file.type || "application/octet-stream" };
};
