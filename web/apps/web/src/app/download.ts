/*
 * Candidate for kern (#121, kern issue #92): the save-as-download helper (and a DownloadButton around
 * it). Until the design-kit freeze lifts it lives here with the other tool-facing pieces.
 */

/**
 * Offers a text or a blob as a download: an object URL of this browser, clicked once and given
 * back at once (the download keeps its own reference). Nothing is sent anywhere.
 */
export function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has taken what it needs when the click handler returns.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function saveText(name: string, text: string, type = 'text/plain'): void {
  saveBlob(name, new Blob([text], { type: `${type};charset=utf-8` }));
}
