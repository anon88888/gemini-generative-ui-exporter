const fetchCache = new Map(); // cacheKey -> value

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  return tab.id;
}

async function getTabUrl(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return String(tab?.url || "");
}

async function detectShimFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const href = String(location.href || "");
      let originHost = "";
      try {
        originHost = new URL(location.origin || "").hostname || "";
      } catch {
        originHost = "";
      }
      const isScf =
        originHost.endsWith(".scf.usercontent.goog") || href.includes(".scf.usercontent.goog");
      const isShim = isScf && href.includes("/generative-ui-response/");
      let elementCount = 0;
      let textLength = 0;
      let hasNonTrivialNodes = false;
      try {
        elementCount = document.body ? document.body.querySelectorAll("*").length : 0;
        textLength = document.body ? (document.body.innerText || "").length : 0;
        hasNonTrivialNodes = !!document.body?.querySelector(
          "*:not(script):not(style):not(link):not(meta)"
        );
      } catch {
        // ignore
      }
      return {
        href,
        origin: location.origin,
        originHost,
        isScf,
        isShim,
        elementCount,
        textLength,
        hasNonTrivialNodes,
      };
    },
  });

  return results
    .map((r) => ({ frameId: r.frameId, ...r.result }))
    .filter((r) => r.isScf && typeof r.frameId === "number");
}

async function listShimIframesFromTopFrame(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => {
      const iframes = Array.from(document.querySelectorAll("model-response iframe, iframe"));
      return iframes
        .map((iframe) => {
          const src = iframe.getAttribute("src") || iframe.src || "";
          const rect = iframe.getBoundingClientRect();
          const area = Math.max(0, rect.width) * Math.max(0, rect.height);
          let origin = "";
          let originHost = "";
          try {
            const u = new URL(src, location.href);
            origin = u.origin || "";
            if (u.protocol === "blob:") originHost = new URL(u.origin || "").hostname || "";
            else originHost = u.hostname || "";
          } catch {
            origin = "";
            originHost = "";
          }
          const isScf =
            originHost.endsWith(".scf.usercontent.goog") || String(src).includes(".scf.usercontent.goog");
          return { src, area, origin, originHost, isScf };
        })
        .filter((x) => x && x.isScf && typeof x.src === "string");
    },
  });

  const list = results?.[0]?.result;
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => ({
      src: String(x.src || ""),
      origin: String(x.origin || ""),
      originHost: String(x.originHost || ""),
      area: Number(x.area || 0),
    }))
    .filter((x) => x.src)
    .sort((a, b) => b.area - a.area);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isShimLikeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "blob:") {
      const host = new URL(u.origin || "").hostname || "";
      return host.endsWith("scf.usercontent.goog");
    }
    if (u.protocol === "https:" || u.protocol === "http:") {
      return u.hostname.endsWith("scf.usercontent.goog");
    }
    return false;
  } catch {
    return false;
  }
}

function urlKey(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return String(url || "");
  }
}

function urlOriginKey(url) {
  try {
    const u = new URL(url);
    return String(u.origin || "");
  } catch {
    return "";
  }
}

function urlKeyNoSearch(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return String(url || "");
  }
}

async function getAllFrames(tabId) {
  if (!chrome.webNavigation?.getAllFrames) {
    throw new Error("webNavigation API unavailable (missing permission?)");
  }
  return await new Promise((resolve, reject) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(Array.isArray(frames) ? frames : []);
    });
  });
}

function matchFrameToTopShim(frames, topShims) {
  if (!frames.length || !topShims.length) return null;

  const shimAreaByKey = new Map();
  for (const s of topShims) {
    const src = String(s?.src || "");
    const originKey = String(s?.origin || "") || urlOriginKey(src);
    if (originKey) shimAreaByKey.set(originKey, s.area || 0);
    shimAreaByKey.set(urlKey(src), s.area || 0);
    shimAreaByKey.set(urlKeyNoSearch(src), s.area || 0);
  }

  const candidates = frames
    .filter((f) => typeof f?.frameId === "number" && typeof f?.url === "string")
    .filter((f) => isShimLikeUrl(f.url))
    .map((f) => {
      const originKey = urlOriginKey(f.url);
      const area =
        shimAreaByKey.get(originKey) ??
        shimAreaByKey.get(urlKey(f.url)) ??
        shimAreaByKey.get(urlKeyNoSearch(f.url)) ??
        0;
      return { frameId: f.frameId, url: f.url, originKey, area };
    })
    .sort((a, b) => (b.area || 0) - (a.area || 0));

  return candidates[0] || null;
}

