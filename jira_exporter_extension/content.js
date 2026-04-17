(() => {
  const shared = window.JiraExporterShared;
  if (!shared) return;

  const issueKey = shared.issueKeyFromUrl(location.href);
  const baseUrl = shared.inferBaseUrlFromUrl(location.href);
  if (!issueKey) return;

  const buttonId = "jira-exporter-floating-button";
  if (document.getElementById(buttonId)) return;

  const button = document.createElement("button");
  button.id = buttonId;
  button.type = "button";
  button.textContent = "导出当前单";
  button.style.cssText = `
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 2147483647;
    border: 1px solid #111827;
    border-radius: 999px;
    padding: 10px 14px;
    background: #111827;
    color: #fff;
    font-size: 13px;
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.18);
    cursor: pointer;
  `;

  function showToast(message) {
    const existing = document.getElementById("jira-exporter-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.id = "jira-exporter-toast";
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      right: 20px;
      bottom: 66px;
      z-index: 2147483647;
      padding: 8px 12px;
      border-radius: 10px;
      background: rgba(17, 24, 39, 0.96);
      color: #fff;
      font-size: 12px;
      box-shadow: 0 10px 22px rgba(15, 23, 42, 0.2);
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  button.addEventListener("click", async () => {
    if (button.disabled) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "导出中...";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "start-export",
        jql: `id = ${issueKey}`,
        baseUrl,
      });
      if (!response || !response.ok) {
        throw new Error(response?.error || "导出失败");
      }
      showToast("导出完成");
    } catch (error) {
      showToast("导出失败");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });

  const mount = () => {
    if (document.getElementById(buttonId)) return;
    document.body.appendChild(button);
  };

  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
    setTimeout(mount, 1500);
  }
})();
