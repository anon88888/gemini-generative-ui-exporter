# Gemini Generative UI Exporter (MV3)

[中文](#中文) · [English](#english)

---
2025.1.9 更新
修复原作者扩展只能下载一个对话框的第一个动态视图，现在新脚本能遍历下载所有存在的视图。
感谢原作者的脚本开发！

## 中文

把 Gemini 聊天里生成的「交互式 App / 生成式 UI」（通常渲染在 SafeContentFrame：`*.scf.usercontent.goog`）一键导出成**单文件 HTML**，方便离线保存/分享/归档。

一句话：打开 Gemini 里有「App/动态视图」的页面 → 点扩展 → `Export (Interactive)`（带点击+图片）或 `Export (Static)`（静态无点击）。

### 解决什么问题

- 图片是临时链接/签名链接 → 导出时尽量下载并内嵌为 `data:`（避免过期）
- 点击事件/脚本不好“删除” → 可切换成静态快照（移除脚本 + 禁用交互）

### 安装（Chrome）

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择目录：`gemini-exporter-extension`

### 使用

1. 打开 `https://gemini.google.com/`，进入包含「App」的对话（不是纯文本回复）。
2. 点扩展图标。
3. 点 `Export (Interactive)` 或 `Export (Static)`。
4. 会下载类似 `gemini-export-YYYYMMDD-HHMMSS.html` 的文件。

### 选项说明

- **Export (Interactive)**：保留 App 的 JS，导出后仍可交互；同时会尽量把动态图片（例如会回落成 `/gen?prompt=...` 的占位图）预抓取并内嵌，避免导出后变灰。
- **Export (Static)**：导出为“静态快照”风格（归档/截图模式），不想让页面再乱跳/切 Tab 时用。
- **Fallback: save tab as MHTML**：当 Chrome/权限导致无法访问子 frame 时的兜底方案。

### 注意 / 限制

- 默认导出当前页面里**最后一个**检测到的 generative UI frame（常见场景只有一个）。
- 交互式地图这类内容通常依赖第三方脚本（例如 Google Maps），导出后不一定能在 `file://` 下正常工作；想更稳定/离线可用，建议取消勾选 **Keep interactivity** 导出静态版。
- 如果导出时地图/某个 Tab 尚未渲染（仍在加载），导出文件里也可能缺失对应内容；导出前先切到对应 Tab 并等它加载完成。

### 排查

- 代码更新后：`chrome://extensions` → 扩展 →「重新加载」，再刷新 Gemini 标签页（⌘R）。
- 找不到 App：确认对话里确实有可交互卡片/页面，并等待其加载完成再导出。
- 够不着子 frame：确认扩展「网站访问权限」允许在所有网站上，必要时暂时关闭广告拦截/隐私/翻译类扩展再试。

---

## English

One-click export of Gemini “generative UI / app” responses (usually rendered inside a SafeContentFrame `*.scf.usercontent.goog`) into a **single self-contained HTML file** for offline archiving/sharing.

One-liner: open a Gemini chat with an interactive app → click the extension → `Export (Interactive)` (interactive) or `Export (Static)` (static).

### What it solves

- Images are temporary/signed URLs → download & inline as `data:` when possible (avoid expiry)
- Click handlers / scripts are hard to “remove” → export as a static snapshot (remove scripts + disable interactions)

### Install (Chrome)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select folder: `gemini-exporter-extension`

### Use

1. Open `https://gemini.google.com/` and open a chat that contains an interactive “app” (not plain text only).
2. Click the extension icon.
3. Click `Export (Interactive)` or `Export (Static)`.
4. A file like `gemini-export-YYYYMMDD-HHMMSS.html` downloads.

### Options

- **Export (Interactive)**: keep the app JS so the export stays interactive; the exporter also tries to pre-capture dynamic images (e.g. apps that would fall back to `/gen?prompt=...` placeholders) and embed them as `data:` URLs.
- **Export (Static)**: “static snapshot” / archive mode to prevent navigation and UI toggles.
- **Fallback: save tab as MHTML**: use Chrome’s built-in capture when the extension can’t reach the subframe.

### Notes / limitations

- Exports the **last** generative UI frame found on the current Gemini page (works for the common case where there’s only one).
- Interactive maps often depend on third-party JS (e.g. Google Maps) and may not work reliably when opened from `file://`. For a more stable/offline export, uncheck **Keep interactivity**.
- If a tab/section hasn’t rendered yet (still loading), it may be missing from the export. Switch to that tab and wait until it finishes loading before exporting.

### Troubleshooting

- After updating code: `chrome://extensions` → reload the extension, then reload the Gemini tab.
- “No app frame found”: make sure the chat contains an interactive card/app and it’s fully loaded.
- “Can’t reach subframe”: ensure the extension has “all sites” access; temporarily disable adblock/privacy/translate extensions and retry.
