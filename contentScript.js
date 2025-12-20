(() => {
  if (globalThis.__geminiExporterInitialized) return;
  globalThis.__geminiExporterInitialized = true;

  const isTop = window.top === window;
  const hostname = location.hostname || "";
  const isGemini = hostname === "gemini.google.com";
  const originHost = (() => {
    try {
      return new URL(location.origin || "").hostname || "";
    } catch {
      return "";
    }
  })();
  const hrefForDetect = String(location.href || "");
  const isScfOrigin =
    originHost.endsWith(".scf.usercontent.goog") || hrefForDetect.includes(".scf.usercontent.goog");
  const isShim = isScfOrigin && hrefForDetect.includes("/generative-ui-response/");

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "GEMINI_EXPORTER_PING") {
      const stats = getFrameStats();
      sendResponse({
        ok: true,
        href: location.href,
        origin: location.origin,
        originHost,
        isTop,
        isGemini,
        isScfOrigin,
        isShim,
        ...stats,
      });
      return;
    }

    if (msg.type === "GEMINI_EXPORTER_EXPORT") {
      if (!isScfOrigin) {
        sendResponse({ ok: false, error: "Not in a Gemini SafeContentFrame origin." });
        return;
      }
      exportSelfContainedHtml(msg.payload)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
  });

  function getFrameStats() {
    let elementCount = 0;
    let textLength = 0;
    let hasNonTrivialNodes = false;
    try {
      const body = document.body;
      if (body) {
        elementCount = body.querySelectorAll("*").length;
        textLength = (body.innerText || "").length;
        hasNonTrivialNodes = !!body.querySelector("*:not(script):not(style):not(link):not(meta)");
      }
    } catch {
      // ignore
    }
    return { elementCount, textLength, hasNonTrivialNodes };
  }

  async function exportSelfContainedHtml(payload) {
    const hasContent = await waitForRenderedContent();
    if (!hasContent) {
      throw new Error(
        "App content not detected in this SafeContentFrame yet. Wait for it to load, then try Export again."
      );
    }

    const warnings = [];
    const sourceBaseUrl = location.href;
    const options = normalizeOptions(payload);
    const interactiveImageState = options.keepScripts
      ? await preloadKnownInteractiveImages(warnings).catch((err) => {
          warnings.push(`Preload interactive images failed: ${String(err?.message || err)}`);
          return null;
        })
      : null;

    const html = "<!doctype html>\n" + document.documentElement.outerHTML;
    const exportDoc = new DOMParser().parseFromString(html, "text/html");

    removeCspMeta(exportDoc);
    exportDoc.querySelectorAll("base").forEach((el) => el.remove());
    if (!options.keepScripts) {
      exportDoc.querySelectorAll("script").forEach((el) => el.remove());
      stripInlineEventHandlers(exportDoc);
    }
    if (options.keepScripts && interactiveImageState?.classImagesByName) {
      patchKnownInteractiveScripts(exportDoc, interactiveImageState, warnings);
    }
    if (options.disableInteractions) {
      neutralizeInteractions(exportDoc, options);
    }

    await inlineExternalStylesheets(exportDoc, sourceBaseUrl, warnings);

    const { rewrittenDoc, stats } = await inlineAssets(exportDoc, sourceBaseUrl, warnings, options);

    const finalHtml = "<!doctype html>\n" + rewrittenDoc.documentElement.outerHTML;
    const filename = makeFilename(payload?.filenameHint || "gemini-export");
    triggerDownload(finalHtml, filename);

    return { ok: true, filename, warnings, stats };
  }

  async function preloadKnownInteractiveImages(warnings) {
    // Best-effort: some Gemini apps use a "class selector" widget where a JS app swaps a single
    // <img id="class-image"> based on button clicks in #class-nav-container.
    // When exporting with scripts kept, the app may revert the image to "/gen?prompt=..." on load,
    // which breaks outside Gemini. We pre-capture all variants as data URLs and later patch scripts.
    const navContainer = document.getElementById("class-nav-container");
    const imgEl = document.getElementById("class-image");
    const nameEl = document.getElementById("class-name");
    if (!(navContainer instanceof HTMLElement)) return null;
    if (!(imgEl instanceof HTMLImageElement)) return null;
    if (!(nameEl instanceof HTMLElement)) return null;

    const getButtons = () =>
      Array.from(navContainer.querySelectorAll("button")).filter((b) => b instanceof HTMLButtonElement);
    const buttons = getButtons();
    if (buttons.length < 2) return null;

    const initialName = String(nameEl.innerText || "").trim();
    const initialIndex = initialName
      ? buttons.findIndex((b) => String(b.innerText || "").includes(initialName))
      : -1;

    const classImagesByName = {};
    const namesByIndex = new Array(buttons.length).fill("");

    // Capture the currently displayed variant (important when the current tab/button is already
    // selected and clicking it again does not trigger a reload).
    if (initialName) {
      const okInitial = await waitFor(() => imgEl.complete && imgEl.naturalWidth > 0, 20_000);
      if (!okInitial) {
        warnings.push("Preload: timeout waiting for the initial class image to load");
      } else {
        const initialDataUrl = await captureImageElementAsDataUrl(imgEl).catch((err) => {
          warnings.push(`Preload: failed to capture initial image for "${initialName}" (${err.message})`);
          return null;
        });
        if (initialDataUrl && initialDataUrl.startsWith("data:")) {
          classImagesByName[initialName] = initialDataUrl;
          if (initialIndex >= 0) namesByIndex[initialIndex] = initialName;
        }
      }
    }

    for (let i = 0; i < buttons.length; i++) {
      if (
        initialIndex >= 0 &&
        i === initialIndex &&
        initialName &&
        typeof classImagesByName[initialName] === "string"
      ) {
        continue;
      }
      const btn = getButtons()[i] || buttons[i];
      try {
        btn.scrollIntoView({ block: "center", inline: "center" });
      } catch {
        // ignore
      }

      const prevSrc = String(imgEl.currentSrc || imgEl.src || "").trim();

      btn.click();

      const ok = await waitFor(
        () => {
          const curSrc = String(imgEl.currentSrc || imgEl.src || "").trim();
          if (!curSrc || curSrc === prevSrc) return false;
          return imgEl.complete && imgEl.naturalWidth > 0;
        },
        20_000
      );
      if (!ok) {
        warnings.push(`Preload: timeout waiting for class image #${i + 1}/${buttons.length}`);
        continue;
      }

      const curName = String(nameEl.innerText || "").trim() || String(btn.innerText || "").trim();
      if (curName && !namesByIndex[i]) namesByIndex[i] = curName;

      const dataUrl = await captureImageElementAsDataUrl(imgEl).catch((err) => {
        warnings.push(`Preload: failed to capture image for "${curName}" (${err.message})`);
        return null;
      });
      if (curName && dataUrl && dataUrl.startsWith("data:")) {
        classImagesByName[curName] = dataUrl;
      }
    }

    // Restore initial selection if possible.
    if (initialIndex >= 0 && initialIndex < buttons.length) {
      try {
        (getButtons()[initialIndex] || buttons[initialIndex]).click();
        await waitFor(
          () =>
            String(nameEl.innerText || "").trim() === initialName &&
            imgEl.complete &&
            imgEl.naturalWidth > 0,
          10_000
        );
      } catch {
        // ignore
      }
    }

    if (Object.keys(classImagesByName).length < 2) return null;
    const resolvedInitialIndex = initialName ? namesByIndex.indexOf(initialName) : -1;
    return {
      kind: "class-nav-container",
      initialName,
      initialIndex: resolvedInitialIndex >= 0 ? resolvedInitialIndex : initialIndex,
      classImagesByName,
    };
  }

  async function waitFor(predicate, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (predicate()) return true;
      } catch {
        // ignore
      }
      await sleep(120);
    }
    return false;
  }

  async function captureImageElementAsDataUrl(imgEl) {
    const src = String(imgEl.currentSrc || imgEl.src || "").trim();
    if (src.startsWith("data:")) return src;

    // Prefer canvas capture: works even if the underlying URL is transient (blob revoked later).
    try {
      const w = imgEl.naturalWidth || imgEl.width || 0;
      const h = imgEl.naturalHeight || imgEl.height || 0;
      if (w > 0 && h > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(imgEl, 0, 0);
          const out = canvas.toDataURL("image/png");
          if (out && out.startsWith("data:")) return out;
        }
      }
    } catch {
      // ignore; fallback below
    }

    if (src) return await getDataUrl(src);
    throw new Error("Image has no src");
  }

  function patchKnownInteractiveScripts(doc, state, warnings) {
    const map = state?.classImagesByName && typeof state.classImagesByName === "object" ? state.classImagesByName : null;
    if (!map) return;

    const scripts = Array.from(doc.querySelectorAll("script")).filter((s) => !s.src);
    for (const script of scripts) {
      const text = String(script.textContent || "");
      if (!text.includes("const classes") || !text.includes("class-image")) continue;

      let patched = text;
      for (const [name, dataUrl] of Object.entries(map)) {
        if (!name || !dataUrl) continue;
        const re = new RegExp(
          `(name\\s*:\\s*['\"]${escapeRegExp(name)}['\"][\\s\\S]*?image\\s*:\\s*['\"])([^'\"]*)(['\"])`
        );
        patched = patched.replace(re, `$1${dataUrl}$3`);
      }

      const initialIndex = Number.isFinite(state?.initialIndex) ? Number(state.initialIndex) : -1;
      if (initialIndex >= 0) {
        patched = patched.replace(
          /(let|var)\s+currentClassIndex\s*=\s*0\s*;/,
          `$1 currentClassIndex = ${initialIndex};`
        );
        patched = patched.replace(
          /selectClass\\(\\s*0\\s*\\)\\s*;?/,
          `selectClass(${initialIndex});`
        );
      }

      if (patched !== text) script.textContent = patched;
    }

    // Also ensure the initial <img id="class-image"> src is a stable data URL if available.
    const initialName = String(state?.initialName || "").trim();
    const initialData = initialName ? map[initialName] : null;
    if (initialData && typeof initialData === "string") {
      const img = doc.getElementById("class-image");
      if (img && img.tagName === "IMG") {
        img.setAttribute("src", initialData);
        img.setAttribute("style", `${img.getAttribute("style") || ""};opacity:1;`.trim());
      }
    }

    warnings.push(
      `Keep interactivity: embedded ${Object.keys(map).length} class images as data URLs to avoid /gen placeholders.`
    );
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
  }

  function normalizeOptions(payload) {
    const raw = payload && typeof payload === "object" ? payload.options : null;
    const opts = raw && typeof raw === "object" ? raw : {};
    const keepScripts = opts.keepScripts === true;
    const inlineFonts = opts.inlineFonts;
    const inlineFontsMode =
      inlineFonts === true
        ? "all"
        : inlineFonts === false
          ? "none"
          : inlineFonts === "all" || inlineFonts === "icons" || inlineFonts === "none"
            ? inlineFonts
            : "icons";
    return {
      keepScripts,
      disableInteractions: keepScripts ? false : opts.disableInteractions !== false,
      keepHashLinks: opts.keepHashLinks !== false,
      inlineFontsMode,
    };
  }

  function neutralizeInteractions(doc, options) {
    const keepHashLinks = options?.keepHashLinks !== false;

    // Links: keep intra-page #hash links (optional), disable everything else.
    for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
      const href = String(a.getAttribute("href") || "").trim();
      if (!href) continue;
      if (keepHashLinks && href.startsWith("#")) continue;
      a.setAttribute("data-exporter-href", href);
      a.removeAttribute("href");
      a.removeAttribute("target");
      a.removeAttribute("rel");
      a.removeAttribute("download");
      a.removeAttribute("ping");
      a.removeAttribute("referrerpolicy");
    }
    for (const area of Array.from(doc.querySelectorAll("area[href]"))) {
      area.removeAttribute("href");
      area.removeAttribute("target");
      area.removeAttribute("rel");
      area.removeAttribute("download");
      area.removeAttribute("ping");
      area.removeAttribute("referrerpolicy");
    }

    // Forms: prevent accidental navigations/submits.
    for (const form of Array.from(doc.querySelectorAll("form"))) {
      form.removeAttribute("action");
      form.removeAttribute("method");
      form.removeAttribute("target");
    }

    // Freeze CSS-only tab/accordion widgets (radio/checkbox + label patterns).
    for (const el of Array.from(doc.querySelectorAll("input, select, textarea, button"))) {
      el.setAttribute("disabled", "");
    }

    // Disable editing / focus.
    for (const el of Array.from(doc.querySelectorAll("[contenteditable]"))) {
      el.removeAttribute("contenteditable");
    }
    for (const el of Array.from(doc.querySelectorAll("[tabindex]"))) {
      el.removeAttribute("tabindex");
    }

    injectNoInteractionStyle(doc);
  }

  function injectNoInteractionStyle(doc) {
    if (!doc?.head) return;
    const existing = doc.head.querySelector("style[data-gemini-exporter='no-interactions']");
    if (existing) return;
    const style = doc.createElement("style");
    style.setAttribute("data-gemini-exporter", "no-interactions");
    style.textContent = `
      a[data-exporter-href] { text-decoration: none !important; color: inherit !important; cursor: default !important; }
      area { cursor: default !important; }
      button, input, select, textarea, summary { cursor: default !important; }
      summary { pointer-events: none !important; }
      iframe { pointer-events: none !important; }
      .cursor-pointer { cursor: default !important; pointer-events: none !important; }
      [role="button"], [role="tab"], [role="link"], [role="menuitem"] { cursor: default !important; pointer-events: none !important; }
      * { animation: none !important; transition: none !important; }
      *:hover { transform: none !important; }
      *:focus, *:focus-visible { outline: none !important; }
      button:disabled, input:disabled, select:disabled, textarea:disabled { opacity: 1 !important; }
    `.trim();
    doc.head.appendChild(style);
  }

  async function waitForRenderedContent(timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const body = document.body;
      if (body) {
        const hasNonTrivialNodes = body.querySelector(
          "*:not(script):not(style):not(link):not(meta)"
        );
        if (hasNonTrivialNodes) return true;
      }
      await sleep(200);
    }
    return false;
  }

  function removeCspMeta(doc) {
    doc
      .querySelectorAll("meta[http-equiv]")
      .forEach((meta) => {
        const v = (meta.getAttribute("http-equiv") || "").toLowerCase();
        if (v === "content-security-policy" || v === "content-security-policy-report-only") {
          meta.remove();
        }
      });
  }

  function stripInlineEventHandlers(doc) {
    const all = doc.querySelectorAll("*");
    for (const el of all) {
      for (const attr of Array.from(el.attributes || [])) {
        if (attr.name.toLowerCase().startsWith("on")) el.removeAttribute(attr.name);
      }
    }
  }

  async function inlineExternalStylesheets(doc, sourceBaseUrl, warnings) {
    const links = Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'));
    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;
      const absUrl = safeAbsUrl(href, sourceBaseUrl);
      if (!absUrl) continue;
      const cssText = await fetchText(absUrl).catch((err) => {
        warnings.push(`Failed to fetch CSS: ${absUrl} (${err.message})`);
        return null;
      });
      if (!cssText) continue;

      const inlined = await inlineCssImports(cssText, absUrl, warnings);
      const absolutized = absolutizeCssUrls(inlined, absUrl, warnings);

      const style = doc.createElement("style");
      style.setAttribute("data-exported-from", absUrl);
      style.textContent = absolutized;
      link.replaceWith(style);
    }
  }

  async function inlineCssImports(cssText, baseUrl, warnings, depth = 0, seen = new Set()) {
    if (depth > 4) return cssText;
    const key = `${baseUrl}::${depth}`;
    if (seen.has(key)) return cssText;
    seen.add(key);

    const importRe =
      /@import\\s+(?:url\\(\\s*)?(?:\"([^\"]+)\"|'([^']+)'|([^\\s\\)\"';]+))\\s*\\)?\\s*([^;]*);/gi;

    return replaceAsync(cssText, importRe, async (full, g1, g2, g3, media) => {
      const raw = g1 || g2 || g3 || "";
      const abs = safeAbsUrl(raw, baseUrl);
      if (!abs) return `/* skipped invalid @import: ${full} */`;
      if (seen.has(abs)) return `/* skipped circular @import: ${abs} */`;
      seen.add(abs);
      const imported = await fetchText(abs).catch((err) => {
        warnings.push(`Failed to fetch @import CSS: ${abs} (${err.message})`);
        return null;
      });
      if (!imported) return `/* failed to inline @import: ${abs} */`;
      const inlined = await inlineCssImports(imported, abs, warnings, depth + 1, seen);
      const absolutized = absolutizeCssUrls(inlined, abs, warnings);
      const mediaText = (media || "").trim();
      if (mediaText) return `@media ${mediaText} {\\n${absolutized}\\n}`;
      return `\\n/* inlined @import ${abs} */\\n${absolutized}\\n`;
    });
  }

  function absolutizeCssUrls(cssText, baseUrl, warnings) {
    return cssText.replace(/url\\(\\s*(['\"]?)([^'\"\\)]+)\\1\\s*\\)/gi, (m, q, raw) => {
      const u = (raw || "").trim();
      if (!u || u.startsWith("data:") || u.startsWith("#")) return m;
      const abs = safeAbsUrl(u, baseUrl);
      if (!abs) {
        warnings.push(`Failed to absolutize CSS url(): ${u}`);
        return m;
      }
      return `url(\"${abs}\")`;
    });
  }

  async function inlineAssets(doc, sourceBaseUrl, warnings, options) {
    const base = sourceBaseUrl;
    const urlSet = new Set();

    // HTML attributes
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      const u = pickImgUrl(img);
      if (!u) continue;
      const abs = safeAbsUrl(u, base);
      if (abs && isSupportedAssetUrl(abs) && shouldInlineAsset(abs, options)) urlSet.add(abs);
    }
    for (const el of Array.from(doc.querySelectorAll("[style]"))) {
      const style = el.getAttribute("style") || "";
      for (const u of extractCssUrlCandidates(style)) {
        const abs = safeAbsUrl(u, base);
        if (abs && isSupportedAssetUrl(abs) && shouldInlineAsset(abs, options)) urlSet.add(abs);
      }
    }
    for (const styleEl of Array.from(doc.querySelectorAll("style"))) {
      const text = styleEl.textContent || "";
      for (const u of extractCssUrlCandidates(text)) {
        const abs = safeAbsUrl(u, base);
        if (abs && isSupportedAssetUrl(abs) && shouldInlineAsset(abs, options)) urlSet.add(abs);
      }
    }

    const urls = Array.from(urlSet);
    const map = new Map();
    const failures = [];

    await runWithConcurrency(urls, 6, async (absUrl) => {
      const dataUrl = await getDataUrl(absUrl).catch((err) => {
        failures.push(`${absUrl} (${err.message})`);
        return null;
      });
      if (dataUrl) map.set(absUrl, dataUrl);
    });

    for (const img of Array.from(doc.querySelectorAll("img"))) {
      const u = pickImgUrl(img);
      if (!u) continue;
      const abs = safeAbsUrl(u, base);
      if (!abs) continue;
      const dataUrl = map.get(abs);
      if (!dataUrl) continue;
      img.setAttribute("src", dataUrl);
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      img.removeAttribute("loading");
      img.removeAttribute("decoding");
      // Prevent kept scripts from "lazy-loading" over our inlined src via data/go-data-* attributes.
      rewriteLazyAssetAttributes(img, dataUrl);
    }

    for (const el of Array.from(doc.querySelectorAll("[style]"))) {
      const style = el.getAttribute("style") || "";
      const rewritten = rewriteCssUrls(style, base, map);
      if (rewritten !== style) el.setAttribute("style", rewritten);
    }

    for (const styleEl of Array.from(doc.querySelectorAll("style"))) {
      const text = styleEl.textContent || "";
      const rewritten = rewriteCssUrls(text, base, map);
      if (rewritten !== text) styleEl.textContent = rewritten;
    }

    const stats = {
      assetCandidates: urls.length,
      inlined: map.size,
      failed: failures.length,
    };
    if (failures.length) warnings.push(`Some assets failed to inline (${failures.length}).`);
    return { rewrittenDoc: doc, stats };
  }

  function rewriteLazyAssetAttributes(el, dataUrl) {
    const names = [
      "data-src",
      "data-srcset",
      "data-lazy-src",
      "data-lazy-srcset",
      "data-original",
      "data-url",
      "go-data-src",
      "go-data-srcset",
    ];
    for (const name of names) {
      if (el.hasAttribute(name)) el.setAttribute(name, dataUrl);
    }
  }

  function pickImgUrl(img) {
    const src = (img.getAttribute("src") || "").trim();
    if (src) return src;
    const srcset = (img.getAttribute("srcset") || "").trim();
    if (!srcset) return null;
    const parts = srcset
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    const last = parts[parts.length - 1].split(/\s+/)[0];
    return last || null;
  }

  function extractCssUrlCandidates(text) {
    const out = [];
    const re = /url\\(\\s*(['\"]?)([^'\"\\)]+)\\1\\s*\\)/gi;
    let m;
    while ((m = re.exec(text))) {
      const u = (m[2] || "").trim();
      if (!u || u.startsWith("data:") || u.startsWith("#")) continue;
      out.push(u);
    }
    return out;
  }

  function rewriteCssUrls(text, baseUrl, map) {
    return text.replace(/url\\(\\s*(['\"]?)([^'\"\\)]+)\\1\\s*\\)/gi, (m, q, raw) => {
      const u = (raw || "").trim();
      if (!u || u.startsWith("data:") || u.startsWith("#")) return m;
      const abs = safeAbsUrl(u, baseUrl);
      if (!abs) return m;
      const dataUrl = map.get(abs);
      if (!dataUrl) return m;
      return `url(\"${dataUrl}\")`;
    });
  }

  async function getDataUrl(absUrl) {
    if (absUrl.startsWith("data:")) return absUrl;
    if (absUrl.startsWith("blob:")) {
      const res = await fetch(absUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      return await blobToDataUrl(blob);
    }
    if (!absUrl.startsWith("http:") && !absUrl.startsWith("https:")) {
      throw new Error(`Unsupported asset URL: ${absUrl}`);
    }
    // Prefer direct fetch to avoid message size limits for large assets (fonts, etc).
    const direct = await tryFetchAsDataUrl(absUrl).catch(() => null);
    if (direct) return direct;

    const resp = await sendRuntimeMessage({ type: "FETCH_DATA_URL", url: absUrl });
    if (!resp?.ok) throw new Error(resp?.error || "FETCH_DATA_URL failed");
    return resp.dataUrl;
  }

  async function tryFetchAsDataUrl(absUrl) {
    const u = new URL(absUrl);
    const sameOrigin = u.origin === location.origin;
    const credentials = sameOrigin ? "include" : "omit";
    const res = await fetch(absUrl, { credentials, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return await blobToDataUrl(blob);
  }

  async function fetchText(absUrl) {
    const resp = await sendRuntimeMessage({ type: "FETCH_TEXT", url: absUrl });
    if (!resp?.ok) throw new Error(resp?.error || "FETCH_TEXT failed");
    return resp.text;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(resp);
      });
    });
  }

  function safeAbsUrl(raw, baseUrl) {
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return null;
    }
  }

  function isSupportedAssetUrl(url) {
    return (
      url.startsWith("http:") ||
      url.startsWith("https:") ||
      url.startsWith("blob:") ||
      url.startsWith("data:")
    );
  }

  function shouldInlineAsset(absUrl, options) {
    if (!isFontUrl(absUrl)) return true;
    const mode = options?.inlineFontsMode || "icons";
    if (mode === "all") return true;
    if (mode === "none") return false;
    return isIconFontUrl(absUrl);
  }

  function isFontUrl(url) {
    try {
      const path = new URL(url).pathname.toLowerCase();
      return (
        path.endsWith(".woff2") ||
        path.endsWith(".woff") ||
        path.endsWith(".ttf") ||
        path.endsWith(".otf")
      );
    } catch {
      return false;
    }
  }

  function isIconFontUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();
      if (host === "fonts.gstatic.com") {
        return path.includes("/materialsymbols") || path.includes("/materialicons");
      }
      return false;
    } catch {
      return false;
    }
  }

  function triggerDownload(htmlString, filename) {
    const blob = new Blob([htmlString], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function makeFilename(prefix) {
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(
      ts.getHours()
    )}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const safePrefix = String(prefix || "gemini-export")
      .trim()
      .replace(/[\\s/\\\\:]+/g, "-")
      .replace(/[^a-zA-Z0-9._-]+/g, "");
    return `${safePrefix}-${stamp}.html`;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function replaceAsync(str, regex, asyncFn) {
    const matches = [];
    str.replace(regex, (...args) => {
      const match = args[0];
      const offset = args[args.length - 2];
      matches.push({ match, offset, args });
      return match;
    });

    if (matches.length === 0) return str;
    const pieces = [];
    let lastIndex = 0;
    for (const m of matches) {
      pieces.push(str.slice(lastIndex, m.offset));
      pieces.push(await asyncFn(...m.args));
      lastIndex = m.offset + m.match.length;
    }
    pieces.push(str.slice(lastIndex));
    return pieces.join("");
  }

  async function runWithConcurrency(items, limit, fn) {
    const queue = items.slice();
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) return;
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("FileReader failed"));
      r.readAsDataURL(blob);
    });
  }
})();
