const fields = [
  "openaiApiKey",
  "openaiModel",
  "notionApiKey",
  "notionParentPageId"
];

function getField(id) {
  return document.getElementById(id);
}

function loadOptions() {
  chrome.storage.local.get(fields, (items) => {
    getField("openaiApiKey").value = items.openaiApiKey || "";
    getField("openaiModel").value = items.openaiModel || "gpt-5-mini";
    getField("notionApiKey").value = items.notionApiKey || "";
    getField("notionParentPageId").value = items.notionParentPageId || "";
  });
}

function saveOptions() {
  const items = {};
  fields.forEach((field) => {
    items[field] = getField(field).value.trim();
  });

  if (!items.openaiModel) {
    items.openaiModel = "gpt-5-mini";
  }

  chrome.storage.local.set(items, () => {
    const status = getField("status");
    status.textContent = "저장했습니다.";
    setTimeout(() => {
      status.textContent = "";
    }, 1800);
  });
}

document.addEventListener("DOMContentLoaded", loadOptions);
getField("save").addEventListener("click", saveOptions);
