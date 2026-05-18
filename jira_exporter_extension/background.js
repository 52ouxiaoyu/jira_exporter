importScripts("shared.js");

// Legacy: message-based export (kept for backward compatibility)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type !== "start-export") return false;

  const jql = String(message.jql || "").trim();
  if (!jql) {
    sendResponse({ ok: false, error: "请先输入 JQL 或单号。" });
    return false;
  }

  (async () => {
    try {
      const baseUrl =
        self.JiraExporterShared.normalizeBaseUrl(message.baseUrl) ||
        self.JiraExporterShared.inferBaseUrlFromUrl(sender?.tab?.url || "");
      if (!baseUrl) {
        throw new Error("无法识别 Jira 地址，请先打开 Jira 页面。");
      }
      const result = await self.JiraExporterShared.exportByJql(
        baseUrl,
        jql,
      );
      sendResponse({ ok: true, ...result });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});

// Port-based export: popup handles the download so blob URLs work
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "export") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "start-export") return;

    const jql = String(msg.jql || "").trim();
    if (!jql) {
      port.postMessage({ type: "error", error: "请先输入 JQL 或单号。" });
      return;
    }

    try {
      const baseUrl =
        self.JiraExporterShared.normalizeBaseUrl(msg.baseUrl) ||
        self.JiraExporterShared.inferBaseUrlFromUrl(msg.tabUrl || "");
      if (!baseUrl) {
        throw new Error("无法识别 Jira 地址，请先打开 Jira 页面。");
      }

      const result = await self.JiraExporterShared.exportByJql(
        baseUrl,
        jql,
        { download: false },
      );

      const buffer = await result.zipBlob.arrayBuffer();
      port.postMessage(
        {
          type: "export-complete",
          total: result.total,
          exportedAt: result.exportedAt,
          exportRoot: result.exportRoot,
          filename: `${result.exportRoot}.zip`,
          newExportCount: result.newExportCount,
          buffer,
        },
        [buffer],
      );
    } catch (error) {
      port.postMessage({
        type: "error",
        error: error?.message || String(error),
      });
    }
  });

  // After popup confirms download, persist state
  port.onMessage.addListener(async (confirmMsg) => {
    if (confirmMsg.type === "download-complete") {
      await self.JiraExporterShared.saveState({
        exportCount: confirmMsg.newExportCount,
      });
      port.disconnect();
    }
  });
});
