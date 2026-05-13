(() => {
  const PANEL_ID = "panopto-concept-helper-panel";
  const TOGGLE_ID = "panopto-concept-helper-toggle";
  const MIN_TEXT_LENGTH = 80;

  const STOPWORDS = new Set([
    "그리고", "그러면", "그런데", "하지만", "입니다", "합니다", "있습니다", "수",
    "있는", "없는", "것", "거", "이", "그", "저", "때", "좀", "더", "등", "및",
    "에서", "으로", "에게", "까지", "부터", "처럼", "대한", "대해서", "통해",
    "영상", "강의", "오늘", "이번", "여기", "부분", "내용", "설명", "보시면",
    "이제", "다음", "하나", "있는지", "하면", "해서", "하고", "같은", "관련"
  ]);

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

  function extractTranscript() {
    const sources = [
      collectFromTranscriptLikeNodes(),
      collectFromScripts(),
      collectFromPageTextFallback()
    ].filter((text) => text.length >= MIN_TEXT_LENGTH);

    if (!sources.length) return "";
    return sources.sort((a, b) => b.length - a.length)[0];
  }

  function splitSentences(text) {
    return normalizeText(text)
      .replace(/\n+/g, " ")
      .split(/(?<=[.!?。！？]|다\.|요\.|죠\.|니다\.)\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 18);
  }

  function tokenize(text) {
    return normalizeText(text)
      .toLowerCase()
      .match(/[가-힣a-zA-Z0-9]{2,}/g)
      ?.filter((word) => !STOPWORDS.has(word) && !/^\d+$/.test(word)) || [];
  }

  function scoreKeywords(text) {
    const counts = new Map();
    tokenize(text).forEach((word) => {
      counts.set(word, (counts.get(word) || 0) + 1);
    });

    return [...counts.entries()]
      .map(([word, count]) => ({ word, count, score: count * Math.min(word.length, 8) }))
      .sort((a, b) => b.score - a.score || b.count - a.count)
      .slice(0, 18);
  }

  function pickCoreSentences(sentences, keywords) {
    const keywordSet = new Set(keywords.slice(0, 12).map((item) => item.word));
    return sentences
      .map((sentence, index) => {
        const words = tokenize(sentence);
        const keywordHits = words.filter((word) => keywordSet.has(word)).length;
        const lengthScore = sentence.length >= 45 && sentence.length <= 180 ? 2 : 0;
        return { sentence, index, score: keywordHits * 3 + lengthScore };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 8)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.sentence);
  }

  function summarizeConcepts(text) {
    const cleanText = normalizeText(text);
    const sentences = splitSentences(cleanText);
    const keywords = scoreKeywords(cleanText);
    const coreSentences = pickCoreSentences(sentences, keywords);
    const title = document.title.replace(/\s*-\s*Panopto.*$/i, "").trim() || "Panopto 강의";

    if (cleanText.length < MIN_TEXT_LENGTH) {
      return "정리할 텍스트가 너무 짧습니다. Panopto에서 대본을 다운로드한 뒤 붙여넣어 주세요.";
    }

    const keywordLine = keywords.slice(0, 12).map((item) => item.word).join(", ");
    const conceptNotes = coreSentences.length
      ? coreSentences.map((sentence) => `- ${sentence}`).join("\n")
      : "- 핵심 문장을 충분히 찾지 못했습니다. 대본 텍스트를 더 길게 붙여넣어 주세요.";
    const questions = keywords.slice(0, 5)
      .map((item) => `- ${item.word}의 의미와 강의에서의 역할은 무엇인가?`)
      .join("\n");

    return [
      `# ${title} 개념 정리`,
      "",
      "## 핵심 키워드",
      keywordLine || "- 추출된 키워드 없음",
      "",
      "## 개념 요약",
      conceptNotes,
      "",
      "## 복습 질문",
      questions || "- 강의의 핵심 주장과 근거는 무엇인가?",
      "",
      "## 원문 길이",
      `- 약 ${cleanText.length.toLocaleString("ko-KR")}자`
    ].join("\n");
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
          <button class="panopto-helper-button primary" type="button" data-action="extract">대본 추출</button>
          <button class="panopto-helper-button" type="button" data-action="summarize">개념 정리</button>
          <button class="panopto-helper-button primary" type="button" data-action="upload-notion">GPT+Notion 업로드</button>
          <button class="panopto-helper-button" type="button" data-action="copy">결과 복사</button>
          <button class="panopto-helper-button" type="button" data-action="download">Markdown 저장</button>
        </div>
        <div class="panopto-helper-status"></div>
        <textarea class="panopto-helper-textarea" placeholder="대본이 자동 추출되지 않으면 Panopto에서 Download transcript로 받은 텍스트를 여기에 붙여넣으세요."></textarea>
        <pre class="panopto-helper-output"></pre>
      </div>
    `;

    document.documentElement.append(toggle, panel);

    const textarea = panel.querySelector(".panopto-helper-textarea");
    const output = panel.querySelector(".panopto-helper-output");
    const status = panel.querySelector(".panopto-helper-status");

    function setStatus(message) {
      status.textContent = message;
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
      if (action === "extract") {
        const extracted = extractTranscript();
        textarea.value = extracted;
        setStatus(extracted ? `대본 후보를 ${extracted.length.toLocaleString("ko-KR")}자 추출했습니다.` : "자동 추출에 실패했습니다. Panopto 대본 다운로드 텍스트를 붙여넣어 주세요.");
      }

      if (action === "summarize") {
        output.textContent = summarizeConcepts(textarea.value);
        setStatus("개념 정리를 만들었습니다.");
      }

      if (action === "upload-notion") {
        button.disabled = true;
        setStatus("OpenAI로 정리한 뒤 Notion에 업로드하는 중입니다.");

        try {
          if (!textarea.value.trim()) {
            textarea.value = extractTranscript();
          }

          const response = await sendRuntimeMessage({
            type: "summarizeAndUploadToNotion",
            payload: {
              transcript: textarea.value,
              title: document.title.replace(/\s*-\s*Panopto.*$/i, "").trim(),
              pageUrl: location.href
            }
          });

          if (!response?.ok) {
            throw new Error(response?.error || "업로드에 실패했습니다.");
          }

          output.textContent = response.result.summary;
          const notionUrl = response.result.notionUrl;
          setStatus(notionUrl ? `Notion 업로드 완료: ${notionUrl}` : "Notion 업로드 완료");
        } catch (error) {
          setStatus(error.message || String(error));
        } finally {
          button.disabled = false;
        }
      }

      if (action === "copy") {
        const text = output.textContent || "";
        if (!text.trim()) {
          setStatus("복사할 결과가 없습니다.");
          return;
        }
        await copyToClipboard(text);
        setStatus("결과를 클립보드에 복사했습니다.");
      }

      if (action === "download") {
        const text = output.textContent || "";
        if (!text.trim()) {
          setStatus("저장할 결과가 없습니다.");
          return;
        }
        downloadMarkdown(text);
        setStatus("Markdown 파일로 저장했습니다.");
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createPanel);
  } else {
    createPanel();
  }
})();
