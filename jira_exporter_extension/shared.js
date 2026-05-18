(() => {
  const STORAGE_KEYS = {
    exportCount: "jiraExporter.exportCount",
  };

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  }

  function storageSet(items) {
    return new Promise((resolve) => {
      chrome.storage.local.set(items, resolve);
    });
  }

  async function getState() {
    const items = await storageGet([STORAGE_KEYS.exportCount]);
    return {
      exportCount: Number(items[STORAGE_KEYS.exportCount] || 0),
    };
  }

  async function saveState(partial) {
    const payload = {};
    if (Object.prototype.hasOwnProperty.call(partial, "exportCount")) {
      payload[STORAGE_KEYS.exportCount] = Number(partial.exportCount || 0);
    }
    await storageSet(payload);
  }

  async function resetState() {
    await storageSet({
      [STORAGE_KEYS.exportCount]: 0,
    });
  }

  function normalizeBaseUrl(baseUrl) {
    return String(baseUrl || "").replace(/\/+$/, "");
  }

  function inferBaseUrlFromUrl(pageUrl) {
    if (!pageUrl) return "";
    try {
      const parsed = new URL(String(pageUrl));
      const pathname = parsed.pathname || "/";
      const lower = pathname.toLowerCase();
      const markers = [
        "/browse/",
        "/secure/",
        "/projects/",
        "/issues/",
        "/plugins/servlet/",
        "/login.jsp",
      ];
      let cutIndex = -1;
      for (const marker of markers) {
        const markerIndex = lower.indexOf(marker);
        if (markerIndex >= 0 && (cutIndex < 0 || markerIndex < cutIndex)) {
          cutIndex = markerIndex;
        }
      }
      const basePath = cutIndex >= 0 ? pathname.slice(0, cutIndex) : pathname;
      const normalizedPath = basePath.replace(/\/+$/, "");
      return normalizedPath ? `${parsed.origin}${normalizedPath}` : parsed.origin;
    } catch {
      return "";
    }
  }

  function issueKeyFromUrl(url) {
    if (!url) return "";
    const match = String(url).match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i);
    return match ? match[1].toUpperCase() : "";
  }

  function sanitizeFilename(value, fallback = "jira-export") {
    return String(value || fallback)
      .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
      .replace(/\s+/g, " ")
      .trim() || fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function adfToText(node) {
    if (node == null) return "";
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(adfToText).join("");
    if (typeof node !== "object") return String(node);
    if (typeof node.text === "string") return node.text;
    const content = Array.isArray(node.content) ? node.content : [];
    return content.map(adfToText).join("");
  }

  function normalizeDisplayValue(value) {
    if (value == null) return "";
    if (Array.isArray(value)) {
      return value.map(normalizeDisplayValue).filter(Boolean).join(", ");
    }
    if (typeof value === "object") {
      for (const key of ["displayName", "name", "value", "key", "summary"]) {
        if (value[key]) return String(value[key]);
      }
      return JSON.stringify(value);
    }
    return String(value);
  }

  function renderKeyValueTable(rows) {
    const htmlRows = [];
    for (const [key, value] of rows) {
      if (value === undefined || value === null || value === "") continue;
      htmlRows.push(`<tr><th>${escapeHtml(key)}</th><td>${value}</td></tr>`);
    }
    if (!htmlRows.length) {
      return '<div class="muted">无</div>';
    }
    return `<table class="kv-table"><tbody>${htmlRows.join("")}</tbody></table>`;
  }

  const render_key_value_table = renderKeyValueTable;

  function getAttachmentKind(attachment) {
    const mime = String(attachment?.mimeType || "").toLowerCase();
    const filename = String(attachment?.filename || "").toLowerCase();
    if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)$/.test(filename)) {
      return "image";
    }
    if (
      mime.startsWith("text/") ||
      /\.(txt|log|csv|json|md|xml|yaml|yml|rtf|sql)$/i.test(filename)
    ) {
      return "text";
    }
    return "binary";
  }

  function blobToDataUrl(blob) {
    if (typeof FileReaderSync !== 'undefined') {
      const reader = new FileReaderSync();
      return reader.readAsDataURL(blob);
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function blobToBytes(blob) {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }

  function waitForDownload(downloadId) {
    return new Promise((resolve, reject) => {
      const listener = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === "complete") {
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        } else if (delta.state?.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error(delta.error?.current || "Download interrupted"));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  }

  async function downloadBlobToFile(blob, filename, saveAs = false) {
    console.log('[downloadBlobToFile] blob size:', (blob.size / 1024 / 1024).toFixed(2), 'MB');
    const startTime = Date.now();

    // Try URL.createObjectURL first (works in regular pages/content scripts, not in service workers)
    if (typeof URL.createObjectURL === 'function') {
      const blobUrl = URL.createObjectURL(blob);
      console.log('[downloadBlobToFile] using blob URL');
      try {
        const downloadId = await chrome.downloads.download({
          url: blobUrl,
          filename,
          saveAs,
        });
        await waitForDownload(downloadId);
        console.log('[downloadBlobToFile] download complete via blob URL');
        return filename;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }

    // Fallback: use offscreen document (for service workers)
    console.log('[downloadBlobToFile] URL.createObjectURL unavailable, using offscreen document...');
    const hasDoc = await chrome.offscreen.hasDocument();
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Download large exported zip file',
      });
      console.log('[downloadBlobToFile] offscreen document created');
    }

    const buffer = await blob.arrayBuffer();
    console.log('[downloadBlobToFile] arrayBuffer ready, transferring to offscreen...');

    const result = await new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'offscreen-download' });
      let settled = false;

      port.onMessage.addListener(async (msg) => {
        if (settled) return;

        if (msg.type === 'blob-url') {
          console.log('[downloadBlobToFile] got blob URL from offscreen, starting chrome.downloads...');
          try {
            const downloadId = await chrome.downloads.download({
              url: msg.blobUrl,
              filename: msg.filename,
              saveAs,
            });
            console.log('[downloadBlobToFile] download started, id:', downloadId);
            await waitForDownload(downloadId);
            console.log('[downloadBlobToFile] download finished');
            settled = true;
            port.postMessage({ type: 'cleanup' });
            port.disconnect();
            resolve(msg.filename);
          } catch (e) {
            console.error('[downloadBlobToFile] download failed:', e?.message);
            settled = true;
            port.postMessage({ type: 'cleanup' });
            port.disconnect();
            reject(e);
          }
        } else if (msg.type === 'error') {
          settled = true;
          port.disconnect();
          reject(new Error(msg.error));
        }
      });

      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Offscreen document disconnected unexpectedly'));
      });

      port.postMessage({ type: 'download', filename, saveAs }, [buffer]);
    });

    await chrome.offscreen.closeDocument().catch(() => {});
    console.log('[downloadBlobToFile] download complete via offscreen, total time:', (Date.now() - startTime) / 1000, 's');
    return result;
  }

  const utf8Encoder = new TextEncoder();
  const crc32Table = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let j = 0; j < 8; j += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (~crc) >>> 0;
  }

  function dateToDos(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time =
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      Math.floor(date.getSeconds() / 2);
    const day =
      (((year - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f);
    return {
      time: time >>> 0,
      date: day >>> 0,
    };
  }

  function normalizeZipEntryName(name) {
    return String(name || "")
      .replace(/^\/+/, "")
      .replace(/\\/g, "/");
  }

  function bytesFromData(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === "string") {
      return utf8Encoder.encode(data);
    }
    return utf8Encoder.encode(String(data ?? ""));
  }

  function buildZipBlob(entries) {
    console.log('[buildZipBlob] entries count:', entries.length);
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    let totalDataSize = 0;

    for (const entry of entries) {
      const nameBytes = utf8Encoder.encode(normalizeZipEntryName(entry.name));
      const dataBytes = bytesFromData(entry.data);
      totalDataSize += dataBytes.length;
      const { time, date } = dateToDos(entry.date || new Date());
      const crc = crc32(dataBytes);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, time, true);
      localView.setUint16(12, date, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, dataBytes.length, true);
      localView.setUint32(22, dataBytes.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localView.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, dataBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, time, true);
      centralView.setUint16(14, date, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, dataBytes.length, true);
      centralView.setUint32(24, dataBytes.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + dataBytes.length;
    }

    let centralSize = 0;
    for (const part of centralParts) {
      centralSize += part.length;
    }

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(4, 0, true);
    eocdView.setUint16(6, 0, true);
    eocdView.setUint16(8, entries.length, true);
    eocdView.setUint16(10, entries.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, offset, true);
    eocdView.setUint16(20, 0, true);

    console.log('[buildZipBlob] total data bytes:', (totalDataSize / 1024 / 1024).toFixed(2), 'MB, local parts:', localParts.length, 'central parts:', centralParts.length);
    const blob = new Blob([...localParts, ...centralParts, eocd], {
      type: "application/zip",
    });
    console.log('[buildZipBlob] blob created, size:', (blob.size / 1024 / 1024).toFixed(2), 'MB');
    return blob;
  }

  async function fetchJson(baseUrl, path, params = {}) {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (!normalizedBaseUrl) {
      throw new Error("无法识别 Jira 地址，请先打开 Jira 页面。");
    }
    const url = new URL(`${normalizedBaseUrl}/${String(path).replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url.toString(), {
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url.pathname}`);
    }
    return response.json();
  }

  async function getIssueCount(baseUrl, jql) {
    const data = await fetchJson(baseUrl, "/rest/api/2/search", {
      jql,
      maxResults: 0,
      fields: "key",
    });
    return Number(data.total || 0);
  }

  async function getIssueKeys(baseUrl, jql) {
    const keys = [];
    let startAt = 0;
    while (true) {
      const data = await fetchJson(baseUrl, "/rest/api/2/search", {
        jql,
        startAt,
        maxResults: 100,
        fields: "key",
      });
      const issues = Array.isArray(data.issues) ? data.issues : [];
      for (const issue of issues) {
        if (issue && issue.key) keys.push(issue.key);
      }
      startAt += issues.length;
      if (!issues.length || startAt >= Number(data.total || 0)) break;
    }
    return keys;
  }

  async function getIssueBundle(baseUrl, issueKey) {
    const issue = await fetchJson(baseUrl, `/rest/api/2/issue/${issueKey}`, {
      fields: "*all",
      expand: "names,schema,renderedFields,changelog",
    });
    const fields = issue.fields || {};
    const comments = (fields.comment && fields.comment.comments) || [];
    const worklogs = (fields.worklog && fields.worklog.worklogs) || [];
    const changelog = (issue.changelog && issue.changelog.histories) || [];

    return {
      key: issue.key,
      issue,
      comments,
      worklogs,
      changelog,
      attachments: Array.isArray(fields.attachment) ? fields.attachment : [],
    };
  }

  async function fetchAttachmentBlob(baseUrl, attachment) {
    const href = attachment?.content || attachment?.self || "";
    if (!href) {
      throw new Error("missing content url");
    }
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (!normalizedBaseUrl) {
      throw new Error("无法识别 Jira 地址，请先打开 Jira 页面。");
    }
    const url = href.startsWith("http") ? href : new URL(href, normalizedBaseUrl).toString();
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "*/*",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for attachment`);
    }
    return { url, blob: await response.blob() };
  }

  function buildExportStamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      "_",
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join("");
  }

  function buildExportRootPath(date = new Date()) {
    return `jira_exporter_exports/export_${buildExportStamp(date)}`;
  }

  function buildAttachmentLocalPath(exportRoot, issueKey, attachment) {
    const attachmentId = sanitizeFilename(attachment?.id || "attachment", "attachment");
    const filename = sanitizeFilename(attachment?.filename || attachmentId, attachmentId);
    return `attachments/${attachmentId}_${filename}`;
  }

  async function prepareAttachmentExport(baseUrl, attachment, localPath) {
    const kind = getAttachmentKind(attachment);
    const { url, blob } = await fetchAttachmentBlob(baseUrl, attachment);
    const result = {
      kind,
      href: url,
      localPath,
      blob,
    };

    if (kind === "image") {
      result.dataUrl = await blobToDataUrl(blob);
    } else if (kind === "text") {
      result.text = await blob.text();
    }
    return result;
  }

  function renderTextBlock(value) {
    const text = typeof value === "string" ? value : adfToText(value);
    if (!String(text).trim()) return '<div class="muted">无</div>';
    return `<pre class="text-block">${escapeHtml(text)}</pre>`;
  }

  function renderComment(comment) {
    const author = normalizeDisplayValue(comment.author);
    const created = formatDate(comment.created);
    const updated = formatDate(comment.updated);
    return `
      <div class="item-card">
        <div class="item-head">
          <strong>${escapeHtml(author || "未知用户")}</strong>
          <span>${escapeHtml(created)}${updated ? ` · 更新 ${escapeHtml(updated)}` : ""}</span>
        </div>
        <div class="item-body">${renderTextBlock(comment.body)}</div>
      </div>
    `;
  }

  function renderChange(history) {
    const author = normalizeDisplayValue(history.author);
    const created = formatDate(history.created);
    const rows = (history.items || [])
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(item.field || "")}</td>
            <td>${escapeHtml(item.fromString || "")}</td>
            <td>${escapeHtml(item.toString || "")}</td>
          </tr>
        `,
      )
      .join("");
    return `
      <div class="item-card">
        <div class="item-head">
          <strong>${escapeHtml(author || "未知用户")}</strong>
          <span>${escapeHtml(created)}</span>
        </div>
        <div class="item-body">
          <table class="change-table">
            <thead><tr><th>字段</th><th>从</th><th>到</th></tr></thead>
            <tbody>${rows || "<tr><td colspan='3' class='muted'>无变更</td></tr>"}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderWorklog(worklog) {
    const author = normalizeDisplayValue(worklog.author);
    return `
      <tr>
        <td>${escapeHtml(author)}</td>
        <td>${escapeHtml(formatDate(worklog.started))}</td>
        <td>${escapeHtml(worklog.timeSpent || worklog.timeSpentSeconds || "")}</td>
        <td>${renderTextBlock(worklog.comment || "")}</td>
      </tr>
    `;
  }

  function renderAttachment(attachment) {
    const author = normalizeDisplayValue(attachment.author);
    const href = attachment.localPath || attachment.content || attachment.self || "";
    const remoteHref = attachment.content || attachment.self || "";
    const inline = attachment.inline || {};
    const title = attachment.filename || "attachment";
    const sourceText = attachment.localPath ? "本地文件" : "Jira 链接";

    const preview =
      inline.kind === "image" && inline.dataUrl
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer"><img class="attachment-image" src="${escapeHtml(inline.dataUrl)}" alt="${escapeHtml(title)}"></a>`
        : inline.kind === "text" && inline.text !== undefined
          ? `<details class="attachment-text"><summary>查看内容</summary><pre class="text-block attachment-text-block">${escapeHtml(inline.text)}</pre></details>`
          : inline.kind === "error"
            ? `<div class="attachment-error">附件预览失败：${escapeHtml(inline.error || "")}</div>`
            : "";

    return `
      <li class="attachment-item">
        <div class="attachment-meta-row">
          <a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>
          <span class="muted">${escapeHtml(attachment.mimeType || "")}</span>
          <span class="muted">${escapeHtml(author)}</span>
          <span class="muted">${escapeHtml(sourceText)}</span>
        </div>
        ${preview}
        ${!attachment.localPath && remoteHref ? `<div class="muted attachment-remote">原始链接：<a href="${escapeHtml(remoteHref)}" target="_blank" rel="noreferrer">${escapeHtml(remoteHref)}</a></div>` : ""}
      </li>
    `;
  }

  function renderAttachmentSummary(attachment) {
    const href = attachment.localPath || attachment.content || attachment.self || "";
    return `
      <li class="attachment-item">
        <div class="attachment-meta-row">
          <a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(attachment.filename || "attachment")}</a>
          <span class="muted">${escapeHtml(attachment.mimeType || "")}</span>
          <span class="muted">${escapeHtml(attachment.localPath ? "本地文件" : "Jira 链接")}</span>
        </div>
      </li>
    `;
  }

  function issueCardHtml(bundle) {
    if (bundle.error) {
      return `
        <section class="issue-card" id="${escapeHtml(bundle.key)}">
          <div class="issue-card__header">
            <div>
              <div class="issue-card__key">${escapeHtml(bundle.key)}</div>
              <h2>导出失败</h2>
            </div>
          </div>
          <div class="section">
            <div class="text-block">${escapeHtml(bundle.error)}</div>
          </div>
        </section>
      `;
    }

    const issue = bundle.issue || {};
    const fields = issue.fields || {};
    const labels = Array.isArray(fields.labels) ? fields.labels : [];
    return `
      <section class="issue-card" id="${escapeHtml(bundle.key)}">
        <div class="issue-card__header">
          <div>
            <div class="issue-card__key">${escapeHtml(bundle.key)}</div>
            <h2>${escapeHtml(fields.summary || "")}</h2>
          </div>
          <div class="issue-card__badges">
            <span>${escapeHtml(normalizeDisplayValue(fields.status))}</span>
            <span>${escapeHtml(normalizeDisplayValue(fields.priority))}</span>
          </div>
        </div>

        <div class="issue-grid">
          ${renderKeyValueTable([
            ["项目", normalizeDisplayValue(fields.project)],
            ["类型", normalizeDisplayValue(fields.issuetype)],
            ["报告人", normalizeDisplayValue(fields.reporter)],
            ["负责人", normalizeDisplayValue(fields.assignee)],
            ["创建时间", formatDate(fields.created)],
            ["更新时间", formatDate(fields.updated)],
            ["标签", labels.map((label) => `<span class="pill">${escapeHtml(label)}</span>`).join("")],
            ["附件数", bundle.attachments.length],
            ["评论数", bundle.comments.length],
            ["操作记录数", bundle.changelog.length],
            ["工时数", bundle.worklogs.length],
          ])}
        </div>

        <div class="section">
          <h3>描述</h3>
          ${renderTextBlock(fields.description || "")}
        </div>

        <div class="section">
          <h3>评论</h3>
          <div class="timeline">
            ${bundle.comments.length ? bundle.comments.map(renderComment).join("") : '<div class="muted">无评论</div>'}
          </div>
        </div>

        <div class="section">
          <h3>操作记录</h3>
          <div class="timeline">
            ${bundle.changelog.length ? bundle.changelog.map(renderChange).join("") : '<div class="muted">无操作记录</div>'}
          </div>
        </div>

        <div class="section">
          <h3>工时</h3>
          <table class="worklog-table">
            <thead><tr><th>作者</th><th>开始时间</th><th>耗时</th><th>备注</th></tr></thead>
            <tbody>
              ${bundle.worklogs.length ? bundle.worklogs.map(renderWorklog).join("") : '<tr><td colspan="4" class="muted">无工时记录</td></tr>'}
            </tbody>
          </table>
        </div>

        <div class="section">
          <h3>附件</h3>
          <ul class="attachment-list">
            ${bundle.attachments.length ? bundle.attachments.map(renderAttachment).join("") : '<li class="muted">无附件</li>'}
          </ul>
        </div>
      </section>
    `;
  }

  function renderAttachmentCatalog(bundle) {
    const items = bundle.attachments
      .map((attachment) => {
        const href = attachment.localPath || attachment.content || attachment.self || "";
        return `
          <li class="attachment-item">
            <div class="attachment-meta-row">
              <a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(attachment.filename || "attachment")}</a>
              <span class="muted">${escapeHtml(attachment.localPath ? "已下载" : "远程链接")}</span>
            </div>
          </li>
        `;
      })
      .join("");
    return `<ul class="attachment-list">${items || '<li class="muted">无附件</li>'}</ul>`;
  }

  function buildIssueMetadata(bundle, exportedAt, exportPath) {
    const issue = bundle.issue || {};
    const fields = issue.fields || {};
    const labels = Array.isArray(fields.labels) ? fields.labels : [];
    return {
      key: bundle.key,
      id: issue.id || "",
      summary: fields.summary || "",
      status: normalizeDisplayValue(fields.status),
      priority: normalizeDisplayValue(fields.priority),
      project: normalizeDisplayValue(fields.project),
      issueType: normalizeDisplayValue(fields.issuetype),
      labels,
      created: fields.created || "",
      updated: fields.updated || "",
      commentCount: bundle.comments.length,
      changelogCount: bundle.changelog.length,
      worklogCount: bundle.worklogs.length,
      attachmentCount: bundle.attachments.length,
      exportedAt,
      exportPath,
      downloadedAttachments: bundle.attachments.map((attachment) => ({
        id: attachment.id || "",
        filename: attachment.filename || "",
        mimeType: attachment.mimeType || "",
        saved_to: attachment.localPath || "",
        error: attachment.inline?.kind === "error" ? attachment.inline.error || "" : "",
      })),
    };
  }

  function renderIssueDetailHtml(bundle, metadata) {
    const issue = bundle.issue || {};
    const fields = issue.fields || {};
    const issueKey = metadata?.key || bundle.key;
    const summary = metadata?.summary || fields.summary || "";

    const body = [];
    body.push('<div class="hero">');
    body.push(`<h1>${escapeHtml(issueKey)}</h1>`);
    body.push(`<h2>${escapeHtml(summary)}</h2>`);
    body.push('<div class="meta-line">');
    body.push(`<span>状态: ${escapeHtml(metadata?.status || normalizeDisplayValue(fields.status))}</span>`);
    body.push(`<span>优先级: ${escapeHtml(metadata?.priority || normalizeDisplayValue(fields.priority))}</span>`);
    body.push(`<span>项目: ${escapeHtml(metadata?.project || normalizeDisplayValue(fields.project))}</span>`);
    body.push(`<span>更新时间: ${escapeHtml(formatDate(fields.updated))}</span>`);
    body.push("</div>");
    body.push('<div class="top-actions">');
    body.push(`<a class="button-link" href="${relative_href("../index.html")}">返回总览</a>`);
    body.push('<a class="button-link" href="issue.json">原始 issue.json</a>');
    body.push('<a class="button-link" href="comments.json">comments.json</a>');
    body.push('<a class="button-link" href="changelog.json">changelog.json</a>');
    body.push('<a class="button-link" href="worklogs.json">worklogs.json</a>');
    body.push('<a class="button-link" href="metadata.json">metadata.json</a>');
    body.push("</div>");
    body.push("</div>");

    body.push('<div class="section"><h3>基础信息</h3><div class="section-body">');
    body.push(
      render_key_value_table([
        ["Key", issueKey],
        ["摘要", summary],
        ["项目", metadata?.project || normalize_display_value(fields.project)],
        ["类型", metadata?.issueType || normalize_display_value(fields.issuetype)],
        ["状态", metadata?.status || normalize_display_value(fields.status)],
        ["优先级", metadata?.priority || normalize_display_value(fields.priority)],
        ["负责人", normalize_display_value(fields.assignee)],
        ["报告人", normalize_display_value(fields.reporter)],
        ["创建时间", format_timestamp(fields.created)],
        ["更新时间", format_timestamp(fields.updated)],
        ["解决结果", normalize_display_value(fields.resolution)],
        ["截止日期", normalize_display_value(fields.duedate)],
        ["标签", format_issue_labels(fields.labels || [])],
        ["组件", normalize_display_value(fields.components || [])],
        ["影响版本", normalize_display_value(fields.versions || [])],
        ["修复版本", normalize_display_value(fields.fixVersions || [])],
        ["环境", text_to_html_block(fields.environment)],
        ["描述", text_to_html_block(fields.description)],
        ["子任务数", (fields.subtasks || []).length],
        ["附件数", metadata?.attachmentCount || 0],
        ["评论数", metadata?.commentCount || 0],
        ["操作记录数", metadata?.changelogCount || 0],
        ["工时记录数", metadata?.worklogCount || 0],
      ])
    );
    body.push("</div></div>");

    body.push('<div class="section"><h3>附件</h3><div class="section-body">');
    body.push(render_attachments(fields.attachment || [], metadata?.downloadedAttachments || []));
    body.push("</div></div>");

    body.push('<div class="section"><h3>评论</h3><div class="section-body">');
    body.push(render_comments(bundle.comments));
    body.push("</div></div>");

    body.push('<div class="section"><h3>操作记录</h3><div class="section-body">');
    body.push(render_changelog_items(bundle.changelog));
    body.push("</div></div>");

    body.push('<div class="section"><h3>工时记录</h3><div class="section-body">');
    body.push(render_worklogs(bundle.worklogs));
    body.push("</div></div>");

    body.push('<div class="section"><h3>导出信息</h3><div class="section-body">');
    body.push(
      render_key_value_table([
        ["导出路径", metadata?.exportPath || ""],
        ["导出时间", metadata?.exportedAt || ""],
        ["附件下载", metadata?.attachmentCount ? "已开启" : "无附件"],
      ])
    );
    body.push("</div></div>");

    return html_document(`${issueKey} - ${summary}`, body.join(""));
  }

  function buildSummaryHtml({ jiraUrl, jql, exportedAt, usage, bundles }) {
    const rows = bundles
      .map((bundle) => {
        const fields = bundle.issue?.fields || {};
        const issueLink = `issues/${encodeURIComponent(bundle.key)}/index.html`;
        return `
          <tr>
            <td><a href="${escapeHtml(issueLink)}"><strong>${escapeHtml(bundle.key)}</strong></a></td>
            <td>${escapeHtml(fields.summary || "")}</td>
            <td>${escapeHtml(normalizeDisplayValue(fields.status))}</td>
            <td>${escapeHtml(normalizeDisplayValue(fields.priority))}</td>
            <td>${escapeHtml(formatDate(fields.updated))}</td>
            <td>${escapeHtml(String(bundle.attachments?.length || 0))}</td>
            <td>${escapeHtml(String(bundle.comments?.length || 0))}</td>
            <td>${escapeHtml(String(bundle.changelog?.length || 0))}</td>
            <td>${escapeHtml(String(bundle.worklogs?.length || 0))}</td>
          </tr>
        `;
      })
      .join("");

    const body = [];
    body.push('<div class="hero">');
    body.push("<h1>Jira 导出总览</h1>");
    body.push("<p>便于直接打开查看的 HTML 报告，同时保留 JSON/CSV 原始备份。</p>");
    body.push('<div class="meta-line">');
    body.push(`<span>JQL: ${escapeHtml(jql)}</span>`);
    body.push(`<span>单子数量: ${escapeHtml(String(bundles.length))}</span>`);
    body.push(`<span>导出时间: ${escapeHtml(exportedAt)}</span>`);
    body.push(`<span>Jira: ${escapeHtml(jiraUrl)}</span>`);
    body.push(`<span>累计导出: ${escapeHtml(String(usage.exportCount || 0))}</span>`);
    body.push("</div>");
    body.push('<div class="top-actions">');
    body.push('<a class="button-link" href="index.csv">下载索引 CSV</a>');
    body.push('<a class="button-link" href="manifest.json">查看清单 JSON</a>');
    body.push("</div>");
    body.push("</div>");

    body.push('<div class="section">');
    body.push("<h3>问题列表</h3>");
    body.push('<div class="section-body">');
    body.push('<table class="issue-list">');
    body.push("<thead><tr><th>Key</th><th>摘要</th><th>状态</th><th>优先级</th><th>更新时间</th><th>附件</th><th>评论</th><th>操作记录</th><th>工时</th></tr></thead>");
    body.push(`<tbody>${rows || '<tr><td colspan="9" class="muted">无单子</td></tr>'}</tbody>`);
    body.push("</table>");
    body.push("</div>");
    body.push("</div>");

    return html_document("Jira 导出总览", body.join(""));
  }

  function buildReportHtml({ jiraUrl, jql, exportedAt, exportRoot, usage, bundles }) {
    const summaryItems = [
      ["Jira", jiraUrl],
      ["JQL", jql],
      ["导出时间", exportedAt],
      ["导出目录", exportRoot],
      ["导出单数", bundles.length],
      ["累计导出", `${usage.exportCount}`],
    ];

    const tableOfContents = bundles
      .map(
        (bundle) => `
          <a class="toc-item" href="#${escapeHtml(bundle.key)}">
            <strong>${escapeHtml(bundle.key)}</strong>
            <span>${escapeHtml(bundle.issue?.fields?.summary || "")}</span>
          </a>
        `,
      )
      .join("");

    return `
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Jira 导出报告</title>
  <style>
    :root {
      --bg: #f6f8fc;
      --panel: #ffffff;
      --ink: #0f172a;
      --muted: #64748b;
      --line: #dbe3f0;
      --accent: #0f766e;
      --accent-2: #2563eb;
      --shadow: 0 16px 34px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: var(--ink);
      background: linear-gradient(180deg, #eef4ff 0%, #f8fafc 100%);
    }
    .shell { max-width: 1440px; margin: 0 auto; padding: 24px; }
    .hero {
      background: linear-gradient(135deg, #0f172a, #1e293b);
      color: #fff;
      border-radius: 24px;
      padding: 24px;
      box-shadow: var(--shadow);
    }
    .hero h1 { margin: 0 0 8px; font-size: 30px; }
    .hero p { margin: 0; color: #dbeafe; }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .summary-card {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 16px;
      padding: 12px 14px;
    }
    .summary-card span { display: block; color: #bfdbfe; font-size: 12px; margin-bottom: 4px; }
    .summary-card strong { font-size: 15px; }
    .toc, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      margin-top: 22px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .toc h2, .panel h2 {
      margin: 0;
      padding: 16px 18px;
      border-bottom: 1px solid var(--line);
      font-size: 18px;
    }
    .toc-grid {
      display: grid;
      gap: 12px;
      padding: 16px 18px 20px;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .toc-item {
      display: block;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 16px;
      text-decoration: none;
      color: inherit;
      background: linear-gradient(180deg, #fff, #f8fbff);
    }
    .toc-item strong { display: block; margin-bottom: 6px; }
    .toc-item span { color: var(--muted); font-size: 13px; }
    .issue-card {
      margin: 18px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 22px;
      background: #fff;
    }
    .issue-card__header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 18px;
    }
    .issue-card__key { font-size: 13px; color: var(--accent); font-weight: 700; letter-spacing: 0.04em; }
    .issue-card h2 { margin: 4px 0 0; line-height: 1.35; }
    .issue-card__badges span {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      margin-left: 8px;
      border-radius: 999px;
      background: #eff6ff;
      color: #1d4ed8;
      border: 1px solid #bfdbfe;
      font-size: 12px;
      white-space: nowrap;
    }
    .issue-grid {
      display: grid;
      gap: 14px;
      margin-bottom: 18px;
    }
    .kv-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .kv-table th, .kv-table td {
      border-bottom: 1px solid var(--line);
      text-align: left;
      padding: 10px 12px;
      vertical-align: top;
      word-break: break-word;
    }
    .kv-table th { width: 170px; color: #334155; background: #fafcff; }
    .section { margin-top: 18px; }
    .section h3 { margin: 0 0 12px; font-size: 16px; }
    .timeline { display: grid; gap: 12px; }
    .item-card {
      border: 1px solid var(--line);
      border-radius: 16px;
      overflow: hidden;
      background: #fff;
    }
    .item-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      background: #f8fbff;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 13px;
    }
    .item-body { padding: 14px; }
    .text-block {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.7;
      font-family: inherit;
      background: #f8fafc;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px 14px;
    }
    .change-table, .worklog-table {
      width: 100%;
      border-collapse: collapse;
    }
    .change-table th, .change-table td,
    .worklog-table th, .worklog-table td {
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
    }
    .attachment-list {
      margin: 0;
      padding-left: 20px;
      line-height: 1.7;
    }
    .attachment-item {
      margin-bottom: 16px;
    }
    .attachment-meta-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .attachment-list a { color: var(--accent-2); text-decoration: none; }
    .attachment-image {
      display: block;
      max-width: 100%;
      max-height: 520px;
      margin-top: 10px;
      border-radius: 14px;
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }
    .attachment-text {
      margin-top: 10px;
    }
    .attachment-text summary {
      cursor: pointer;
      color: var(--accent);
      font-weight: 600;
    }
    .attachment-text-block {
      margin-top: 8px;
      max-height: 520px;
      overflow: auto;
      background: #0f172a;
      color: #e2e8f0;
    }
    .attachment-error {
      margin-top: 10px;
      padding: 10px 12px;
      border-radius: 12px;
      background: #fef2f2;
      color: #b91c1c;
      border: 1px solid #fecaca;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      margin: 0 6px 6px 0;
      padding: 5px 10px;
      border-radius: 999px;
      background: #eef2ff;
      color: #3730a3;
      border: 1px solid #c7d2fe;
      font-size: 12px;
    }
    .muted { color: var(--muted); }
    @media (max-width: 720px) {
      .issue-card { margin: 12px; padding: 14px; }
      .issue-card__header { flex-direction: column; }
      .issue-card__badges span { margin-left: 0; margin-right: 8px; }
      .kv-table th { width: 120px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <h1>Jira 导出报告</h1>
      <p>附件会保存到本地导出目录，zip 文件也会一起下载到本地，不再只是远程链接。</p>
      <div class="summary">
        ${summaryItems
          .map(
            ([label, value]) => `
              <div class="summary-card">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(value)}</strong>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>

    <section class="toc">
      <h2>目录</h2>
      <div class="toc-grid">${tableOfContents || '<div class="muted">无单子</div>'}</div>
    </section>

    <section class="panel">
      <h2>明细</h2>
      ${bundles.map(issueCardHtml).join("")}
    </section>
  </div>
