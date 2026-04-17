importScripts("shared.js");

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
