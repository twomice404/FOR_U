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

function getNotionErrorMessage(data, status) {
  const message = data?.message || "";
  const code = data?.code || "";
  const lower = `${message} ${code}`.toLowerCase();
  const detail = code ? ` Notion 응답 코드: ${code}` : "";

  if (status === 401 || lower.includes("api token is invalid") || lower.includes("unauthorized")) {
    return `Notion 토큰이 올바르지 않습니다. 설정에서 Notion Integration Token을 다시 확인해 주세요.${detail}`;
  }

  if (status === 403 || lower.includes("restricted_resource") || lower.includes("insufficient")) {
    return `Notion 통합이 이 부모 페이지에 접근할 수 없습니다. Notion에서 해당 부모 페이지에 Integration을 초대해 주세요.${detail}`;
  }

  if (status === 404 || lower.includes("could not find") || lower.includes("not found")) {
    return `Notion 부모 페이지를 찾지 못했습니다. 부모 페이지 URL/ID가 맞는지, 설정 저장을 눌렀는지 확인해 주세요.${detail}`;
  }

  return `${message || `Notion API 오류: ${status}`}${detail}`;
}

function extractNotionPageTitle(page) {
  const titleProperty = page?.properties?.title?.title
    || page?.properties?.Name?.title
    || page?.properties?.이름?.title;
  if (!Array.isArray(titleProperty)) return "제목 없음";
  const title = titleProperty.map((item) => item.plain_text || item.text?.content || "").join("").trim();
  return title || "제목 없음";
}

async function retrieveNotionPage({ apiKey, parentPageId }) {
  const pageId = normalizeNotionId(parentPageId);
  if (!pageId) {
    throw new Error("Notion 부모 페이지 URL 또는 ID에서 페이지 ID를 읽지 못했습니다.");
  }

  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = getNotionErrorMessage(data, response.status);
    throw new Error(message);
  }

  return {
    pageId,
    title: extractNotionPageTitle(data),
    url: data.url || ""
  };
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
        "대본의 원문 문장을 근거로 삼고, 오탈자/띄어쓰기만 자연스럽게 정돈한다.",
        "화면 오브젝트 설명, 접근성용 설명, 플레이어 조작 설명은 제외한다.",
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

function makeParagraphBlocks(text, options = {}) {
  const blocks = [];
  const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
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

  return blocks.slice(0, limit);
}

async function appendNotionBlocks({ apiKey, blockId, blocks }) {
  const response = await fetch(`https://api.notion.com/v1/blocks/${blockId}/children`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION
    },
    body: JSON.stringify({ children: blocks.slice(0, 100) })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = getNotionErrorMessage(data, response.status);
    throw new Error(message);
  }
}

async function createNotionPage({ apiKey, parentPageId, title, content, sourceUrl, contentLabel = "정리본" }) {
  const pageId = normalizeNotionId(parentPageId);
  if (!pageId) {
    throw new Error("Notion 부모 페이지 ID가 올바르지 않습니다.");
  }

  const contentBlocks = makeParagraphBlocks(content);
  const children = [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: richText(sourceUrl ? `원본 Panopto 링크: ${sourceUrl}` : "원본 Panopto 링크 없음")
      }
    },
    {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: richText(contentLabel) }
    },
    ...contentBlocks.slice(0, 98)
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
    const message = getNotionErrorMessage(data, response.status);
    throw new Error(message);
  }

  for (let index = 98; index < contentBlocks.length; index += 100) {
    await appendNotionBlocks({
      apiKey,
      blockId: data.id,
      blocks: contentBlocks.slice(index, index + 100)
    });
  }

  return {
    id: data.id || "",
    url: data.url || ""
  };
}

async function appendSummaryToPage({ apiKey, pageId, summary }) {
  const targetPageId = normalizeNotionId(pageId);
  if (!targetPageId) {
    throw new Error("갱신할 Notion 페이지 ID가 올바르지 않습니다.");
  }

  await appendNotionBlocks({
    apiKey,
    blockId: targetPageId,
    blocks: [
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: richText("GPT 정리본") }
      },
      ...makeParagraphBlocks(summary, { limit: 99 })
    ]
  });
}

async function handleUploadTranscript(payload) {
  const settings = await getSettings();
  if (!settings.notionApiKey || !settings.notionParentPageId) {
    throw new Error("Notion API 키 또는 부모 페이지 ID가 설정되어 있지 않습니다.");
  }
  if (!payload.transcript || payload.transcript.trim().length < 20) {
    throw new Error("업로드할 대본 텍스트가 너무 짧습니다.");
  }

  const pageTitle = (payload.title || "").trim() || "Panopto 강의";
  const notionPage = await createNotionPage({
    apiKey: settings.notionApiKey,
    parentPageId: settings.notionParentPageId,
    title: pageTitle,
    content: payload.transcript,
    sourceUrl: payload.pageUrl,
    contentLabel: "원문 대본"
  });

  return { notionPageId: notionPage.id, notionUrl: notionPage.url, title: pageTitle };
}

async function handleTestNotionConnection(payload) {
  const settings = await getSettings();
  const apiKey = payload.notionApiKey || settings.notionApiKey;
  const parentPageId = payload.notionParentPageId || settings.notionParentPageId;

  if (!apiKey || !parentPageId) {
    throw new Error("Notion 토큰과 부모 페이지 URL 또는 ID를 먼저 입력해 주세요.");
  }

  return retrieveNotionPage({ apiKey, parentPageId });
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

  const pageTitle = (payload.title || "").trim() || "Panopto 강의";
  let notionPageId = payload.notionPageId || "";
  let notionUrl = payload.notionUrl || "";

  if (!normalizeNotionId(notionPageId)) {
    const notionPage = await createNotionPage({
      apiKey: settings.notionApiKey,
      parentPageId: settings.notionParentPageId,
      title: pageTitle,
      content: payload.transcript,
      sourceUrl: payload.pageUrl,
      contentLabel: "원문 대본"
    });
    notionPageId = notionPage.id;
    notionUrl = notionPage.url;
  }

  const summary = await createOpenAiSummary({
    apiKey: settings.openaiApiKey,
    model: settings.openaiModel,
    title: pageTitle,
    pageUrl: payload.pageUrl,
    transcript: payload.transcript
  });

  await appendSummaryToPage({
    apiKey: settings.notionApiKey,
    pageId: notionPageId,
    summary
  });

  return { summary, notionPageId, notionUrl };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    testNotionConnection: handleTestNotionConnection,
    uploadTranscriptToNotion: handleUploadTranscript,
    summarizeAndUploadToNotion: handleSummarizeAndUpload
  };
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message.payload || {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});
