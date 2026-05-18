(() => {
  const shared = window.JiraExporterShared;
  const jqlInput = document.getElementById("jqlInput");
  const status = document.getElementById("status");
  const exportJqlButton = document.getElementById("exportJql");

  function setStatus(message) {
    status.textContent = message || "";
  }

  async function getActiveTabContext() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";
    const baseUrl = shared.inferBaseUrlFromUrl(url);
    const key = shared.issueKeyFromUrl(url);
    if (key) {
      if (!jqlInput.value.trim()) {
        jqlInput.value = `id = ${key}`;
      }
    }
    return { key, baseUrl };
  }

  async function startExport(jql, button) {
    const { baseUrl, key } = await getActiveTabContext();
    const value = String(jqlInput.value || jql || "").trim();
    if (!value && key) {
      jqlInput.value = `id = ${key}`;
    }
    const finalJql = String(jqlInput.value || jql || "").trim();
    if (!finalJql) {
      setStatus("请先输入 JQL。");
      return;
    }

    if (!baseUrl) {
      setStatus("无法识别 Jira 地址，请先打开 Jira 页面。");
      return;
    }

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "导出中...";
    setStatus("开始导出...");

    try {
      const result = await shared.exportByJql(baseUrl, finalJql);
      setStatus(`已导出 ${result.total} 个单子 → ${result.zipPath}`);
    } catch (e) {
      setStatus(`导出失败：${e.message || e}`);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  exportJqlButton.addEventListener("click", async () => {
    await startExport(jqlInput.value, exportJqlButton);
  });

  getActiveTabContext().catch((error) => {
    setStatus(`读取默认 JQL 失败：${error.message || error}`);
  });
})();
