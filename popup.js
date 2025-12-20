const exportInteractiveBtn = document.getElementById("exportInteractiveBtn");
const exportStaticBtn = document.getElementById("exportStaticBtn");
const mhtmlBtn = document.getElementById("mhtmlBtn");
const statusEl = document.getElementById("status");

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = `status ${kind || ""}`.trim();
}

function setBusy(busy) {
  exportInteractiveBtn.disabled = busy;
  exportStaticBtn.disabled = busy;
  mhtmlBtn.disabled = busy;
}

async function runExport(options) {
  setBusy(true);
  setStatus("Exporting…", "");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "START_EXPORT", options });
    if (!resp?.ok) throw new Error(resp?.error || "Export failed");
    const filename = resp.result?.filename || "(unknown filename)";
    const stats = resp.result?.stats;
    const statsText = stats
      ? `Assets: ${stats.assetCandidates}, inlined: ${stats.inlined}, failed: ${stats.failed}`
      : "";
    setStatus(`Done: ${filename}\n${statsText}`, "ok");
  } catch (err) {
    setStatus(String(err?.message || err), "error");
  } finally {
    setBusy(false);
  }
}

exportInteractiveBtn.addEventListener("click", async () => {
  await runExport({ keepScripts: true, keepHashLinks: false });
});

exportStaticBtn.addEventListener("click", async () => {
  await runExport({ keepScripts: false, disableInteractions: true, keepHashLinks: false });
});

mhtmlBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Saving MHTML…", "");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "SAVE_MHTML" });
    if (!resp?.ok) throw new Error(resp?.error || "MHTML export failed");
    setStatus(`MHTML saved: ${resp.filename}`, "ok");
  } catch (err) {
    setStatus(String(err?.message || err), "error");
  } finally {
    setBusy(false);
  }
});
