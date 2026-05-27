(() => {
  const PANEL_ID = "panopto-concept-helper-panel";
  const TOGGLE_ID = "panopto-concept-helper-toggle";
  const MIN_TEXT_LENGTH = 80;
  const LIVE_CAPTION_STORAGE_PREFIX = "panoptoLiveCaptionLines:";
  let liveCaptionObserver = null;
  let liveCaptionTimer = null;
  let liveCaptionEnabled = false;
  let liveCaptionPaused = true;

  function getCurrentSessionId() {
    const params = new URLSearchParams(location.search);
    return params.get("id") || params.get("sessionId") || params.get("deliveryId") || "unknown-session";
  }

  function getLiveCaptionStorageKey() {
    return `${LIVE_CAPTION_STORAGE_PREFIX}${getCurrentSessionId()}`;
  }

  function getNotionPageStorageKey() {
    return `panoptoNotionPage:${getCurrentSessionId()}`;
  }

  const STOPWORDS = new Set([
    "그리고", "그러면", "그런데", "하지만", "입니다", "합니다", "있습니다", "수",
    "있는", "없는", "것", "거", "이", "그", "저", "때", "좀", "더", "등", "및",
    "에서", "으로", "에게", "까지", "부터", "처럼", "대한", "대해서", "통해",
    "영상", "강의", "오늘", "이번", "여기", "부분", "내용", "설명", "보시면",
    "이제", "다음", "하나", "있는지", "하면", "해서", "하고", "같은", "관련"
  ]);

  const capturedPanoptoTexts = [];

  function injectPageHook() {
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page-hook.js");
      script.onload = () => script.remove();
      (document.documentElement || document.head).appendChild(script);
    } catch {
      // The hook is a best-effort network capture layer.
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "panopto-concept-helper-page-hook") return;
    if (event.data?.type !== "captured-text") return;

    const text = event.data.text || "";
    if (text.length < 40) return;
    capturedPanoptoTexts.push({ url: event.data.url || "", text, capturedAt: Date.now() });

    if (capturedPanoptoTexts.length > 40) {
      capturedPanoptoTexts.splice(0, capturedPanoptoTexts.length - 40);
    }
  });

  injectPageHook();

  function isTopFrame() {
    return window.top === window;
  }

  async function addLiveCaptionLine(text) {
    const clean = parseCaptionText(text);
    if (!clean || clean.length < 2) return;

    try {
      const key = getLiveCaptionStorageKey();
      const result = await getLocalSettings([key]);
      const current = Array.isArray(result[key])
        ? result[key]
        : [];
      const next = [...current];

      clean.split("\n").forEach((line) => {
        const normalized = normalizeText(line);
        if (!normalized || next.includes(normalized)) return;
        next.push(normalized);
      });

      await setLocalSettings({
        [key]: next.slice(-2000)
      });
    } catch {
      // Storage can be temporarily unavailable while the page is unloading.
    }
  }

  function looksLikeCaptionText(text) {
    const clean = normalizeText(text);
    if (clean.length < 4 || clean.length > 260) return false;
    if (/^(재생|일시정지|볼륨|설정|전체 화면|Panopto|Loading|Error)$/i.test(clean)) return false;
    if (!/[가-힣a-zA-Z]/.test(clean)) return false;
    return /[가-힣]/.test(clean) || /[.!?]$/.test(clean);
  }

  function collectVisibleCaptionCandidates() {
    const chunks = [];
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

    document.querySelectorAll("body *").forEach((element) => {
      if (!isVisible(element)) return;
      const rect = element.getBoundingClientRect();
      if (viewportHeight && rect.top < viewportHeight * 0.45) return;
      if (rect.height > 160 || rect.width < 80) return;

      const text = normalizeText(element.innerText || element.textContent || "");
      if (looksLikeCaptionText(text)) chunks.push(text);
    });

    return uniqueLines(chunks.join("\n"));
  }

  function sampleVideoBottomText() {
    const chunks = [];
    const videos = [...document.querySelectorAll("video")];
    videos.forEach((video) => {
      const rect = video.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) return;

      const samplePoints = [
        [rect.left + rect.width * 0.5, rect.bottom - rect.height * 0.08],
        [rect.left + rect.width * 0.5, rect.bottom - rect.height * 0.15],
        [rect.left + rect.width * 0.5, rect.bottom - rect.height * 0.22]
      ];

      samplePoints.forEach(([x, y]) => {
        const element = document.elementFromPoint(x, y);
        if (!element || element === video) return;
        const text = normalizeText(element.innerText || element.textContent || "");
        if (looksLikeCaptionText(text)) chunks.push(text);
      });
    });

    return uniqueLines(chunks.join("\n"));
  }

  function captureVisibleCaptionsOnce() {
    if (liveCaptionPaused) return "";

    const text = uniqueLines([
      collectVisibleCaptionCandidates(),
      sampleVideoBottomText(),
      collectFromMediaTextTracks()
    ].join("\n"));

    if (text) addLiveCaptionLine(text);
    return text;
  }

  function startLiveCaptionCapture() {
    liveCaptionPaused = false;
    if (liveCaptionEnabled) return;
    liveCaptionEnabled = true;

    captureVisibleCaptionsOnce();
    liveCaptionObserver = new MutationObserver(() => {
      captureVisibleCaptionsOnce();
    });

    if (document.body) {
      liveCaptionObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    liveCaptionTimer = setInterval(captureVisibleCaptionsOnce, 1000);
  }

  function stopLiveCaptionCapture() {
    liveCaptionPaused = true;
    if (liveCaptionObserver) {
      liveCaptionObserver.disconnect();
      liveCaptionObserver = null;
    }
    if (liveCaptionTimer) {
      clearInterval(liveCaptionTimer);
      liveCaptionTimer = null;
    }
    liveCaptionEnabled = false;
  }

  function clearCurrentSessionLiveCaptions() {
    return setLocalSettings({ [getLiveCaptionStorageKey()]: [] });
  }

  function pauseLiveCaptionCapture() {
    liveCaptionPaused = true;
  }

  function resumeLiveCaptionCapture() {
    startLiveCaptionCapture();
  }

  function normalizeText(text) {
    return (text || "")
      .replace(/\r/g, "\n")
      .replace(/\[[^\]]{0,30}\]/g, " ")
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function uniqueLines(text) {
    const seen = new Set();
    return normalizeText(text)
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter((line) => {
        if (line.length < 2) return false;
        const key = line.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join("\n");
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function collectFromTranscriptLikeNodes() {
    const hints = [
      "caption", "captions", "transcript", "subtitle", "subtitles",
      "event", "search-results", "자막", "대본"
    ];
    const selector = hints
      .map((hint) => `[id*="${hint}" i], [class*="${hint}" i], [aria-label*="${hint}" i], [title*="${hint}" i]`)
      .join(",");
    const chunks = [];

    document.querySelectorAll(selector).forEach((element) => {
      if (!isVisible(element)) return;
      const text = normalizeText(element.innerText || element.textContent || "");
      if (text.length >= MIN_TEXT_LENGTH) chunks.push(text);
    });

    return uniqueLines(chunks.join("\n"));
  }

  function collectFromPageTextFallback() {
    const blocked = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "CANVAS"]);
    const chunks = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || blocked.has(parent.tagName) || !isVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        const text = normalizeText(node.nodeValue);
        if (text.length < 12) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      chunks.push(walker.currentNode.nodeValue);
    }

    return uniqueLines(chunks.join("\n"));
  }

  function collectFromScripts() {
    const chunks = [];
    const patterns = [
      /"Caption"\s*:\s*"([^"]{10,})"/gi,
      /"Text"\s*:\s*"([^"]{10,})"/gi,
      /"transcript"\s*:\s*"([^"]{10,})"/gi
    ];

    document.querySelectorAll("script").forEach((script) => {
      const raw = script.textContent || "";
      if (!raw || raw.length > 2_000_000) return;
      patterns.forEach((pattern) => {
        for (const match of raw.matchAll(pattern)) {
          try {
            chunks.push(JSON.parse(`"${match[1]}"`));
          } catch {
            chunks.push(match[1]);
          }
        }
      });
    });

    return uniqueLines(chunks.join("\n"));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function collectOpenShadowRoots(root = document.documentElement, roots = []) {
    if (!root) return roots;
    const elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
    elements.forEach((element) => {
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        collectOpenShadowRoots(element.shadowRoot, roots);
      }
    });
    return roots;
  }

  function collectFromShadowDom() {
    const chunks = [];
    collectOpenShadowRoots().forEach((root) => {
      const text = normalizeText(root.textContent || "");
      if (text.length >= MIN_TEXT_LENGTH) chunks.push(text);
    });
    return uniqueLines(chunks.join("\n"));
  }

  function parseCaptionText(text) {
    return uniqueLines(
      normalizeText(text)
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          if (!trimmed) return false;
          if (/^WEBVTT/i.test(trimmed)) return false;
          if (/^\d+$/.test(trimmed)) return false;
          if (/^\d{1,2}:\d{2}(:\d{2})?[,.]\d{3}\s+-->\s+/.test(trimmed)) return false;
          return true;
        })
        .join("\n")
    );
  }

  function collectFromMediaTextTracks() {
    const chunks = [];
    const videos = [...document.querySelectorAll("video, audio")];

    videos.forEach((media) => {
      try {
        [...(media.textTracks || [])].forEach((track) => {
          try {
            track.mode = "showing";
          } catch {
            try {
              track.mode = "hidden";
            } catch {
              // Some tracks are readonly.
            }
          }

          const cues = track.cues || track.activeCues || [];
          [...cues].forEach((cue) => {
            const text = cue.text || cue.getCueAsHTML?.().textContent || "";
            if (text) chunks.push(text);
          });
        });
      } catch {
        // Cross-origin or not-yet-loaded tracks can be inaccessible.
      }
    });

    document.querySelectorAll("track[src]").forEach((track) => {
      const src = track.getAttribute("src");
      if (src) chunks.push(src);
    });

    return parseCaptionText(chunks.join("\n"));
  }

  async function collectFromTrackElements() {
    const chunks = [];
    const tracks = [...document.querySelectorAll("track[src]")]
      .map((track) => track.getAttribute("src"))
      .filter(Boolean)
      .slice(0, 12);

    for (const src of tracks) {
      try {
        const url = new URL(src, location.href).href;
        const text = parseCaptionText(await fetchText(url));
        if (text.length >= MIN_TEXT_LENGTH) chunks.push(text);
      } catch {
        // Track files may be protected or blob-backed.
      }
    }

    return uniqueLines(chunks.join("\n"));
  }

  function collectFromCapturedNetwork() {
    const chunks = [];

    capturedPanoptoTexts.forEach(({ text }) => {
      if (!text) return;

      const jsonStart = text.search(/[{[]/);
      if (jsonStart >= 0) {
        try {
          const data = JSON.parse(text.slice(jsonStart));
          chunks.push(...collectStringsFromObject(data));
          return;
        } catch {
          // Treat it as plain text below.
        }
      }

      chunks.push(parseCaptionText(text));
    });

    return uniqueLines(chunks.join("\n"));
  }

  async function fetchText(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return "";
    return response.text();
  }

  async function collectFromDownloadLinks() {
    const chunks = [];
    const linkPattern = /(caption|transcript|subtitle|download|smi|srt|vtt|자막|대본)/i;
    const links = [...document.querySelectorAll("a[href], button[data-href]")]
      .map((element) => element.href || element.dataset.href || "")
      .filter((href) => href && linkPattern.test(href))
      .slice(0, 12);

    for (const href of links) {
      try {
        const url = new URL(href, location.href).href;
        const text = parseCaptionText(await fetchText(url));
        if (text.length >= MIN_TEXT_LENGTH) chunks.push(text);
      } catch {
        // Some Panopto controls expose pseudo-links that cannot be fetched directly.
      }
    }

    return uniqueLines(chunks.join("\n"));
  }

  function findCandidateGuids(text) {
    const found = new Set();
    const guidPattern = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
    for (const match of text.matchAll(guidPattern)) {
      found.add(match[0]);
    }
    return [...found];
  }

  function collectGuidsFromPage() {
    const sources = [
      location.href,
      document.documentElement.innerHTML,
      ...[...document.querySelectorAll("script")].map((script) => script.textContent || "")
    ];

    return [...new Set(sources.flatMap(findCandidateGuids))].slice(0, 20);
  }

  function getSessionIdsFromUrlAndPage() {
    const ids = new Set();
    const params = new URLSearchParams(location.search);

    ["id", "sessionId", "deliveryId"].forEach((key) => {
      const value = params.get(key);
      if (value) ids.add(value);
    });

    collectGuidsFromPage().forEach((guid) => ids.add(guid));
    return [...ids].slice(0, 20);
  }

  function collectStringsFromObject(value, chunks = []) {
    if (!value) return chunks;
    if (typeof value === "string") {
      const text = parseCaptionText(value);
      if (text.length >= 8) chunks.push(text);
      return chunks;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectStringsFromObject(item, chunks));
      return chunks;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, child]) => {
        if (/caption|transcript|subtitle|event|text|query/i.test(key)) {
          collectStringsFromObject(child, chunks);
        } else if (typeof child === "object") {
          collectStringsFromObject(child, chunks);
        }
      });
    }
    return chunks;
  }

  async function collectFromPanoptoDeliveryInfo() {
    const chunks = [];
    const guids = collectGuidsFromPage();
    const endpointPath = "/Panopto/Pages/Viewer/DeliveryInfo.aspx";

    for (const guid of guids) {
      const urls = [
        `${endpointPath}?deliveryId=${encodeURIComponent(guid)}&responseType=json`,
        `${endpointPath}?deliveryId=${encodeURIComponent(guid)}`,
        `${endpointPath}?sessionId=${encodeURIComponent(guid)}&responseType=json`,
        `${endpointPath}?id=${encodeURIComponent(guid)}&responseType=json`
      ].map((path) => new URL(path, location.origin).href);

      for (const url of urls) {
        try {
          const raw = await fetchText(url);
          if (!raw || raw.length < MIN_TEXT_LENGTH) continue;

          const jsonStart = raw.search(/[{[]/);
          if (jsonStart >= 0) {
            try {
              const data = JSON.parse(raw.slice(jsonStart));
              const text = uniqueLines(collectStringsFromObject(data).join("\n"));
              if (text.length >= MIN_TEXT_LENGTH) chunks.push(text);
            } catch {
              const text = parseCaptionText(raw);
              if (text.length >= MIN_TEXT_LENGTH) chunks.push(text);
            }
          }
        } catch {
          // Candidate GUIDs may not all be delivery IDs. Try the next one.
        }
      }
    }

    return uniqueLines(chunks.join("\n"));
  }

  async function collectFromPanoptoCaptionDownloads() {
    const chunks = [];
    const ids = getSessionIdsFromUrlAndPage();
    const languageValues = [
      "0",
      "1",
      "Korean_Korea",
      "Korean",
      "ko-KR",
      "ko",
      "English_USA",
      "English",
      "en-US",
      "en"
    ];

    for (const id of ids) {
      const urls = [];

      languageValues.forEach((language) => {
        urls.push(new URL(`/Panopto/Pages/Transcription/GenerateSRT.ashx?id=${encodeURIComponent(id)}&language=${encodeURIComponent(language)}`, location.origin).href);
        urls.push(new URL(`/Panopto/Pages/Transcription/GenerateVTT.ashx?id=${encodeURIComponent(id)}&language=${encodeURIComponent(language)}`, location.origin).href);
        urls.push(new URL(`/Panopto/Pages/Transcription/GenerateTXT.ashx?id=${encodeURIComponent(id)}&language=${encodeURIComponent(language)}`, location.origin).href);
      });

      urls.push(new URL(`/Panopto/api/v1/sessions/${encodeURIComponent(id)}`, location.origin).href);
      urls.push(new URL(`/Panopto/Services/Data.svc/GetSessionById?id=${encodeURIComponent(id)}`, location.origin).href);

      for (const url of urls) {
        try {
          const raw = await fetchText(url);
          if (!raw || raw.length < MIN_TEXT_LENGTH) continue;

          if (/\/api\/v1\/sessions\/|\/Services\/Data\.svc\/GetSessionById/i.test(url)) {
            try {
              const data = JSON.parse(raw);
              const downloadUrl =
                data.CaptionDownloadUrl ||
                data.captionDownloadUrl ||
                data.CaptionsUrl ||
                data.captionsUrl ||
                data?.d?.CaptionDownloadUrl ||
                data?.d?.captionDownloadUrl ||
                data?.d?.CaptionsUrl ||
                data?.d?.captionsUrl;

              if (downloadUrl) {
                const captionText = parseCaptionText(await fetchText(new URL(downloadUrl, location.origin).href));
                if (captionText.length >= MIN_TEXT_LENGTH) chunks.push(captionText);
              }

              const embedded = uniqueLines(collectStringsFromObject(data).join("\n"));
              if (embedded.length >= MIN_TEXT_LENGTH) chunks.push(embedded);
            } catch {
              const text = parseCaptionText(raw);
              if (text.length >= MIN_TEXT_LENGTH) chunks.push(text);
            }
          } else {
            const text = parseCaptionText(raw);
            if (text.length >= MIN_TEXT_LENGTH) chunks.push(text);
          }
        } catch {
          // Some caption URLs return an empty response when viewer permissions do not include download access.
        }
      }
    }

    return uniqueLines(chunks.join("\n"));
  }

  function clickTranscriptControls() {
    const controlPattern = /(cc|caption|captions|transcript|subtitle|subtitles|자막|대본|스크립트)/i;
    const candidates = [...document.querySelectorAll("button, a, [role='button'], [tabindex]")]
      .filter((element) => {
        const label = [
          element.innerText,
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("title")
        ].join(" ");
        return controlPattern.test(label);
      })
      .slice(0, 5);

    candidates.forEach((element) => {
      try {
        element.click();
      } catch {
        // Ignore blocked synthetic clicks.
      }
    });

    return candidates.length;
  }

  function extractTranscript() {
    const primarySources = [
      collectFromMediaTextTracks(),
      collectFromCapturedNetwork(),
      collectFromTranscriptLikeNodes(),
      collectFromScripts(),
      collectFromShadowDom()
    ].filter((text) => text.length >= MIN_TEXT_LENGTH);

    if (primarySources.length) {
      return primarySources.sort((a, b) => b.length - a.length)[0];
    }

    const fallback = collectFromPageTextFallback();
    return fallback.length >= MIN_TEXT_LENGTH ? fallback : "";
  }

  async function loadStoredLiveCaptions() {
    const key = getLiveCaptionStorageKey();
    const result = await getLocalSettings([key]);
    const lines = Array.isArray(result[key])
      ? result[key]
      : [];
    return uniqueLines(lines.join("\n"));
  }

  async function extractTranscriptDeep() {
    const firstPass = extractTranscript();
    if (firstPass.length >= 500) return firstPass;

    const clickedCount = clickTranscriptControls();
    if (clickedCount > 0) {
      await sleep(1800);
    }

    const sources = [
      extractTranscript(),
      await loadStoredLiveCaptions(),
      await collectFromTrackElements(),
      await collectFromPanoptoCaptionDownloads(),
      await collectFromDownloadLinks(),
      await collectFromPanoptoDeliveryInfo()
    ].filter((text) => text.length >= MIN_TEXT_LENGTH);

    if (!sources.length) return firstPass;
    return sources.sort((a, b) => b.length - a.length)[0];
  }

  function getExtractionDiagnostics() {
    const mediaCount = document.querySelectorAll("video, audio").length;
    const trackElementCount = document.querySelectorAll("track[src]").length;
    const textTrackCount = [...document.querySelectorAll("video, audio")]
      .reduce((sum, media) => sum + ((media.textTracks && media.textTracks.length) || 0), 0);
    const sessionIdCount = getSessionIdsFromUrlAndPage().length;
    return `진단: media ${mediaCount}, track ${trackElementCount}, textTracks ${textTrackCount}, captured ${capturedPanoptoTexts.length}, sessionIds ${sessionIdCount}`;
  }

  function looksLikeNoiseLine(line) {
    const normalized = normalizeText(line);
    if (!normalized) return true;
    const lower = normalized.toLowerCase();
    const exactNoise = new Set([
      "재생", "일시정지", "볼륨", "음소거", "설정", "전체 화면", "전체화면", "자막", "닫기", "열기", "로딩",
      "loading", "captions", "download transcript", "downloading transcript...", "edit language:", "add new language:",
      "position", "open captions settings menu", "dock below video", "overlay on video",
      "dark text on light background", "light text on dark background", "light text with shadow, no background",
      "밝은 배경에 어두운 텍스트", "어두운 배경에 밝은 텍스트", "비디오 아래에 도킹", "비디오에 오버레이",
      "자막 설정 메뉴 열기", "기록을 다운로드하는 중...", "새 언어 추가:"
    ]);
    if (exactNoise.has(normalized) || exactNoise.has(lower)) return true;
    if (/^\[?자동 생성된 (대화 내용|자막|기록).*\]?$/i.test(normalized)) return true;
    if (/^\[?auto-generated (transcript|captions?).*\]?$/i.test(normalized)) return true;
    if (/auto-generated captions may contain errors/i.test(normalized)) return true;
    if (/^(재생|일시정지|볼륨|음소거|설정|전체 화면|전체화면|자막|닫기|열기|로딩|Loading)$/i.test(normalized)) return true;
    if (/^(슬라이드|화면|이미지|그림|사진|표|도표|그래프)\s*\d*/i.test(normalized)) return true;
    if (/(이미지|그림|사진|아이콘|버튼|화면|슬라이드).{0,12}(설명|표시|보임|나타남|묘사)/i.test(normalized)) return true;
    if (/(접근성|시각장애|청각장애|스크린 리더|대체 텍스트|alt text|audio description|오디오 설명)/i.test(normalized)) return true;
    if (/^\d{1,2}:\d{2}(:\d{2})?/.test(normalized)) return true;
    return false;
  }

  function getTidyDuplicateKey(line) {
    return normalizeText(line)
      .replace(/[\s.,!?。！？·~\-–—:;"'“”‘’()\[\]{}]/g, "")
      .toLowerCase();
  }

  function shouldStartNewParagraph(line) {
    return /^(첫째|둘째|셋째|다음|먼저|그리고|그런데|하지만|또한|그래서|따라서|즉|예를 들어|정리하면|결론적으로|반면|한편)/.test(line);
  }

  function tidyTranscript(text) {
    const cleanText = normalizeText(text);

    if (cleanText.length < MIN_TEXT_LENGTH) {
      return "정돈할 텍스트가 너무 짧습니다. 대본을 먼저 추출하거나 붙여넣어 주세요.";
    }

    const seen = new Set();
    const lines = cleanText
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter((line) => !looksLikeNoiseLine(line))
      .filter((line) => {
        const key = getTidyDuplicateKey(line);
        if (key.length < 3) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    const merged = [];
    lines.forEach((line) => {
      if (!line) return;
      const previous = merged[merged.length - 1] || "";
      const shouldAppend =
        previous &&
        previous.length < 110 &&
        line.length < 120 &&
        !/[.!?。！？]$/.test(previous) &&
        !shouldStartNewParagraph(line);

      if (shouldAppend) {
        merged[merged.length - 1] = `${previous} ${line}`;
      } else {
        merged.push(line);
      }
    });

    const paragraphs = [];
    let current = [];
    merged.forEach((line) => {
      if (current.length >= 4 || (current.length && shouldStartNewParagraph(line))) {
        paragraphs.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    });
    if (current.length) paragraphs.push(current.join("\n"));

    return paragraphs.join("\n\n");
  }

  async function copyToClipboard(text) {
    await navigator.clipboard.writeText(text);
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    });
  }

  function getLocalSetting(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (items) => {
        resolve(items[key] || "");
      });
    });
  }

  function getLocalSettings(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (items) => {
        resolve(items || {});
      });
    });
  }

  function setLocalSettings(items) {
    return new Promise((resolve) => {
      chrome.storage.local.set(items, () => {
        resolve(!chrome.runtime.lastError);
      });
    });
  }

  function cleanLectureTitle(value) {
    const title = normalizeText(value || "")
      .replace(/\s*-\s*Panopto.*$/i, "")
      .replace(/\s*\|\s*Panopto.*$/i, "")
      .replace(/^Panopto\s*/i, "")
      .trim();

    if (!title) return "";
    if (/^(Panopto|Embed|Viewer|Login|강의|대본|개념 정리)$/i.test(title)) return "";
    if (/^https?:\/\//i.test(title)) return "";
    if (title.length < 3) return "";
    return title.slice(0, 120);
  }

  function getLectureTitleFromPage() {
    const selectors = [
      "meta[property='og:title']",
      "meta[name='title']",
      "h1",
      "[class*='title' i]",
      "[id*='title' i]",
      "[aria-label*='title' i]"
    ];

    for (const selector of selectors) {
      const elements = [...document.querySelectorAll(selector)].slice(0, 10);
      for (const element of elements) {
        const raw = element.getAttribute("content")
          || element.getAttribute("aria-label")
          || element.innerText
          || element.textContent;
        const title = cleanLectureTitle(raw);
        if (title) return title;
      }
    }

    return cleanLectureTitle(document.title);
  }

  async function getFallbackLectureTitle() {
    const date = new Date().toISOString().slice(0, 10);
    const sessionId = getCurrentSessionId();
    const titleKey = `panoptoFallbackTitle:${sessionId}`;
    const countKey = `panoptoFallbackTitleCount:${date}`;
    const stored = await getLocalSettings([titleKey, countKey]);

    if (stored[titleKey]) {
      return stored[titleKey];
    }

    const order = Number(stored[countKey] || 0) + 1;
    const title = `Panopto 강의 ${date} ${order}번째`;
    await setLocalSettings({
      [titleKey]: title,
      [countKey]: order
    });
    return title;
  }

  async function getLectureTitle() {
    return getLectureTitleFromPage() || await getFallbackLectureTitle();
  }

  function buildChatGptPrompt(transcript, title = getLectureTitleFromPage() || "Panopto 강의") {
    return [
      "아래 Panopto 강의 대본을 바탕으로 대학 수업 복습용 개념 정리본을 만들어줘.",
      "",
      "요구사항:",
      "- 한국어로 작성",
      "- 대본에 없는 내용은 추측하지 않기",
      "- 대본 문장을 근거로 하되, 오탈자와 띄어쓰기만 자연스럽게 정돈",
      "- 화면 오브젝트 설명, 접근성용 설명, 조작 버튼 설명은 제외",
      "- 핵심 요약",
      "- 주요 개념",
      "- 강의 흐름",
      "- 시험/복습 포인트",
      "- 헷갈리기 쉬운 점",
      "- 복습 질문",
      "- Notion에 붙여넣기 좋은 Markdown 형식",
      "",
      `강의 제목: ${title}`,
      `강의 링크: ${location.href}`,
      "",
      "대본:",
      transcript
    ].join("\n");
  }

  function downloadMarkdown(text) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `panopto-concept-summary-${date}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const toggle = document.createElement("button");
    toggle.id = TOGGLE_ID;
    toggle.className = "panopto-helper-toggle";
    toggle.type = "button";
    toggle.textContent = "개념 정리";

    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.className = "panopto-helper-panel";
    panel.innerHTML = `
      <div class="panopto-helper-header">
        <div class="panopto-helper-title">Panopto 대본 개념 정리</div>
        <button class="panopto-helper-close" type="button" aria-label="닫기">×</button>
      </div>
      <div class="panopto-helper-body">
        <div class="panopto-helper-actions">
          <button class="panopto-helper-button tab is-active" type="button" data-section="text" data-action="show-section">텍스트</button>
          <button class="panopto-helper-button tab" type="button" data-section="send" data-action="show-section">전송</button>
          <button class="panopto-helper-button tab" type="button" data-section="settings" data-action="show-section">설정</button>
        </div>
        <div class="panopto-helper-status"></div>

        <div class="panopto-helper-section is-active" data-panel-section="text">
          <div class="panopto-helper-section-title">텍스트 추출과 정돈</div>
          <div class="panopto-helper-subactions">
            <button class="panopto-helper-button primary" type="button" data-action="extract">대본 추출</button>
            <button class="panopto-helper-button" type="button" data-action="tidy">문장 정돈</button>
            <button class="panopto-helper-button" type="button" data-action="toggle-live-captions">재생 자막 캡처 시작</button>
            <button class="panopto-helper-button" type="button" data-action="load-live-captions">누적 자막 불러오기</button>
            <button class="panopto-helper-button" type="button" data-action="clear-live-captions">누적 초기화</button>
          </div>
          <div class="panopto-helper-collapsible" data-collapsible="transcript">
            <button class="panopto-helper-collapse-bar" type="button" data-action="toggle-collapse" data-target="transcript">
              <span class="panopto-helper-chevron">›</span>
              <span>대본 텍스트</span>
            </button>
            <div class="panopto-helper-collapsible-content">
              <textarea class="panopto-helper-textarea" placeholder="대본이 자동 추출되지 않으면 Panopto에서 Download transcript로 받은 텍스트를 여기에 붙여넣으세요."></textarea>
              <div class="panopto-helper-transcript-actions" hidden>
                <button class="panopto-helper-button" type="button" data-action="copy-transcript">대본 복사</button>
                <button class="panopto-helper-button" type="button" data-action="download-transcript">대본 저장</button>
              </div>
            </div>
          </div>
          <div class="panopto-helper-collapsible" data-collapsible="result">
            <button class="panopto-helper-collapse-bar" type="button" data-action="toggle-collapse" data-target="result">
              <span class="panopto-helper-chevron">›</span>
              <span>정돈 결과</span>
            </button>
            <div class="panopto-helper-collapsible-content">
              <pre class="panopto-helper-output"></pre>
              <div class="panopto-helper-result-actions" hidden>
                <button class="panopto-helper-button" type="button" data-action="copy-result">정리본 복사</button>
                <button class="panopto-helper-button" type="button" data-action="download-result">정리본 저장</button>
              </div>
            </div>
          </div>
        </div>

        <div class="panopto-helper-section" data-panel-section="send">
          <div class="panopto-helper-section-title">Notion 업로드와 GPT 옵션</div>
          <div class="panopto-helper-upload-panel">
            <button class="panopto-helper-button primary" type="button" data-action="upload-notion">Notion에 정돈 텍스트 업로드</button>
            <button class="panopto-helper-button" type="button" data-action="gpt-update-notion">GPT 정리 후 Notion에 추가</button>
            <button class="panopto-helper-button" type="button" data-action="open-notion-page" hidden>최근 Notion 페이지 열기</button>
            <button class="panopto-helper-button" type="button" data-action="chatgpt-project">ChatGPT 프로젝트에서 정리</button>
          </div>
          <div class="panopto-helper-project-panel" hidden>
            <label>
              ChatGPT 프로젝트 URL
              <input type="url" data-project-url placeholder="https://chatgpt.com/...">
            </label>
            <div class="panopto-helper-inline-actions">
              <button class="panopto-helper-button primary" type="button" data-action="open-chatgpt-project">저장 후 프로젝트 열기</button>
              <button class="panopto-helper-button" type="button" data-action="close-chatgpt-project">닫기</button>
            </div>
          </div>
        </div>

        <div class="panopto-helper-section" data-panel-section="settings">
          <div class="panopto-helper-section-title">연동 설정</div>
          <div class="panopto-helper-settings">
            <details class="panopto-helper-setting-group" open>
              <summary>Notion 설정</summary>
              <div class="panopto-helper-setting-status" data-notion-status>Notion 연결 상태: 확인 전</div>
              <label>
                Notion Integration Token
                <input type="password" data-setting="notionApiKey" placeholder="ntn_... 또는 secret_...">
              </label>
              <label>
                Notion 부모 페이지 URL 또는 ID
                <input type="text" data-setting="notionParentPageId" placeholder="Notion 페이지 URL을 붙여넣으세요">
              </label>
              <div class="panopto-helper-inline-actions">
                <button class="panopto-helper-button" type="button" data-action="test-notion">Notion 연결 테스트</button>
              </div>
            </details>
            <details class="panopto-helper-setting-group">
              <summary>OpenAI 설정</summary>
              <label>
                OpenAI API Key
                <input type="password" data-setting="openaiApiKey" placeholder="sk-...">
              </label>
              <label>
                OpenAI Model
                <input type="text" data-setting="openaiModel" placeholder="gpt-5-mini">
              </label>
            </details>
            <details class="panopto-helper-setting-group">
              <summary>ChatGPT 프로젝트 설정</summary>
              <label>
                ChatGPT 프로젝트 URL
                <input type="url" data-setting="chatgptProjectUrl" placeholder="https://chatgpt.com/...">
              </label>
            </details>
            <div class="panopto-helper-inline-actions">
              <button class="panopto-helper-button primary" type="button" data-action="save-settings">설정 저장</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.documentElement.append(toggle, panel);

    const textarea = panel.querySelector(".panopto-helper-textarea");
    const output = panel.querySelector(".panopto-helper-output");
    const status = panel.querySelector(".panopto-helper-status");
    const settingsPanel = panel.querySelector(".panopto-helper-settings");
    const projectPanel = panel.querySelector(".panopto-helper-project-panel");
    const projectUrlInput = panel.querySelector("[data-project-url]");
    const transcriptActions = panel.querySelector(".panopto-helper-transcript-actions");
    const resultActions = panel.querySelector(".panopto-helper-result-actions");
    const liveCaptionButton = panel.querySelector('[data-action="toggle-live-captions"]');
    const openNotionButton = panel.querySelector('[data-action="open-notion-page"]');
    const notionStatus = panel.querySelector("[data-notion-status]");
    let activeNotionPageId = "";
    let activeNotionUrl = "";

    function updateLiveCaptionButton() {
      if (!liveCaptionButton) return;
      liveCaptionButton.classList.toggle("is-recording", !liveCaptionPaused);
      liveCaptionButton.textContent = liveCaptionPaused
        ? "재생 자막 캡처 시작"
        : "재생 자막 캡처 중";
    }

    function setCollapsed(target, collapsed) {
      const wrapper = panel.querySelector(`[data-collapsible="${target}"]`);
      if (!wrapper) return;
      wrapper.classList.toggle("is-collapsed", collapsed);
    }

    function showSection(section) {
      panel.querySelectorAll("[data-panel-section]").forEach((sectionElement) => {
        sectionElement.classList.toggle("is-active", sectionElement.dataset.panelSection === section);
      });
      panel.querySelectorAll("[data-section]").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.section === section);
      });
      setStatus(`${section === "text" ? "텍스트" : section === "send" ? "전송" : "설정"} 화면입니다.`);
    }

    function markWorking(action) {
      panel.querySelectorAll("[data-action]").forEach((button) => {
        button.classList.toggle("is-working", button.dataset.action === action);
      });
    }

    function setButtonBusy(button, label) {
      if (!button.dataset.idleText) {
        button.dataset.idleText = button.textContent;
      }
      button.classList.remove("is-done");
      button.classList.add("is-working");
      button.textContent = label;
      button.disabled = true;
    }

    function clearButtonState(button) {
      button.classList.remove("is-working", "is-done");
      button.textContent = button.dataset.idleText || button.textContent;
      button.disabled = false;
    }

    function markButtonDone(button, label) {
      if (!button.dataset.idleText) {
        button.dataset.idleText = button.textContent;
      }
      button.classList.remove("is-working");
      button.classList.add("is-done");
      button.textContent = label;
      button.disabled = false;
      setTimeout(() => {
        clearButtonState(button);
      }, 1800);
    }

    async function loadSettingsIntoPanel() {
      const settings = await getLocalSettings([
        "openaiApiKey",
        "openaiModel",
        "notionApiKey",
        "notionParentPageId",
        "chatgptProjectUrl"
      ]);

      settingsPanel.querySelector('[data-setting="openaiApiKey"]').value = settings.openaiApiKey || "";
      settingsPanel.querySelector('[data-setting="openaiModel"]').value = settings.openaiModel || "gpt-5-mini";
      settingsPanel.querySelector('[data-setting="notionApiKey"]').value = settings.notionApiKey || "";
      settingsPanel.querySelector('[data-setting="notionParentPageId"]').value = settings.notionParentPageId || "";
      settingsPanel.querySelector('[data-setting="chatgptProjectUrl"]').value = settings.chatgptProjectUrl || "";
    }

    async function saveSettingsFromPanel() {
      const items = {};
      settingsPanel.querySelectorAll("[data-setting]").forEach((input) => {
        items[input.dataset.setting] = input.value.trim();
      });

      if (!items.openaiModel) {
        items.openaiModel = "gpt-5-mini";
      }

      const saved = await setLocalSettings(items);
      setStatus(saved ? "설정을 저장했습니다." : "설정 저장에 실패했습니다.");
      if (saved) setNotionStatus("Notion 연결 상태: 확인 전", "");
      return items;
    }

    function getSettingsFromPanel() {
      const items = {};
      settingsPanel.querySelectorAll("[data-setting]").forEach((input) => {
        items[input.dataset.setting] = input.value.trim();
      });
      if (!items.openaiModel) {
        items.openaiModel = "gpt-5-mini";
      }
      return items;
    }

    async function clearStoredLiveCaptions() {
      await clearCurrentSessionLiveCaptions();
    }

    function updateNotionPageButton() {
      if (!openNotionButton) return;
      openNotionButton.hidden = !activeNotionUrl;
    }

    function setNotionStatus(message, state = "") {
      if (!notionStatus) return;
      notionStatus.textContent = message;
      notionStatus.dataset.state = state;
    }

    async function loadSavedNotionPage() {
      const key = getNotionPageStorageKey();
      const saved = await getLocalSettings([key]);
      const page = saved[key] || {};
      activeNotionPageId = page.id || "";
      activeNotionUrl = page.url || "";
      updateNotionPageButton();
      return page;
    }

    async function saveNotionPage(page) {
      activeNotionPageId = page.id || page.notionPageId || "";
      activeNotionUrl = page.url || page.notionUrl || "";
      updateNotionPageButton();
      await setLocalSettings({
        [getNotionPageStorageKey()]: {
          id: activeNotionPageId,
          url: activeNotionUrl,
          title: page.title || "",
          savedAt: Date.now()
        }
      });
    }

    async function ensureTranscriptText() {
      if (!textarea.value.trim()) {
        textarea.value = await extractTranscriptDeep();
      }
      if (!textarea.value.trim()) {
        throw new Error("대본을 먼저 추출하거나 붙여넣어 주세요.");
      }
      transcriptActions.hidden = false;
      return textarea.value;
    }

    async function ensureTidyText() {
      const transcript = await ensureTranscriptText();
      const tidied = tidyTranscript(transcript);
      if (!tidied.trim() || /^정돈할 텍스트가 너무 짧습니다/.test(tidied)) {
        throw new Error("Notion에 보낼 정돈 텍스트가 없습니다. 대본을 먼저 추출하거나 붙여넣어 주세요.");
      }
      output.textContent = tidied;
      resultActions.hidden = false;
      setCollapsed("result", false);
      return tidied;
    }

    function setStatus(message) {
      status.textContent = message;
    }

    function isSettingsError(message) {
      return /OpenAI API 키|Notion API 키|Notion 토큰|Integration Token|부모 페이지|접근할 수 없습니다|초대해 주세요|API token is invalid|unauthorized|restricted_resource|not found|설정/i.test(message || "");
    }

    toggle.addEventListener("click", () => {
      panel.classList.toggle("is-open");
    });

    panel.querySelector(".panopto-helper-close").addEventListener("click", () => {
      panel.classList.remove("is-open");
    });

    panel.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;

      const action = button.dataset.action;
      if (action === "show-section") {
        showSection(button.dataset.section);
        if (button.dataset.section === "settings") {
          await loadSettingsIntoPanel();
        } else if (button.dataset.section === "send") {
          const savedPage = await loadSavedNotionPage();
          if (savedPage.url) {
            setStatus(`전송 화면입니다. 최근 Notion 페이지: ${savedPage.url}`);
          }
        }
        return;
      }

      if (action === "toggle-collapse") {
        const target = button.dataset.target;
        const wrapper = panel.querySelector(`[data-collapsible="${target}"]`);
        if (wrapper) {
          wrapper.classList.toggle("is-collapsed");
        }
        return;
      }

      if (action === "extract") {
        setButtonBusy(button, "대본 추출 중...");
        markWorking(action);
        startLiveCaptionCapture();
        setStatus("대본을 찾는 중입니다. 자막/대본 패널, 영상 자막 트랙, 재생 중 자막을 함께 확인합니다.");
        try {
          const extracted = await extractTranscriptDeep();
          textarea.value = extracted;
          transcriptActions.hidden = !extracted;
          if (extracted) setCollapsed("transcript", false);
          setStatus(extracted ? `대본 후보를 ${extracted.length.toLocaleString("ko-KR")}자 추출했습니다.` : `자동 추출에 실패했습니다. ${getExtractionDiagnostics()}`);
          if (extracted) markButtonDone(button, "대본 추출 완료");
        } catch (error) {
          setStatus(error.message || String(error));
        } finally {
          markWorking("");
          if (!button.classList.contains("is-done")) {
            clearButtonState(button);
          }
        }
      }

      if (action === "tidy") {
        markWorking(action);
        output.textContent = tidyTranscript(textarea.value);
        resultActions.hidden = !output.textContent.trim();
        if (output.textContent.trim()) setCollapsed("result", false);
        setStatus("문장을 크게 바꾸지 않고 줄 정리와 불필요한 설명 제거만 적용했습니다.");
        markWorking("");
      }

      if (action === "toggle-live-captions") {
        if (liveCaptionPaused) {
          resumeLiveCaptionCapture();
          setStatus("재생 중인 자막을 누적 캡처하는 중입니다. 다시 누르면 일시중지합니다.");
        } else {
          pauseLiveCaptionCapture();
          setStatus("재생 자막 캡처를 일시중지했습니다. 다시 누르면 이어서 캡처합니다.");
        }
        updateLiveCaptionButton();
      }

      if (action === "load-live-captions") {
        const captured = await loadStoredLiveCaptions();
        if (captured) {
          textarea.value = captured;
          transcriptActions.hidden = false;
          setCollapsed("transcript", false);
          setStatus(`누적 자막 ${captured.length.toLocaleString("ko-KR")}자를 불러왔습니다.`);
        } else {
          setStatus(`누적된 자막이 없습니다. ${getExtractionDiagnostics()}`);
        }
      }

      if (action === "clear-live-captions") {
        await clearStoredLiveCaptions();
        setStatus("누적 자막을 초기화했습니다.");
      }

      if (action === "toggle-settings") {
        showSection("settings");
        await loadSettingsIntoPanel();
      }

      if (action === "save-settings") {
        markWorking(action);
        await saveSettingsFromPanel();
        markWorking("");
      }

      if (action === "test-notion") {
        setButtonBusy(button, "Notion 확인 중...");
        markWorking(action);
        setStatus("Notion 부모 페이지 접근을 확인하는 중입니다.");

        try {
          const settings = getSettingsFromPanel();
          await setLocalSettings(settings);
          const response = await sendRuntimeMessage({
            type: "testNotionConnection",
            payload: {
              notionApiKey: settings.notionApiKey,
              notionParentPageId: settings.notionParentPageId
            }
          });

          if (!response?.ok) {
            throw new Error(response?.error || "Notion 연결 테스트에 실패했습니다.");
          }

          const page = response.result;
          setNotionStatus(`Notion 연결 상태: 정상 · ${page.title}`, "ok");
          setStatus(`Notion 연결 확인 완료: ${page.title} (${page.pageId})`);
          markButtonDone(button, "Notion 연결 확인 완료");
        } catch (error) {
          setNotionStatus("Notion 연결 상태: 확인 실패", "error");
          setStatus(error.message || String(error));
        } finally {
          markWorking("");
          if (!button.classList.contains("is-done")) {
            clearButtonState(button);
          }
        }
      }

      if (action === "chatgpt-project") {
        const savedProjectUrl = (await getLocalSetting("chatgptProjectUrl")).trim();
        if (savedProjectUrl) {
          projectPanel.hidden = true;
          projectUrlInput.value = savedProjectUrl;
          setButtonBusy(button, "프로젝트 여는 중...");
          markWorking(action);
          setStatus("ChatGPT 프로젝트에 붙여넣을 프롬프트를 준비하는 중입니다.");

          try {
            if (!textarea.value.trim()) {
              textarea.value = await extractTranscriptDeep();
            }

            if (!textarea.value.trim()) {
              throw new Error("대본을 먼저 추출하거나 붙여넣어 주세요.");
            }

            await copyToClipboard(buildChatGptPrompt(textarea.value, await getLectureTitle()));
            window.open(savedProjectUrl, "_blank", "noopener,noreferrer");
            setStatus("프롬프트를 복사했고 설정된 ChatGPT 프로젝트를 열었습니다. 프로젝트 채팅 입력창에 붙여넣으면 됩니다.");
            markButtonDone(button, "프로젝트 열기 완료");
          } catch (error) {
            setStatus(error.message || String(error));
          } finally {
            markWorking("");
            if (!button.classList.contains("is-done")) {
              clearButtonState(button);
            }
          }
        } else {
          projectPanel.hidden = false;
          projectUrlInput.value = "";
          projectUrlInput.focus();
          setStatus("설정된 ChatGPT 프로젝트 URL이 없습니다. 프로젝트 링크를 입력해 주세요.");
        }
      }

      if (action === "close-chatgpt-project") {
        projectPanel.hidden = true;
      }

      if (action === "open-chatgpt-project") {
        setButtonBusy(button, "프로젝트 여는 중...");
        markWorking(action);
        setStatus("ChatGPT 프로젝트에 붙여넣을 프롬프트를 준비하는 중입니다.");

        try {
          const projectUrl = projectUrlInput.value.trim();
          await setLocalSettings({ chatgptProjectUrl: projectUrl });

          if (!textarea.value.trim()) {
            textarea.value = await extractTranscriptDeep();
          }

          if (!textarea.value.trim()) {
            throw new Error("대본을 먼저 추출하거나 붙여넣어 주세요.");
          }

          await copyToClipboard(buildChatGptPrompt(textarea.value, await getLectureTitle()));
          window.open(projectUrl || "https://chatgpt.com/", "_blank", "noopener,noreferrer");
          setStatus("프롬프트를 복사했고 ChatGPT를 열었습니다. 프로젝트 채팅 입력창에 붙여넣으면 됩니다.");
          markButtonDone(button, "프로젝트 열기 완료");
        } catch (error) {
          setStatus(error.message || String(error));
        } finally {
          markWorking("");
          if (!button.classList.contains("is-done")) {
            clearButtonState(button);
          }
        }
      }

      if (action === "upload-notion") {
        setButtonBusy(button, "Notion 업로드 중...");
        markWorking(action);
        setStatus("정돈된 텍스트를 Notion에 업로드하는 중입니다.");

        try {
          const transcript = await ensureTidyText();
          await loadSavedNotionPage();
          const title = await getLectureTitle();
          const shouldAppendToExisting = activeNotionPageId
            ? window.confirm("이미 이 영상으로 만든 Notion 페이지가 있습니다.\n\n확인: 기존 페이지에 정돈 대본 갱신 추가\n취소: 새 하위 페이지 생성")
            : false;

          const response = await sendRuntimeMessage({
            type: shouldAppendToExisting ? "appendTranscriptToNotion" : "uploadTranscriptToNotion",
            payload: {
              transcript,
              title,
              pageUrl: location.href,
              notionPageId: activeNotionPageId,
              notionUrl: activeNotionUrl
            }
          });

          if (!response?.ok) {
            throw new Error(response?.error || "업로드에 실패했습니다.");
          }

          await saveNotionPage(response.result);
          const notionUrl = response.result.notionUrl;
          setStatus(notionUrl ? `정돈된 텍스트를 Notion에 ${shouldAppendToExisting ? "추가" : "업로드"}했습니다: ${notionUrl}` : `정돈된 텍스트를 Notion에 ${shouldAppendToExisting ? "추가" : "업로드"}했습니다.`);
          markButtonDone(button, shouldAppendToExisting ? "Notion 추가 완료" : "Notion 업로드 완료");
        } catch (error) {
          if (isSettingsError(error.message)) {
            showSection("settings");
            await loadSettingsIntoPanel();
          }
          setStatus(error.message || String(error));
        } finally {
          markWorking("");
          if (!button.classList.contains("is-done")) {
            clearButtonState(button);
          }
        }
      }

      if (action === "open-notion-page") {
        if (activeNotionUrl) {
          window.open(activeNotionUrl, "_blank", "noopener,noreferrer");
          setStatus("최근 Notion 페이지를 열었습니다.");
        } else {
          setStatus("아직 연결된 Notion 페이지가 없습니다.");
        }
      }

      if (action === "gpt-update-notion") {
        setButtonBusy(button, "GPT 정리 추가 중...");
        markWorking(action);
        setStatus("GPT로 정리한 뒤 Notion 페이지에 추가하는 중입니다.");

        try {
          const transcript = await ensureTidyText();
          if (!activeNotionPageId) {
            await loadSavedNotionPage();
          }

          const response = await sendRuntimeMessage({
            type: "summarizeAndUploadToNotion",
            payload: {
              transcript,
              title: await getLectureTitle(),
              pageUrl: location.href,
              notionPageId: activeNotionPageId,
              notionUrl: activeNotionUrl
            }
          });

          if (!response?.ok) {
            throw new Error(response?.error || "GPT 정리 또는 Notion 갱신에 실패했습니다.");
          }

          await saveNotionPage(response.result);
          output.textContent = response.result.summary;
          resultActions.hidden = !output.textContent.trim();
          if (output.textContent.trim()) setCollapsed("result", false);
          const notionUrl = response.result.notionUrl;
          setStatus(notionUrl ? `GPT 정리본을 Notion에 추가했습니다: ${notionUrl}` : "GPT 정리본을 Notion에 추가했습니다.");
          markButtonDone(button, "GPT 정리 추가 완료");
        } catch (error) {
          if (isSettingsError(error.message)) {
            showSection("settings");
            await loadSettingsIntoPanel();
          }
          setStatus(error.message || String(error));
        } finally {
          markWorking("");
          if (!button.classList.contains("is-done")) {
            clearButtonState(button);
          }
        }
      }

      if (action === "copy-transcript") {
        const text = textarea.value || "";
        if (!text.trim()) {
          setStatus("복사할 대본이 없습니다.");
          return;
        }
        await copyToClipboard(text);
        setStatus("대본을 클립보드에 복사했습니다.");
      }

      if (action === "download-transcript") {
        const text = textarea.value || "";
        if (!text.trim()) {
          setStatus("저장할 대본이 없습니다.");
          return;
        }
        downloadMarkdown(text);
        setStatus("대본을 Markdown 파일로 저장했습니다.");
      }

      if (action === "copy-result") {
        const text = output.textContent || "";
        if (!text.trim()) {
          setStatus("복사할 정리본이 없습니다.");
          return;
        }
        await copyToClipboard(text);
        setStatus("정리본을 클립보드에 복사했습니다.");
      }

      if (action === "download-result") {
        const text = output.textContent || "";
        if (!text.trim()) {
          setStatus("저장할 정리본이 없습니다.");
          return;
        }
        downloadMarkdown(text);
        setStatus("정리본을 Markdown 파일로 저장했습니다.");
      }
    });
  }

  function boot() {
    if (isTopFrame()) {
      createPanel();
    }
  }

  window.addEventListener("pagehide", () => {
    stopLiveCaptionCapture();
    clearCurrentSessionLiveCaptions();
  });

  window.addEventListener("beforeunload", () => {
    stopLiveCaptionCapture();
    clearCurrentSessionLiveCaptions();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
