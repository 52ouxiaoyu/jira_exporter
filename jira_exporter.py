import argparse
import csv
import html
import getpass
import json
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urljoin

import requests

DEFAULT_JIRA_URL = "http://192.168.120.33:2800"
DEFAULT_USERNAME = os.getenv("JIRA_USERNAME", "")
DEFAULT_PASSWORD = os.getenv("JIRA_PASSWORD", "")

REQUEST_TIMEOUT = 30
SEARCH_PAGE_SIZE = 100
EXPORT_ROOT = Path("./jira_exporter_exports")
HTML_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def get_credentials_interactive():
    username_prompt = "请输入您的Jira用户名"
    if DEFAULT_USERNAME:
        username_prompt += "（也可以直接回车使用环境变量中的默认值）"
    username = input(f"{username_prompt}: ") or DEFAULT_USERNAME

    password_prompt = "请输入您的Jira密码"
    if DEFAULT_PASSWORD:
        password_prompt += "（也可以直接回车使用环境变量中的默认值）"
    password = getpass.getpass(f"{password_prompt}: ") or DEFAULT_PASSWORD

    if not username:
        raise ValueError("未提供 Jira 用户名。请在环境变量 JIRA_USERNAME 中设置，或手动输入。")
    if not password:
        raise ValueError("未提供 Jira 密码。请在环境变量 JIRA_PASSWORD 中设置，或手动输入。")

    return username, password


def get_jira_url_interactive():
    jira_url = input(f"请输入Jira服务器地址 (默认: {DEFAULT_JIRA_URL}): ").strip()
    return jira_url or DEFAULT_JIRA_URL


def safe_filename(value, default="unknown"):
    text = str(value or default).strip()
    text = re.sub(r"[\\/:*?\"<>|\r\n\t]+", "_", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text or default


def ensure_parent(path):
    path.parent.mkdir(parents=True, exist_ok=True)


def write_json(path, payload):
    ensure_parent(path)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def write_csv(path, rows):
    ensure_parent(path)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)


def join_issue_url(path, jira_url):
    return urljoin(jira_url.rstrip("/") + "/", path.lstrip("/"))


class JiraClient:
    def __init__(self, username, password, jira_url):
        self.session = requests.Session()
        self.session.auth = (username, password)
        self.session.headers.update({"Content-Type": "application/json"})
        self.base_url = jira_url.rstrip("/")

    def get_json(self, api_path, params=None, timeout=REQUEST_TIMEOUT):
        api_url = f"{self.base_url}/rest/api/2/{api_path.lstrip('/')}"
        response = self.session.get(api_url, params=params, timeout=timeout)
        response.raise_for_status()
        return response.json()

    def check_login(self):
        print("\n正在验证您的身份...")
        try:
            user_info = self.get_json("myself", timeout=10)
            user_display_name = user_info.get("displayName", user_info.get("name", ""))
            print(f"\033[92m身份验证成功！欢迎您, {user_display_name}\033[0m")
            return True
        except requests.exceptions.HTTPError as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            if status_code in {401, 403}:
                print("\033[91m身份验证失败！请检查凭据或CAPTCHA。\033[0m")
            else:
                print(f"\033[91m身份验证失败，HTTP状态码: {status_code}\033[0m")
            return False
        except requests.exceptions.RequestException as exc:
            print(f"\033[91m无法连接Jira服务器: {exc}\033[0m")
            return False


def escape_html(value):
    return html.escape("" if value is None else str(value), quote=True)


def format_timestamp(value):
    if not value:
        return ""
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value).strftime(HTML_TIME_FORMAT)
    except ValueError:
        return str(value)


def normalize_display_value(value):
    if value is None:
        return ""
    if isinstance(value, dict):
        for key in ("displayName", "name", "value", "key", "summary"):
            if value.get(key):
                return str(value[key])
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return ", ".join(normalize_display_value(item) for item in value if item is not None)
    return str(value)


def adf_to_text(node):
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_to_text(item) for item in node)
    if isinstance(node, dict):
        node_type = node.get("type")
        content = node.get("content", [])
        if "text" in node and isinstance(node["text"], str):
            return node["text"]
        if node_type in {"paragraph", "heading", "blockquote", "listItem", "tableCell", "tableHeader"}:
            inner = "".join(adf_to_text(item) for item in content)
            return inner + ("\n" if node_type in {"paragraph", "heading", "blockquote", "listItem"} else "")
        if node_type in {"bulletList", "orderedList", "doc"}:
            return "".join(adf_to_text(item) for item in content)
        return "".join(adf_to_text(item) for item in content)
    return str(node)