async function probeFramesForShim(tabId, frames, topShims) {
  const frameIds = Array.from(
    new Set(frames.map((f) => f?.frameId).filter((id) => typeof id === "number" && id !== 0))
  );
  if (!frameIds.length) return null;

  const topKeys = new Set();
  const topOrigins = new Set();
  for (const s of topShims) {
    const src = String(s?.src || "");
    if (!src) continue;
    topKeys.add(urlKey(src));
    topKeys.add(urlKeyNoSearch(src));
    const originKey = String(s?.origin || "") || urlOriginKey(src);
    if (originKey) topOrigins.add(originKey);
  }

  const matches = [];
  for (const frameId of frameIds) {
    let result;
    try {
      const execResults = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: () => {
          const href = String(location.href || "");
          let originHost = "";
          try {
            originHost = new URL(location.origin || "").hostname || "";
          } catch {
            originHost = "";
          }
          const isScf =
            originHost.endsWith(".scf.usercontent.goog") || href.includes(".scf.usercontent.goog");
          let elementCount = 0;
          try {
            elementCount = document.body ? document.body.querySelectorAll("*").length : 0;
          } catch {
            // ignore
          }
          return {
            href,
            origin: location.origin,
            originHost,
            isScf,
            elementCount,
            readyState: document.readyState,
          };
        },
      });
      result = execResults?.[0]?.result;
    } catch {
      continue;
    }

    if (!result?.isScf || typeof result.href !== "string") continue;
    const key = urlKey(result.href);
    const keyNoSearch = urlKeyNoSearch(result.href);
    const originKey = String(result.origin || "") || urlOriginKey(result.href);
    const keyMatch =
      (originKey && topOrigins.has(originKey)) || topKeys.has(key) || topKeys.has(keyNoSearch);
    matches.push({
      frameId,
      url: result.href,
      elementCount: Number(result.elementCount || 0),
      keyMatch,
      originKey,
      readyState: String(result.readyState || ""),
    });
  }

  if (!matches.length) return null;
  matches.sort((a, b) => {
    if (a.keyMatch !== b.keyMatch) return a.keyMatch ? -1 : 1;
    return (b.elementCount || 0) - (a.elementCount || 0);
  });
  return matches[0];
}

async function findShimFrame(tabId, topShims, timeoutMs = 10_000) {
  const start = Date.now();
  let lastFrames = [];
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const frames = await getAllFrames(tabId);
      lastFrames = frames;
      const match = matchFrameToTopShim(frames, topShims);
      if (match) return { frameId: match.frameId, url: match.url, method: "webNavigation" };

      // If URLs are hidden/mismatched, probe by executing a tiny script in each frame.
      const probed = await probeFramesForShim(tabId, frames, topShims);
      if (probed) return { frameId: probed.frameId, url: probed.url, method: "probe" };
    } catch (err) {
      lastErr = err;
      break;
    }
    await sleep(250);
  }
  if (lastErr) throw lastErr;
  return { frameId: null, url: null, method: "none", debugFrames: lastFrames };
}

