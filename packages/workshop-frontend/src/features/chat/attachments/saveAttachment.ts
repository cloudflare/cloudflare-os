/** Hands bytes to the browser as a file download. */
export const saveAttachment = (bytes: Uint8Array, name: string | undefined, mimeType: string) => {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: mimeType || "application/octet-stream" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name ?? "attachment";
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
};