def text_to_html_block(value):
    text = value
    if isinstance(value, (dict, list)):
        text = adf_to_text(value)
    return f'<pre class="text-block">{escape_html(text)}</pre>' if str(text).strip() else '<div class="muted">无</div>'


def render_key_value_table(rows):
    html_rows = []
    for key, value in rows:
        if value in (None, "", [], {}):
            continue
        html_rows.append(
            f"<tr><th>{escape_html(key)}</th><td>{value}</td></tr>"
        )
    if not html_rows:
        return '<div class="muted">无</div>'
    return f'<table class="kv-table">{"".join(html_rows)}</table>'


def format_issue_labels(labels):
    if not labels:
        return '<span class="muted">无</span>'
    return "".join(
        f'<span class="pill">{escape_html(label)}</span>' for label in labels
    )


def attachment_is_image(attachment):
    mime = (attachment.get("mimeType") or "").lower()
    filename = (attachment.get("filename") or "").lower()
    return mime.startswith("image/") or filename.endswith(
        (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff")
    )


def relative_href(path):
    return quote(Path(path).as_posix(), safe="/")


def html_document(title, body, extra_head=""):
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape_html(title)}</title>
  <style>
    :root {{
      --bg: #0f172a;
      --panel: #111827;
      --panel-2: #1f2937;
      --border: #334155;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-2: #22c55e;
      --warn: #f59e0b;
      --danger: #f87171;
      --pill-bg: #1e293b;
      --shadow: 0 12px 30px rgba(15, 23, 42, 0.28);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
      color: #0f172a;
    }}
    a {{ color: #0369a1; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .shell {{
      max-width: 1480px;
      margin: 0 auto;
      padding: 28px 20px 56px;
    }}
    .hero {{
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #334155 100%);
      color: var(--text);
      border-radius: 20px;
      padding: 28px 28px 24px;
      box-shadow: var(--shadow);
      position: relative;
      overflow: hidden;
    }}
    .hero::after {{
      content: "";
      position: absolute;
      inset: auto -120px -140px auto;
      width: 320px;
      height: 320px;
      background: radial-gradient(circle, rgba(56,189,248,0.28) 0%, rgba(56,189,248,0) 70%);
      pointer-events: none;
    }}
    .hero h1, .hero h2 {{
      margin: 0 0 8px;
      line-height: 1.2;
    }}
    .hero p {{
      margin: 0;
      color: #cbd5e1;
    }}
    .meta-line {{
      display: flex;
      flex-wrap: wrap;
      gap: 10px 14px;
      margin-top: 16px;
      color: #dbeafe;
      font-size: 14px;
    }}
    .meta-line span {{
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 999px;
      padding: 6px 10px;
    }}
    .section {{
      margin-top: 22px;
      background: rgba(255,255,255,0.82);
      backdrop-filter: blur(6px);
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 18px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }}
    .section h3 {{
      margin: 0;
      padding: 16px 18px;
      background: linear-gradient(90deg, rgba(15,23,42,0.04), rgba(15,23,42,0));
      border-bottom: 1px solid rgba(148, 163, 184, 0.25);
      font-size: 18px;
    }}
    .section-body {{
      padding: 18px;
    }}
    .kv-table {{
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }}
    .kv-table th {{
      width: 180px;
      text-align: left;
      vertical-align: top;
      padding: 10px 12px;
      color: #334155;
      border-bottom: 1px solid #e2e8f0;
      background: rgba(248, 250, 252, 0.9);
    }}
    .kv-table td {{
      padding: 10px 12px;
      border-bottom: 1px solid #e2e8f0;
      word-break: break-word;
      white-space: normal;
    }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 14px;
    }}
    .card {{
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      box-shadow: 0 8px 18px rgba(15,23,42,0.06);
      overflow: hidden;
    }}
    .card-header {{
      padding: 12px 14px;
      border-bottom: 1px solid #e2e8f0;
      background: linear-gradient(90deg, #f8fafc, #fff);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }}
    .card-header strong {{
      font-size: 14px;
    }}
    .card-body {{
      padding: 14px;
    }}
    .muted {{
      color: var(--muted);
    }}
    .pill {{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 0 6px 6px 0;
      padding: 5px 10px;
      border-radius: 999px;
      background: var(--pill-bg);
      color: #fff;
      font-size: 12px;
      line-height: 1.4;
    }}
    .badge {{
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid transparent;
      white-space: nowrap;
    }}
    .badge.priority-high {{
      background: #fff7ed;
      color: #c2410c;
      border-color: #fed7aa;
    }}
    .badge.priority-medium {{
      background: #eff6ff;
      color: #1d4ed8;
      border-color: #bfdbfe;
    }}
    .badge.priority-low {{
      background: #ecfdf5;
      color: #047857;
      border-color: #a7f3d0;
    }}
    .badge.priority-other {{
      background: #f8fafc;
      color: #475569;
      border-color: #cbd5e1;
    }}
    .text-block {{
      margin: 0;
      padding: 14px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.65;
      font-size: 14px;
    }}
    .timeline {{
      display: grid;
      gap: 14px;
    }}
    .timeline-item {{
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      overflow: hidden;
      background: #fff;
    }}
    .timeline-meta {{
      padding: 12px 14px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }}
    .timeline-body {{
      padding: 14px;
    }}
    .change-table {{
      width: 100%;
      border-collapse: collapse;
    }}
    .change-table th, .change-table td {{
      padding: 8px 10px;
      border-bottom: 1px solid #e2e8f0;
      text-align: left;
      vertical-align: top;
      word-break: break-word;
    }}
    .attachments {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px;
    }}
    .attachment-card {{
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      background: #fff;
      overflow: hidden;
    }}
    .attachment-preview {{
      min-height: 180px;
      background: linear-gradient(135deg, #f8fafc, #eef2ff);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
    }}
    .attachment-preview img {{
      max-width: 100%;
      max-height: 280px;
      object-fit: contain;
      border-radius: 12px;
      box-shadow: 0 8px 18px rgba(15,23,42,0.08);
    }}
    .attachment-meta {{
      padding: 12px 14px 14px;
      border-top: 1px solid #e2e8f0;
      font-size: 13px;
    }}
    .attachment-meta .name {{
      font-weight: 600;
      margin-bottom: 6px;
      word-break: break-word;
    }}
    .top-actions {{
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }}
    .button-link {{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 9px 12px;
      border-radius: 10px;
      background: rgba(255,255,255,0.10);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.15);
    }}
    .button-link.light {{
      background: #fff;
      color: #0f172a;
      border-color: #cbd5e1;
    }}
    .issue-list {{
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      border-radius: 16px;
      overflow: hidden;
    }}
    .issue-list th, .issue-list td {{
      padding: 12px 10px;
      border-bottom: 1px solid #e2e8f0;
      text-align: left;
      vertical-align: top;
    }}
    .issue-list thead th {{
      background: #eff6ff;
      position: sticky;
      top: 0;
      z-index: 1;
    }}
    .small {{
      font-size: 12px;
    }}
    .spacer {{
      height: 8px;
    }}
    @media (max-width: 860px) {{
      .kv-table th {{
        width: 120px;
      }}
      .hero {{
        padding: 20px;
      }}
      .section-body {{
        padding: 14px;
      }}
    }}
  </style>
  {extra_head}
</head>
<body>
  <div class="shell">
    {body}
  </div>
</body>
</html>
"""


def render_issue_summary_html(export_dir, jql, issue_rows, manifest):
    issue_count = len(issue_rows)
    body_parts = [
        '<div class="hero">',
        "<h1>Jira 导出总览</h1>",
        "<p>便于直接打开查看的 HTML 报告，同时保留 JSON/CSV 原始备份。</p>",
        '<div class="meta-line">',
        f'<span>JQL: {escape_html(jql)}</span>',
        f'<span>单子数量: {issue_count}</span>',
        f'<span>导出时间: {escape_html(format_timestamp(manifest.get("exportedAt")))}</span>',
        f'<span>Jira: {escape_html(manifest.get("jiraUrl"))}</span>',
        "</div>",
        '<div class="top-actions">',
        f'<a class="button-link" href="{relative_href("index.csv")}">下载索引 CSV</a>',
        f'<a class="button-link" href="{relative_href("manifest.json")}">查看清单 JSON</a>',
        "</div>",
        "</div>",
        '<div class="section">',
        "<h3>问题列表</h3>",
        '<div class="section-body">',
        '<table class="issue-list">',
        "<thead><tr><th>Key</th><th>摘要</th><th>状态</th><th>优先级</th><th>更新时间</th><th>附件</th><th>评论</th></tr></thead>",
        "<tbody>",
    ]

    for row in issue_rows:
        issue_key = row.get("key", "")
        issue_link = relative_href(f"{issue_key}/index.html")
        status = row.get("status") or ""
        priority = row.get("priority") or ""
        priority_class = "priority-other"
        if priority in {"A", "B"}:
            priority_class = "priority-high"
        elif priority == "C":
            priority_class = "priority-medium"
        elif priority == "D":
            priority_class = "priority-low"
        body_parts.extend(
            [
                "<tr>",
                f'<td><a href="{escape_html(issue_link)}"><strong>{escape_html(issue_key)}</strong></a></td>',
                f'<td>{escape_html(row.get("summary") or "")}</td>',
                f'<td>{escape_html(status)}</td>',
                f'<td><span class="badge {priority_class}">{escape_html(priority)}</span></td>',
                f'<td>{escape_html(format_timestamp(row.get("updated")))}</td>',
                f'<td>{int(row.get("attachmentCount") or 0)}</td>',
                f'<td>{int(row.get("commentCount") or 0)}</td>',
                "</tr>",
            ]
        )

    body_parts.extend(
        [
            "</tbody>",
            "</table>",
            "</div>",
            "</div>",
        ]
    )

    return html_document("Jira 导出总览", "".join(body_parts))


def render_changelog_items(changelog):
    values = changelog.get("values", []) if isinstance(changelog, dict) else changelog
    if not values:
        return '<div class="muted">无操作记录</div>'

    items = []
    for history in values:
        author = normalize_display_value(history.get("author"))
        created = format_timestamp(history.get("created"))
        change_rows = []
        for item in history.get("items", []):
            change_rows.append(
                "<tr>"
                f'<td>{escape_html(item.get("field", ""))}</td>'
                f'<td>{escape_html(item.get("fromString", ""))}</td>'
                f'<td>{escape_html(item.get("toString", ""))}</td>'
                f'<td>{escape_html(item.get("fieldtype", ""))}</td>'
                "</tr>"
            )
        change_table = (
            '<table class="change-table">'
            "<thead><tr><th>字段</th><th>从</th><th>到</th><th>类型</th></tr></thead>"
            f"<tbody>{''.join(change_rows)}</tbody></table>"
        )
        items.append(
            f'<div class="timeline-item"><div class="timeline-meta"><strong>{escape_html(author or "未知用户")}</strong><span class="muted">{escape_html(created)}</span></div><div class="timeline-body">{change_table}</div></div>'
        )
    return f'<div class="timeline">{"".join(items)}</div>'


def render_comments(comments):
    items = comments.get("comments", []) if isinstance(comments, dict) else comments
    if not items:
        return '<div class="muted">无评论</div>'

    cards = []
    for comment in items:
        author = normalize_display_value(comment.get("author"))
        created = format_timestamp(comment.get("created"))
        updated = format_timestamp(comment.get("updated"))
        body = comment.get("body")
        cards.append(
            '<div class="timeline-item">'
            f'<div class="timeline-meta"><strong>{escape_html(author or "未知用户")}</strong><span class="muted">创建 {escape_html(created)}'
            + (f' · 更新 {escape_html(updated)}' if updated else "")
            + "</span></div>"
            f'<div class="timeline-body">{text_to_html_block(body)}</div>'
            "</div>"
        )
    return f'<div class="timeline">{"".join(cards)}</div>'


def render_worklogs(worklogs):
    items = worklogs.get("worklogs", []) if isinstance(worklogs, dict) else worklogs
    if not items:
        return '<div class="muted">无工时记录</div>'

    rows = []
    for worklog in items:
        author = normalize_display_value(worklog.get("author"))
        rows.append(
            "<tr>"
            f'<td>{escape_html(author)}</td>'
            f'<td>{escape_html(format_timestamp(worklog.get("started")))}</td>'
            f'<td>{escape_html(worklog.get("timeSpent") or worklog.get("timeSpentSeconds") or "")}</td>'
            f'<td>{text_to_html_block(worklog.get("comment"))}</td>'
            "</tr>"
        )
    return (
        '<table class="change-table">'
        "<thead><tr><th>作者</th><th>开始时间</th><th>耗时</th><th>备注</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table>"
    )


def render_attachments(attachments, exported_attachments):
    if not attachments:
        return '<div class="muted">无附件</div>'

    cards = []
    for attachment in attachments:
        filename = attachment.get("filename", "unknown")
        attachment_id = attachment.get("id")
        local_path = next(
            (
                item.get("saved_to")
                for item in exported_attachments
                if item.get("id") == attachment_id
            ),
            None,
        )
        preview = '<div class="muted">无预览</div>'
        if local_path and attachment_is_image(attachment):
            preview = f'<img src="{escape_html(relative_href(f"attachments/{Path(local_path).name}"))}" alt="{escape_html(filename)}">'
        elif local_path:
            preview = f'<a href="{escape_html(relative_href(f"attachments/{Path(local_path).name}"))}">打开文件</a>'

        status = "已下载" if local_path else "未下载"
        error = next(
            (
                item.get("error")
                for item in exported_attachments
                if item.get("id") == attachment_id and item.get("error")
            ),
            None,
        )

        cards.append(
            '<div class="attachment-card">'
            f'<div class="attachment-preview">{preview}</div>'
            '<div class="attachment-meta">'
            f'<div class="name">{escape_html(filename)}</div>'
            f'<div class="small muted">类型: {escape_html(attachment.get("mimeType") or "")}</div>'
            f'<div class="small muted">大小: {escape_html(attachment.get("size") or "")}</div>'
            f'<div class="small muted">作者: {escape_html(normalize_display_value(attachment.get("author")) or "")}</div>'
            f'<div class="small muted">创建: {escape_html(format_timestamp(attachment.get("created")))}</div>'
            f'<div class="small muted">状态: {escape_html(status)}</div>'
            + (f'<div class="small muted">错误: {escape_html(error)}</div>' if error else "")
            + (
                f'<div class="small"><a href="{escape_html(relative_href(f"attachments/{Path(local_path).name}"))}">下载/打开</a></div>'
                if local_path
                else ""
            )
            + "</div></div>"
        )
    return f'<div class="attachments">{"".join(cards)}</div>'


def render_issue_page(export_dir, metadata, issue_data, comments, changelog, worklogs):
    fields = issue_data.get("fields", {})
    issue_key = metadata.get("key") or issue_data.get("key") or "unknown"
    issue_dir = export_dir / safe_filename(issue_key)
    exported_attachments = metadata.get("downloadedAttachments", [])
    fetch_errors = metadata.get("fetchErrors", {})

    summary = metadata.get("summary") or fields.get("summary") or ""
    top_actions = [
        f'<a class="button-link" href="{relative_href("../index.html")}">返回总览</a>',
        f'<a class="button-link" href="issue.json">原始 issue.json</a>',
        f'<a class="button-link" href="comments.json">comments.json</a>',
        f'<a class="button-link" href="changelog.json">changelog.json</a>',
        f'<a class="button-link" href="worklogs.json">worklogs.json</a>',
        f'<a class="button-link" href="metadata.json">metadata.json</a>',
    ]
    if metadata.get("attachmentCount"):
        top_actions.append('<span class="button-link">附件已下载</span>')

    field_rows = [
        ("Key", issue_key),
        ("摘要", summary),
        ("项目", normalize_display_value(fields.get("project"))),
        ("类型", normalize_display_value(fields.get("issuetype"))),
        ("状态", normalize_display_value(fields.get("status"))),
        ("优先级", normalize_display_value(fields.get("priority"))),
        ("负责人", normalize_display_value(fields.get("assignee"))),
        ("报告人", normalize_display_value(fields.get("reporter"))),
        ("创建时间", format_timestamp(fields.get("created"))),
        ("更新时间", format_timestamp(fields.get("updated"))),
        ("解决结果", normalize_display_value(fields.get("resolution"))),
        ("截止日期", normalize_display_value(fields.get("duedate"))),
        ("标签", format_issue_labels(fields.get("labels", []))),
        ("组件", normalize_display_value(fields.get("components", []))),
        ("影响版本", normalize_display_value(fields.get("versions", []))),
        ("修复版本", normalize_display_value(fields.get("fixVersions", []))),
        ("环境", text_to_html_block(fields.get("environment"))),
        ("描述", text_to_html_block(fields.get("description"))),
        ("子任务数", len(fields.get("subtasks", []))),
        ("附件数", metadata.get("attachmentCount", 0)),
        ("评论数", metadata.get("commentCount", 0)),
        ("操作记录数", metadata.get("changelogCount", 0)),
        ("工时记录数", metadata.get("worklogCount", 0)),
    ]
    if fetch_errors:
        error_lines = "".join(
            f'<div class="small muted">{escape_html(k)}: {escape_html(v)}</div>'
            for k, v in fetch_errors.items()
        )
        field_rows.append(("抓取错误", error_lines))

    body = []
    body.append('<div class="hero">')
    body.append(f"<h1>{escape_html(issue_key)}</h1>")
    body.append(f"<h2>{escape_html(summary)}</h2>")
    body.append('<div class="meta-line">')
    body.append(f'<span>状态: {escape_html(normalize_display_value(fields.get("status")))}</span>')
    body.append(f'<span>优先级: {escape_html(normalize_display_value(fields.get("priority")))}</span>')
    body.append(f'<span>项目: {escape_html(normalize_display_value(fields.get("project")))}</span>')
    body.append(f'<span>更新时间: {escape_html(format_timestamp(fields.get("updated")))}</span>')
    body.append("</div>")
    body.append('<div class="top-actions">')
    body.extend(top_actions)
    body.append("</div>")
    body.append("</div>")

    body.append('<div class="section"><h3>基础信息</h3><div class="section-body">')
    body.append(render_key_value_table(field_rows))
    body.append("</div></div>")

    body.append('<div class="section"><h3>附件</h3><div class="section-body">')
    body.append(render_attachments(fields.get("attachment", []), exported_attachments))
    body.append("</div></div>")

    body.append('<div class="section"><h3>评论</h3><div class="section-body">')
    body.append(render_comments(comments))
    body.append("</div></div>")

    body.append('<div class="section"><h3>操作记录</h3><div class="section-body">')
    body.append(render_changelog_items(changelog))
    body.append("</div></div>")

    body.append('<div class="section"><h3>工时记录</h3><div class="section-body">')
    body.append(render_worklogs(worklogs))
    body.append("</div></div>")

    body.append('<div class="section"><h3>导出信息</h3><div class="section-body">')
    body.append(
        render_key_value_table(
            [
                ("导出路径", str(issue_dir)),
                ("导出时间", metadata.get("exportedAt")),
                ("附件下载", "已开启" if exported_attachments else "未下载或无附件"),
            ]
        )
    )
    body.append("</div></div>")

    return html_document(f"{issue_key} - {summary}", "".join(body))


class JiraIssueExporter:
    def __init__(self, jira_client, output_root, download_attachments=True):
        self.jira = jira_client
        self.output_root = Path(output_root)
        self.download_attachments = download_attachments

    def search_issue_keys(self, jql):
        keys = []
        start_at = 0

        while True:
            data = self.jira.get_json(
                "search",
                params={
                    "jql": jql,
                    "fields": "key",
                    "startAt": start_at,
                    "maxResults": SEARCH_PAGE_SIZE,
                },
                timeout=REQUEST_TIMEOUT,
            )
            issues = data.get("issues", [])
            for issue in issues:
                key = issue.get("key")
                if key:
                    keys.append(key)

            start_at += len(issues)
            if start_at >= data.get("total", 0) or not issues:
                break

        return keys

    def fetch_issue(self, issue_key):
        return self.jira.get_json(
            f"issue/{issue_key}",
            params={
                "fields": "*all",
                "expand": "names,schema,renderedFields",
            },
            timeout=REQUEST_TIMEOUT,
        )

    def fetch_all_comments(self, issue_key):
        return self._fetch_paginated_collection(
            f"issue/{issue_key}/comment",
            collection_key="comments",
        )

    def fetch_all_worklogs(self, issue_key):
        return self._fetch_paginated_collection(
            f"issue/{issue_key}/worklog",
            collection_key="worklogs",
        )

    def fetch_all_changelog(self, issue_key):
        start_at = 0
        histories = []

        while True:
            data = self.jira.get_json(
                f"issue/{issue_key}/changelog",
                params={
                    "startAt": start_at,
                    "maxResults": SEARCH_PAGE_SIZE,
                },
                timeout=REQUEST_TIMEOUT,
            )
            chunk = data.get("values")
            if chunk is None:
                chunk = data.get("histories", [])

            histories.extend(chunk)
            start_at += len(chunk)
            total = data.get("total", len(histories))
            if start_at >= total or not chunk:
                break

        return {
            "startAt": 0,
            "maxResults": len(histories),
            "total": len(histories),
            "values": histories,
        }

    def _fetch_paginated_collection(self, api_path, collection_key):
        start_at = 0
        items = []

        while True:
            data = self.jira.get_json(
                api_path,
                params={
                    "startAt": start_at,
                    "maxResults": SEARCH_PAGE_SIZE,
                },
                timeout=REQUEST_TIMEOUT,
            )
            chunk = data.get(collection_key, [])
            items.extend(chunk)
            start_at += len(chunk)
            total = data.get("total", len(items))
            if start_at >= total or not chunk:
                break

        return {
            "startAt": 0,
            "maxResults": len(items),
            "total": len(items),
            collection_key: items,
        }

    def download_attachment(self, attachment, destination_dir):
        destination_dir.mkdir(parents=True, exist_ok=True)

        attachment_id = attachment.get("id", "unknown")
        original_name = attachment.get("filename", f"attachment_{attachment_id}")
        filename = safe_filename(original_name)
        target_path = destination_dir / f"{attachment_id}_{filename}"

        content_url = attachment.get("content")
        if not content_url:
            return {
                "id": attachment_id,
                "filename": original_name,
                "saved_to": None,
                "error": "missing content url",
            }

        url = content_url if content_url.startswith("http") else join_issue_url(content_url, self.jira.base_url)

        try:
            response = self.jira.session.get(url, stream=True, timeout=REQUEST_TIMEOUT)
            response.raise_for_status()
            with open(target_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 128):
                    if chunk:
                        f.write(chunk)
            return {
                "id": attachment_id,
                "filename": original_name,
                "saved_to": str(target_path),
                "error": None,
            }
        except requests.exceptions.RequestException as exc:
            return {
                "id": attachment_id,
                "filename": original_name,
                "saved_to": str(target_path),
                "error": str(exc),
            }

    def export_issue(self, export_dir, issue_key, issue_data=None):
        issue_data = issue_data or self.fetch_issue(issue_key)

        fields = issue_data.get("fields", {})
        issue_dir = export_dir / safe_filename(issue_key)
        attachments_dir = issue_dir / "attachments"
        issue_dir.mkdir(parents=True, exist_ok=True)

        raw_issue_path = issue_dir / "issue.json"
        comments_path = issue_dir / "comments.json"
        changelog_path = issue_dir / "changelog.json"
        worklogs_path = issue_dir / "worklogs.json"
        write_json(raw_issue_path, issue_data)

        fetch_errors = {}

        try:
            comments = self.fetch_all_comments(issue_key)
        except requests.exceptions.RequestException as exc:
            comments = {"startAt": 0, "maxResults": 0, "total": 0, "comments": []}
            fetch_errors["comments"] = str(exc)

        try:
            changelog = self.fetch_all_changelog(issue_key)
        except requests.exceptions.RequestException as exc:
            changelog = {"startAt": 0, "maxResults": 0, "total": 0, "values": []}
            fetch_errors["changelog"] = str(exc)

        try:
            worklogs = self.fetch_all_worklogs(issue_key)
        except requests.exceptions.RequestException as exc:
            worklogs = {"startAt": 0, "maxResults": 0, "total": 0, "worklogs": []}
            fetch_errors["worklogs"] = str(exc)

        write_json(comments_path, comments)
        write_json(changelog_path, changelog)
        write_json(worklogs_path, worklogs)

        downloaded_attachments = []
        attachment_errors = []
        if self.download_attachments:
            for attachment in fields.get("attachment", []):
                result = self.download_attachment(attachment, attachments_dir)
                downloaded_attachments.append(result)
                if result.get("error"):
                    attachment_errors.append(result)

        metadata = {
            "key": issue_data.get("key"),
            "id": issue_data.get("id"),
            "summary": fields.get("summary"),
            "status": (fields.get("status") or {}).get("name"),
            "priority": (fields.get("priority") or {}).get("name"),
            "project": (fields.get("project") or {}).get("key"),
            "issueType": (fields.get("issuetype") or {}).get("name"),
            "labels": fields.get("labels", []),
            "created": fields.get("created"),
            "updated": fields.get("updated"),
            "commentCount": comments.get("total", len(comments.get("comments", []))),
            "changelogCount": changelog.get("total", len(changelog.get("values", []))),
            "worklogCount": worklogs.get("total", len(worklogs.get("worklogs", []))),
            "attachmentCount": len(fields.get("attachment", [])),
            "downloadedAttachments": downloaded_attachments,
            "attachmentErrors": attachment_errors,
            "fetchErrors": fetch_errors,
            "exportedAt": datetime.now().isoformat(timespec="seconds"),
            "exportPath": str(issue_dir),
        }

        write_json(issue_dir / "metadata.json", metadata)
        issue_html = render_issue_page(
            export_dir=export_dir,
            metadata=metadata,
            issue_data=issue_data,
            comments=comments,
            changelog=changelog,
            worklogs=worklogs,
        )
        with open(issue_dir / "index.html", "w", encoding="utf-8") as f:
            f.write(issue_html)

        index_row = [
            issue_data.get("key", ""),
            metadata["summary"] or "",
            metadata["status"] or "",
            metadata["priority"] or "",
            metadata["project"] or "",
            metadata["issueType"] or "",
            ";".join(metadata["labels"]) if metadata["labels"] else "",
            metadata["created"] or "",
            metadata["updated"] or "",
            metadata["attachmentCount"],
            metadata["commentCount"],
            metadata["changelogCount"],
            metadata["worklogCount"],
            metadata["exportPath"],
        ]
        return metadata, index_row

    def export(self, jql):
        self.output_root.mkdir(parents=True, exist_ok=True)
        export_stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        export_dir = self.output_root / f"export_{export_stamp}"
        export_dir.mkdir(parents=True, exist_ok=True)

        print(f"开始查询 JQL: {jql}")
        issue_keys = self.search_issue_keys(jql)
        print(f"共找到 {len(issue_keys)} 个符合条件的 Jira 单子。")

        index_rows = [[
            "key",
            "summary",
            "status",
            "priority",
            "project",
            "issueType",
            "labels",
            "created",
            "updated",
            "attachmentCount",
            "commentCount",
            "changelogCount",
            "worklogCount",
            "exportPath",
        ]]
        manifest = {
            "jql": jql,
            "jiraUrl": self.jira.base_url,
            "exportedAt": datetime.now().isoformat(timespec="seconds"),
            "issues": [],
        }
        issue_models = []

        for idx, issue_key in enumerate(issue_keys, start=1):
            print(f"[{idx}/{len(issue_keys)}] 导出 {issue_key} ...")
            try:
                issue_data = self.fetch_issue(issue_key)
                metadata, index_row = self.export_issue(export_dir, issue_key, issue_data=issue_data)
                index_rows.append(index_row)
                manifest["issues"].append(metadata)
                issue_models.append(metadata)
            except requests.exceptions.RequestException as exc:
                error_payload = {
                    "key": issue_key,
                    "error": str(exc),
                    "exportedAt": datetime.now().isoformat(timespec="seconds"),
                }
                issue_dir = export_dir / safe_filename(issue_key)
                issue_dir.mkdir(parents=True, exist_ok=True)
                write_json(issue_dir / "error.json", error_payload)
                error_html = html_document(
                    f"{issue_key} - 导出失败",
                    "".join(
                        [
                            '<div class="hero">',
                            f"<h1>{escape_html(issue_key)}</h1>",
                            "<h2>导出失败</h2>",
                            f'<div class="top-actions"><a class="button-link" href="{relative_href("../index.html")}">返回总览</a></div>',
                            "</div>",
                            '<div class="section"><h3>错误信息</h3><div class="section-body">',
                            render_key_value_table(
                                [
                                    ("Key", issue_key),
                                    ("错误", str(exc)),
                                    ("导出时间", error_payload["exportedAt"]),
                                ]
                            ),
                            "</div></div>",
                        ]
                    ),
                )
                with open(issue_dir / "index.html", "w", encoding="utf-8") as f:
                    f.write(error_html)
                manifest["issues"].append(error_payload)
                issue_models.append(
                    {
                        "key": issue_key,
                        "summary": "",
                        "status": "",
                        "priority": "",
                        "updated": "",
                        "attachmentCount": 0,
                        "commentCount": 0,
                    }
                )
                print(f"  导出失败: {exc}")

        write_json(export_dir / "manifest.json", manifest)
        write_csv(export_dir / "index.csv", index_rows)
        summary_html = render_issue_summary_html(export_dir, jql, issue_models, manifest)
        with open(export_dir / "index.html", "w", encoding="utf-8") as f:
            f.write(summary_html)
        with open(export_dir / "summary.html", "w", encoding="utf-8") as f:
            f.write(summary_html)

        print(f"导出完成，结果目录：{export_dir}")
        return export_dir


def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Export Jira issues that match a JQL filter, including attachments and history."
    )
    parser.add_argument(
        "--jql",
        help="JQL expression to export. Required; the script will not use a default query.",
    )
    parser.add_argument(
        "--output-root",
        default=str(EXPORT_ROOT),
        help="Root directory for exported data.",
    )
    parser.add_argument(
        "--no-attachments",
        action="store_true",
        help="Skip downloading attachment files.",
    )
    return parser


def main():
    parser = build_arg_parser()
    args = parser.parse_args()

    if not args.jql:
        parser.error(
            "请通过 --jql 指定筛选条件，例如: "
            "python jira_exporter.py --jql 'id = WIFI-54'"
        )

    jira_url = get_jira_url_interactive()
    jira_username, jira_password = get_credentials_interactive()
    jira_client = JiraClient(jira_username, jira_password, jira_url)

    if not jira_client.check_login():
        raise SystemExit(1)

    exporter = JiraIssueExporter(
        jira_client=jira_client,
        output_root=args.output_root,
        download_attachments=not args.no_attachments,
    )
    exporter.export(args.jql)


if __name__ == "__main__":
    main()
