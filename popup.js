const exportBtn = document.getElementById("exportBtn");
const mhtmlBtn = document.getElementById("mhtmlBtn");
const keepScriptsEl = document.getElementById("keepScripts");
const disableInteractionsEl = document.getElementById("disableInteractions");
const statusEl = document.getElementById("status");

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = `status ${kind || ""}`.trim();
}

function syncOptionsUi() {
  const keep = !!keepScriptsEl?.checked;
  if (!disableInteractionsEl) return;
  if (keep) {
    disableInteractionsEl.checked = false;
    disableInteractionsEl.disabled = true;
  } else {
    disableInteractionsEl.disabled = false;
  }
}

keepScriptsEl?.addEventListener("change", syncOptionsUi);
syncOptionsUi();

exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  mhtmlBtn.disabled = true;
  setStatus("Exporting…", "");
  try {
    const keepScripts = !!keepScriptsEl?.checked;
    const disableInteractions = !!disableInteractionsEl?.checked;
    const options = {
      keepScripts,
      disableInteractions,
      keepHashLinks: false,
    };
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
    exportBtn.disabled = false;
    mhtmlBtn.disabled = false;
  }
});

mhtmlBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  mhtmlBtn.disabled = true;
  setStatus("Saving MHTML…", "");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "SAVE_MHTML" });
    if (!resp?.ok) throw new Error(resp?.error || "MHTML export failed");
    setStatus(`MHTML saved: ${resp.filename}`, "ok");
  } catch (err) {
    setStatus(String(err?.message || err), "error");
  } finally {
    exportBtn.disabled = false;
    mhtmlBtn.disabled = false;
  }
});
