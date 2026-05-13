const SETTINGS_KEYS = [
  "openaiApiKey",
  "openaiModel",
  "notionApiKey",
  "notionParentPageId"
];

const DEFAULT_MODEL = "gpt-5-mini";
const NOTION_VERSION = "2026-03-11";
const MAX_TRANSCRIPT_CHARS = 90000;

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEYS, (items) => {
      resolve({
        openaiApiKey: items.openaiApiKey || "",
        openaiModel: items.openaiModel || DEFAULT_MODEL,
        notionApiKey: items.notionApiKey || "",
        notionParentPageId: items.notionParentPageId || ""
      });
    });
  });
}

function normalizeNotionId(value) {
  return (value || "")
    .trim()
    .replace(/-/g, "")
    .match(/[0-9a-fA-F]{32}/)?.[0] || "";
}

function extractOutputText(responseJson) {
  if (typeof responseJson.output_text === "string") {
    return responseJson.output_text.trim();
  }

  const parts = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

async function createOpenAiSummary({ apiKey, model, title, pageUrl, transcript }) {
  const clippedTranscript = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  const wasClipped = transcript.length > clippedTranscript.length;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      store: false,
      instructions: [
        "너는 대학 강의 대본을 학습 노트로 정리하는 한국어 조교다.",
        "출력은 Notion에 붙여 넣기 좋은 Markdown 형식으로 작성한다.",
        "환각을 피하고, 대본에 없는 내용은 추측하지 않는다.",
        "구조: 핵심 요약, 주요 개념, 흐름 정리, 시험/복습 포인트, 헷갈리기 쉬운 점, 복습 질문.",
        "중요 용어는 굵게 표시하고, 문장은 간결하게 쓴다."
      ].join("\n"),
      input: [
        `강의 제목: ${title || "Panopto 강의"}`,
        `강의 URL: ${pageUrl || ""}`,
        wasClipped ? "주의: 대본이 길어 앞부분 일부만 전달됨." : "",
        "",
        "대본:",
        clippedTranscript
      ].join("\n")
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI API 오류: ${response.status}`;
    throw new Error(message);
  }

  const summary = extractOutputText(data);
  if (!summary) {
    throw new Error("OpenAI 응답에서 정리 텍스트를 찾지 못했습니다.");
  }

  return summary;
}

function richText(content) {
  return [{ type: "text", text: { content: content.slice(0, 2000) } }];
}

function makeParagraphBlocks(text) {
  const blocks = [];
  const lines = text.split("\n").map((line) => line.trim());

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith("### ")) {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: richText(line.slice(4)) }
      });
    } else if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: richText(line.slice(3)) }
      });
    } else if (line.startsWith("# ")) {
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: richText(line.slice(2)) }
      });
    } else if (line.startsWith("- ")) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: richText(line.slice(2)) }
      });
    } else {
      for (let i = 0; i < line.length; i += 1900) {
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: richText(line.slice(i, i + 1900)) }
        });
      }
    }
  }

  return blocks.slice(0, 95);
}

async function createNotionPage({ apiKey, parentPageId, title, summary, sourceUrl }) {
  const pageId = normalizeNotionId(parentPageId);
  if (!pageId) {
    throw new Error("Notion 부모 페이지 ID가 올바르지 않습니다.");
  }

  const children = [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: richText(sourceUrl ? `원본 Panopto 링크: ${sourceUrl}` : "원본 Panopto 링크 없음")
      }
    },
    ...makeParagraphBlocks(summary)
  ];

  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION
    },
    body: JSON.stringify({
      parent: { page_id: pageId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title || "Panopto 강의 정리" } }]
        }
      },
      children
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.message || `Notion API 오류: ${response.status}`;
    throw new Error(message);
  }

  return data.url || "";
}

async function handleSummarizeAndUpload(payload) {
  const settings = await getSettings();
  if (!settings.openaiApiKey) {
    throw new Error("OpenAI API 키가 설정되어 있지 않습니다.");
  }
  if (!settings.notionApiKey || !settings.notionParentPageId) {
    throw new Error("Notion API 키 또는 부모 페이지 ID가 설정되어 있지 않습니다.");
  }
  if (!payload.transcript || payload.transcript.trim().length < 80) {
    throw new Error("정리할 대본 텍스트가 너무 짧습니다.");
  }

  const summary = await createOpenAiSummary({
    apiKey: settings.openaiApiKey,
    model: settings.openaiModel,
    title: payload.title,
    pageUrl: payload.pageUrl,
    transcript: payload.transcript
  });

  const notionUrl = await createNotionPage({
    apiKey: settings.notionApiKey,
    parentPageId: settings.notionParentPageId,
    title: `${payload.title || "Panopto 강의"} 정리`,
    summary,
    sourceUrl: payload.pageUrl
  });

  return { summary, notionUrl };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "summarizeAndUploadToNotion") {
    return false;
  }

  handleSummarizeAndUpload(message.payload || {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});