</body>
</html>
    `;
  }

  async function exportByJql(baseUrl, jql, { download = true } = {}) {
    const startTime = Date.now();
    console.log('[exportByJql] === START === jql:', jql);
    const exportedDate = new Date();
    const exportedAt = exportedDate.toLocaleString("zh-CN", { hour12: false });
    const exportRoot = buildExportRootPath(exportedDate);
    const state = await getState();
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (!normalizedBaseUrl) {
      throw new Error("无法识别 Jira 地址，请先打开 Jira 页面。");
    }

    console.log('[exportByJql] getting issue count...');
    const totalCount = await getIssueCount(normalizedBaseUrl, jql);
    console.log('[exportByJql] totalCount:', totalCount);
    if (totalCount === 0) {
      throw new Error("未找到匹配的 Jira 单子，请检查 JQL 是否正确（注意：状态名等字段可能需要使用英文/内部名称）。");
    }

    console.log('[exportByJql] getting issue keys...');
    const keys = await getIssueKeys(normalizedBaseUrl, jql);
    console.log('[exportByJql] got', keys.length, 'keys');

    const bundles = [];
    const zipEntries = [];
    let processedCount = 0;
    for (const key of keys) {
      processedCount++;
      const issueStart = Date.now();
      try {
        console.log(`[exportByJql] [${processedCount}/${keys.length}] fetching ${key}...`);
        const bundle = await getIssueBundle(normalizedBaseUrl, key);
        const bundleAttCount = bundle.attachments.length;
        console.log(`[exportByJql] [${processedCount}/${keys.length}] ${key}: ${bundleAttCount} attachments, ${bundle.comments.length} comments, took ${(Date.now() - issueStart) / 1000}s`);

        const exportedAttachments = [];
        let attIdx = 0;
        for (const attachment of bundle.attachments) {
          attIdx++;
          const localPath = buildAttachmentLocalPath(exportRoot, key, attachment);
          try {
            const exported = await prepareAttachmentExport(normalizedBaseUrl, attachment, localPath);
            exportedAttachments.push({
              ...attachment,
              localPath,
              href: exported.href,
              inline: {
                kind: exported.kind,
                dataUrl: exported.dataUrl,
                text: exported.text,
                  href: exported.href,
                },
            });
            if (exported.blob) {
              const attachmentBytes = await blobToBytes(exported.blob);
              console.log(`[exportByJql]   attachment [${attIdx}/${bundleAttCount}] ${attachment.filename}: ${(attachmentBytes.length / 1024).toFixed(1)}KB`);
              zipEntries.push({
                name: `${exportRoot}/${localPath}`,
                data: attachmentBytes,
              });
            }
          } catch (error) {
            console.warn(`[exportByJql]   attachment [${attIdx}/${bundleAttCount}] ${attachment.filename} FAILED:`, error?.message || error);
            exportedAttachments.push({
              ...attachment,
              href: attachment.content || attachment.self || "",
              localPath: "",
              inline: {
                kind: "error",
                error: error?.message || String(error),
              },
            });
          }
        }
        bundles.push({
          ...bundle,
          attachments: exportedAttachments,
        });
        zipEntries.push({
          name: `${exportRoot}/issues/${key}/issue.json`,
          data: JSON.stringify(bundle.issue, null, 2),
        });
        zipEntries.push({
          name: `${exportRoot}/issues/${key}/comments.json`,
          data: JSON.stringify(bundle.comments, null, 2),
        });
        zipEntries.push({
          name: `${exportRoot}/issues/${key}/changelog.json`,
          data: JSON.stringify(bundle.changelog, null, 2),
        });
        zipEntries.push({
          name: `${exportRoot}/issues/${key}/worklogs.json`,
          data: JSON.stringify(bundle.worklogs, null, 2),
        });
        console.log(`[exportByJql] [${processedCount}/${keys.length}] ${key} done, total zip entries so far: ${zipEntries.length}`);
      } catch (error) {
        console.error(`[exportByJql] [${processedCount}/${keys.length}] ${key} FAILED:`, error?.message || error);
        bundles.push({
          key,
          error: error?.message || String(error),
          issue: null,
          comments: [],
          worklogs: [],
          changelog: [],
          attachments: [],
        });
      }
    }

    console.log('[exportByJql] all issues processed. bundles:', bundles.length, 'zip entries:', zipEntries.length);
    console.log('[exportByJql] building report HTML...');
    const reportStart = Date.now();
    const lightBundles = bundles.map((bundle) => ({
      ...bundle,
      attachments: bundle.attachments.map((att) => {
        const { inline, ...rest } = att;
        return rest;
      }),
    }));
    const reportHtml = buildReportHtml({
      jiraUrl: baseUrl,
      jql,
      exportedAt,
      exportRoot,
      usage: state,
      bundles: lightBundles,
    });
    console.log('[exportByJql] report HTML size:', (reportHtml.length / 1024 / 1024).toFixed(2), 'MB, took', (Date.now() - reportStart) / 1000, 's');

    zipEntries.unshift({
      name: `${exportRoot}/summary.html`,
      data: reportHtml,
    });

    const manifest = {
      jiraUrl: baseUrl,
      jql,
      exportedAt,
      exportRoot,
      issueCount: bundles.length,
      exportCountBefore: state.exportCount,
      exportCountAfter: state.exportCount + bundles.length,
      issues: bundles.map((bundle) => ({
        key: bundle.key,
        summary: bundle.issue?.fields?.summary || "",
        attachmentCount: bundle.attachments.length,
        error: bundle.error || "",
      })),
    };

    zipEntries.unshift({
      name: `${exportRoot}/manifest.json`,
      data: JSON.stringify(manifest, null, 2),
    });

    console.log('[exportByJql] building zip blob with', zipEntries.length, 'entries...');
    const zipStart = Date.now();
    const zipBlob = buildZipBlob(zipEntries);
    console.log('[exportByJql] zip blob size:', (zipBlob.size / 1024 / 1024).toFixed(2), 'MB, took', (Date.now() - zipStart) / 1000, 's');

    const newExportCount = state.exportCount + bundles.length;

    if (download) {
      console.log('[exportByJql] downloading...');
      await downloadBlobToFile(zipBlob, `${exportRoot}.zip`);
      await saveState({ exportCount: newExportCount });
    }

    console.log('[exportByJql] === DONE === total time:', (Date.now() - startTime) / 1000, 's');

    return {
      ok: true,
      total: bundles.length,
      reportHtml,
      exportedAt,
      exportRoot,
      zipPath: `${exportRoot}.zip`,
      ...(download ? {} : { zipBlob, newExportCount }),
    };
  }

  const globalScope = typeof window !== "undefined" ? window : self;
  globalScope.JiraExporterShared = {
    getState,
    saveState,
    resetState,
    normalizeBaseUrl,
    inferBaseUrlFromUrl,
    issueKeyFromUrl,
    sanitizeFilename,
    escapeHtml,
    formatDate,
    adfToText,
    normalizeDisplayValue,
    fetchJson,
    getIssueCount,
    getIssueKeys,
    getIssueBundle,
    buildReportHtml,
    exportByJql,
    getAttachmentKind,
    prepareAttachmentExport,
    buildExportRootPath,
    buildAttachmentLocalPath,
    renderAttachmentSummary,
  };
})();
