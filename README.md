# Gemini Generative UI Exporter (MV3)

Exports Gemini “generative UI / app” responses (the interactive content rendered in a SafeContentFrame `*.scf.usercontent.goog`) into a **single self‑contained HTML file**.

This is designed to solve:

- Some images are temporary/signed URLs → exporter downloads and inlines them as `data:` URIs.
- Some click handlers / scripts are annoying / hard to remove → exporter makes a **static snapshot** by removing `<script>` tags and inline `on*=` handlers.

## Install (Chrome)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the folder: `gemini-exporter-extension`

## Use

1. Open `https://gemini.google.com/` and open a chat that contains a generated “app”.
2. Click the extension icon.
3. Click **Export current Gemini app**.
4. A file like `gemini-export-YYYYMMDD-HHMMSS.html` downloads.
5. Optional:
   - Toggle **Disable clicks** to freeze the export (archive/screenshot mode).
   - Toggle **Keep interactivity (keep scripts)** to keep the app’s JS (interactive mode). The exporter also tries to embed dynamic “/gen?prompt=…” images as `data:` URLs so they still show outside Gemini.

Alternative (when Chrome blocks subframe access):

- Use **Fallback: save tab as MHTML** to let Chrome capture the whole page even if the app frame is restricted.

## Notes / limitations

- It exports the **last** generative UI frame found in the current Gemini page (works for the common case where there’s just one).
- Export defaults to **Keep interactivity** (scripts kept). Uncheck it to export a **static snapshot** (scripts removed).
- If some assets fail to inline (site blocks fetching), the export still completes but some images/fonts may be missing.

## Troubleshooting

- If you updated the code, go to `chrome://extensions` and click **更新** for the extension, then reload the Gemini tab.
- If Export says it can’t find an app frame, make sure the page shows an interactive card/app (not just plain text), and the app is fully loaded before exporting.
- If it says it can’t reach the app subframe, try temporarily disabling adblock/privacy/translate extensions (they sometimes inject iframes that break “all frames” scripting).