function pickBestShimFrame(frames) {
  if (!frames.length) return null;
  const scored = frames.map((f) => ({
    ...f,
    score: (f.hasNonTrivialNodes ? 1_000_000 : 0) + (f.elementCount || 0) + (f.textLength || 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

async function injectContentScriptIntoFrame(tabId, frameId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ["contentScript.js"],
  });
}

async function sendMessageToFrame(tabId, frameId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

  if (msg.type === "START_EXPORT") {
    (async () => {
      const tabId = await getActiveTabId();
      const tabUrl = await getTabUrl(tabId).catch(() => "");
      const options = msg && typeof msg === "object" && msg.options && typeof msg.options === "object" ? msg.options : {};

      // If the user already opened the SafeContentFrame in its own tab, export that tab directly (no subframe needed).
      if (isShimLikeUrl(tabUrl)) {
        const target = { frameId: 0, url: tabUrl, method: "activeTabShim" };
        try {
          const ping = await sendMessageToFrame(tabId, target.frameId, { type: "GEMINI_EXPORTER_PING" });
          if (!ping?.ok) throw new Error("Ping failed");
        } catch {
          await injectContentScriptIntoFrame(tabId, target.frameId);
        }

        const resp = await sendMessageToFrame(tabId, target.frameId, {
          type: "GEMINI_EXPORTER_EXPORT",
          payload: { filenameHint: "gemini-export", options },
        });
        if (!resp?.ok) throw new Error(resp?.error || "Export failed.");
        sendResponse({ ok: true, result: resp.result });
        return;
      }

      const topShims = await listShimIframesFromTopFrame(tabId).catch(() => []);
      if (topShims.length === 0) {
        throw new Error(
          "No Gemini app iframe found. Open a Gemini chat that contains an interactive “app”, then try Export again."
        );
      }

      let target = null;
      let debug = "";
      try {
        const found = await findShimFrame(tabId, topShims, 10_000);
        if (found?.frameId != null) target = found;
        else {
          const frames = found?.debugFrames || [];
          const emptyUrlCount = frames.filter((f) => typeof f?.url === "string" && !f.url).length;
          const frameLines = frames
            .slice(0, 20)
            .map((f) => {
              const url = typeof f?.url === "string" ? f.url : "";
              const shown = url || "(url hidden)";
              return `- frameId=${f.frameId} parent=${f.parentFrameId} url=${shown}`;
            });
          debug =
            `Debug:\n- webNavigation.getAllFrames frames=${frames.length}\n- empty url frames=${emptyUrlCount}\n` +
            (frameLines.length ? `- frames (first ${frameLines.length}):\n${frameLines.join("\n")}\n` : "");
        }
      } catch (err) {
        debug = `Debug:\n- webNavigation error: ${String(err?.message || err)}\n`;
      }

      if (!target) {
        // Last resort: try direct allFrames scripting and pick the best match.
        const shimFrames = await detectShimFrames(tabId).catch(() => []);
        const best = pickBestShimFrame(shimFrames);
        if (best) target = { frameId: best.frameId, url: best.href, method: "allFrames" };
      }

      if (!target) {
        const example = topShims[0]?.src || "";
        throw new Error(
          "Found the Gemini app iframe, but the extension still can't reach the app frame.\n\n" +
            "Try:\n" +
            "1) chrome://extensions → Gemini Generative UI Exporter → 详情 → “网站访问权限” = “在所有网站上”\n" +
            "2) Click “更新/重新加载” for the extension\n" +
            "3) Reload the Gemini tab (⌘R)\n" +
            "4) If you use privacy/adblock/translate extensions, temporarily disable them and retry\n\n" +
            (example ? `Frame URL example: ${example}\n\n` : "") +
            (debug || "")
        );
      }

      // Ensure the content script is present in the target frame (some Chrome setups won't auto-inject into subframes).
      try {
        const ping = await sendMessageToFrame(tabId, target.frameId, {
          type: "GEMINI_EXPORTER_PING",
        });
        if (!ping?.ok) throw new Error("Ping failed");
      } catch {
        try {
          await injectContentScriptIntoFrame(tabId, target.frameId);
        } catch (err) {
          throw new Error(
            `Failed to inject exporter into the app frame (frameId=${target.frameId}). ${String(
              err?.message || err
            )}`
          );
        }
        const ping = await sendMessageToFrame(tabId, target.frameId, { type: "GEMINI_EXPORTER_PING" });
        if (!ping?.ok) throw new Error("Ping failed after injection");
      }

      const resp = await sendMessageToFrame(tabId, target.frameId, {
        type: "GEMINI_EXPORTER_EXPORT",
        payload: { filenameHint: "gemini-export", options },
      });
      if (!resp?.ok) throw new Error(resp?.error || "Export failed.");
      sendResponse({ ok: true, result: resp.result });
    })().catch((err) => {
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
    return true;
  }

  if (msg.type === "SAVE_MHTML") {
    (async () => {
      const tabId = await getActiveTabId();
      const filename = makeFilename("gemini-export", "mhtml");
      const blob = await saveTabAsMhtml(tabId);
      const { downloadId } = await downloadBlobAsFile(blob, filename);
      sendResponse({ ok: true, filename, downloadId });
    })().catch((err) => {
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
    return true;
  }

  if (msg.type === "FETCH_TEXT") {
    (async () => {
      const url = String(msg.url || "");
      if (!url) throw new Error("Missing url");
      const cacheKey = `text:${url}`;
      const cached = fetchCache.get(cacheKey);
      if (cached) return sendResponse({ ok: true, text: cached });

      const res = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      fetchCache.set(cacheKey, text);
      sendResponse({ ok: true, text });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg.type === "FETCH_DATA_URL") {
    (async () => {
      const url = String(msg.url || "");
      if (!url) throw new Error("Missing url");
      const cacheKey = `dataUrl:${url}`;
      const cached = fetchCache.get(cacheKey);
      if (cached) return sendResponse({ ok: true, dataUrl: cached });

      const res = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const contentType =
        res.headers.get("content-type")?.split(";")[0]?.trim() ||
        guessMimeTypeFromUrl(url) ||
        "application/octet-stream";
      const buf = await res.arrayBuffer();
      const base64 = bytesToBase64(new Uint8Array(buf));
      const dataUrl = `data:${contentType};base64,${base64}`;
      fetchCache.set(cacheKey, dataUrl);
      sendResponse({ ok: true, dataUrl });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});

function guessMimeTypeFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".svg")) return "image/svg+xml";
    if (path.endsWith(".avif")) return "image/avif";
    if (path.endsWith(".woff2")) return "font/woff2";
    if (path.endsWith(".woff")) return "font/woff";
    if (path.endsWith(".ttf")) return "font/ttf";
    if (path.endsWith(".otf")) return "font/otf";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".js")) return "text/javascript";
  } catch {
    // ignore
  }
  return null;
}

function bytesToBase64(bytes) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    result += abc[bytes[i] >> 2];
    result += abc[((bytes[i] & 0x03) << 4) | (bytes[i + 1] >> 4)];
    result += abc[((bytes[i + 1] & 0x0f) << 2) | (bytes[i + 2] >> 6)];
    result += abc[bytes[i + 2] & 0x3f];
  }
  if (i < bytes.length) {
    result += abc[bytes[i] >> 2];
    if (i === bytes.length - 1) {
      result += abc[(bytes[i] & 0x03) << 4];
      result += "==";
    } else {
      result += abc[((bytes[i] & 0x03) << 4) | (bytes[i + 1] >> 4)];
      result += abc[(bytes[i + 1] & 0x0f) << 2];
      result += "=";
    }
  }
  return result;
}

function makeFilename(prefix, ext) {
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(
    ts.getHours()
  )}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const safePrefix = String(prefix || "gemini-export")
    .trim()
    .replace(/[\\s/\\\\:]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "");
  const safeExt = String(ext || "html").replace(/[^a-zA-Z0-9]+/g, "");
  return `${safePrefix}-${stamp}.${safeExt}`;
}

async function saveTabAsMhtml(tabId) {
  if (!chrome.pageCapture?.saveAsMHTML) {
    throw new Error("pageCapture API unavailable (missing permission?)");
  }
  return await new Promise((resolve, reject) => {
    chrome.pageCapture.saveAsMHTML({ tabId }, (blob) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (!blob) reject(new Error("saveAsMHTML returned empty blob"));
      else resolve(blob);
    });
  });
}

async function downloadBlobAsFile(blob, filename) {
  if (!chrome.downloads?.download) {
    throw new Error("downloads API unavailable (missing permission?)");
  }
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(id);
      });
    });
    return { downloadId, url };
  } finally {
    // Delay revoke to ensure downloads subsystem has consumed the blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
