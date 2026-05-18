chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen-download') return;

  port.onMessage.addListener((msg) => {
    if (msg.type !== 'download') return;

    try {
      const blob = new Blob([msg.buffer], { type: 'application/zip' });
      const blobUrl = URL.createObjectURL(blob);
      port.postMessage({ type: 'blob-url', blobUrl, filename: msg.filename });

      // Wait for service worker to signal cleanup
      port.onMessage.addListener((response) => {
        if (response.type === 'cleanup') {
          URL.revokeObjectURL(blobUrl);
          port.disconnect();
        }
      });
    } catch (e) {
      port.postMessage({ type: 'error', error: e?.message || String(e) });
    }
  });
});
