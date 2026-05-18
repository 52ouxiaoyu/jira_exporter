# jira_exporter

`jira_exporter` 是一个独立的 Jira 导出工具，用来把你指定的 JQL 对应单子导出成可直接浏览的 HTML 报告，并保留原始数据和附件。

## 快速开始

1. 进入目录

```bash
cd jira_exporter
```

2. 安装依赖

```bash
pip install -r requirements.txt
```

3. 运行导出

```bash
python jira_exporter.py --jql 'project = WIFI'
```

4. 按提示输入 Jira 用户名和密码

5. 导出完成后打开 `summary.html`

## 运行规则

- `--jql` 必填，不传会直接报错退出，避免误抓太多内容
- Jira 服务器地址已经写在脚本里，不需要用户输入
- 用户名和密码可以手动输入

## 常用示例

导出单个 Jira：

```bash
python jira_exporter.py --jql 'project = WIFI'
```

导出一个项目下的单子：

```bash
python jira_exporter.py --jql 'project = WIFI ORDER BY updated DESC'
```

修改输出目录：

```bash
python jira_exporter.py --jql 'project = WIFI' --output-root ./jira_exporter_exports
```

不下载附件：

```bash
python jira_exporter.py --jql 'project = WIFI' --no-attachments
```

## 导出结果

脚本会生成一个带时间戳的目录，例如：

```text
jira_exporter_exports/
└── export_20260417_153000/
    ├── summary.html
    ├── index.html
    ├── index.csv
    ├── manifest.json
    └── WIFI-123/
        ├── index.html
        ├── issue.json
        ├── comments.json
        ├── changelog.json
        ├── worklogs.json
        ├── metadata.json
        └── attachments/
```

打开 `summary.html` 可以看总览页，点击某个单子就能进入详情页。

详情页会展示：

- 基本字段
- 描述
- 评论
- 操作记录
- 工时
- 附件预览和下载链接

## 注意事项

- 附件下载依赖 Jira 权限
- 这是一个“按 JQL 导出”的工具，不是全量 Jira 备份工具
