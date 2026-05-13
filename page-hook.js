(() => {
  const SOURCE = "panopto-concept-helper-page-hook";
  const MAX_CAPTURE_CHARS = 250000;
  const interestingUrlPattern = /(caption|transcript|subtitle|deliveryinfo|search|event|note|asr|srt|vtt|ttml|dfxp|자막|대본)/i;
  const interestingTextPattern = /(WEBVTT|-->|"Caption"|"captions"|"Transcript"|"transcript"|"TimedEvent"|"Events"|"Cues"|"Text"|"StartTime"|자막|대본)/i;
  const seen = new Set();

  function postCaptured(url, text) {
    if (!text || text.length < 40) return;
    if (!interestingUrlPattern.test(url || "") && !interestingTextPattern.test(text)) return;

    const key = `${url || "inline"}:${text.length}:${text.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);

    window.postMessage({
      source: SOURCE,
      type: "captured-text",
      url: url || "",
      text: text.slice(0, MAX_CAPTURE_CHARS)
    }, "*");
  }

  function captureResponse(url, response) {
    try {
      const contentType = response.headers?.get?.("content-type") || "";
      if (!interestingUrlPattern.test(url || "") && !/json|text|xml|vtt|srt|html/i.test(contentType)) {
        return;
      }

      response.clone().text().then((text) => postCaptured(url, text)).catch(() => {});
    } catch {
      // Ignore responses that cannot be cloned/read.
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      const request = args[0];
      const url = typeof request === "string" ? request : request?.url || "";
      captureResponse(url, response);
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__panoptoHelperUrl = url ? String(url) : "";
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener("load", () => {
      try {
        const url = this.__panoptoHelperUrl || "";
        if (!interestingUrlPattern.test(url) && !interestingTextPattern.test(this.responseText || "")) return;
        postCaptured(url, this.responseText || "");
      } catch {
        // Binary or cross-origin responses may be unreadable.
      }
    });

    return originalSend.apply(this, args);
  };
})();
