/* Nova AI — frontend logic
 * Handles: chat streaming (SSE), conversation persistence (localStorage),
 * model selection, and settings.
 */

const API = "/api";

// ---- State ----
let state = {
  chats: {},        // id -> { id, title, messages: [{role, content}] }
  currentId: null,
  model: null,
  settings: {
    systemPrompt: "",
    temperature: null, // null = use model default (avoids "temperature deprecated" errors)
    maxTokens: null,
  },
  streaming: false,
  abortCtrl: null,
  pendingAttachments: [], // files attached to the next message
};

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = $("sendBtn");
const stopBtn = $("stopBtn");
const chatListEl = $("chatList");
const modelSelect = $("modelSelect");
const fileInput = $("fileInput");
const attachBtn = $("attachBtn");
const attachmentsEl = $("attachments");

// ---- Persistence ----
const STORAGE_KEY = "nova_ai_state_v1";

function saveState() {
  const toSave = {
    chats: state.chats,
    currentId: state.currentId,
    model: state.model,
    settings: state.settings,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.chats = data.chats || {};
    state.currentId = data.currentId || null;
    state.model = data.model || null;
    state.settings = { ...state.settings, ...(data.settings || {}) };
  } catch (e) {
    console.warn("Failed to load state", e);
  }
}

// ---- Utility ----
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function renderMarkdown(text) {
  const html = marked.parse(text, { breaks: true, gfm: true });
  return DOMPurify.sanitize(html);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---- Chat management ----
function newChat() {
  const id = uid();
  state.chats[id] = { id, title: "New chat", messages: [] };
  state.currentId = id;
  saveState();
  renderChatList();
  renderMessages();
  inputEl.focus();
}

function deleteChat(id) {
  delete state.chats[id];
  if (state.currentId === id) {
    const remaining = Object.keys(state.chats);
    state.currentId = remaining.length ? remaining[0] : null;
    if (!state.currentId) newChat();
  }
  saveState();
  renderChatList();
  renderMessages();
}

function clearAllChats() {
  if (!confirm("Delete all conversations? This cannot be undone.")) return;
  state.chats = {};
  state.currentId = null;
  newChat();
}

function currentChat() {
  return state.chats[state.currentId];
}

function switchChat(id) {
  state.currentId = id;
  saveState();
  renderChatList();
  renderMessages();
}

// ---- Rendering ----
function renderChatList() {
  chatListEl.innerHTML = "";
  const ids = Object.keys(state.chats).sort((a, b) => b.localeCompare(a));
  for (const id of ids) {
    const chat = state.chats[id];
    const item = document.createElement("div");
    item.className = "chat-item" + (id === state.currentId ? " active" : "");
    item.innerHTML = `<span class="title">${escapeHtml(chat.title)}</span>
      <button class="del" title="Delete">🗑️</button>`;
    item.querySelector(".title").onclick = () => switchChat(id);
    item.querySelector(".del").onclick = (e) => {
      e.stopPropagation();
      deleteChat(id);
    };
    chatListEl.appendChild(item);
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderMessages() {
  const chat = currentChat();
  messagesEl.innerHTML = "";

  if (!chat || chat.messages.length === 0) {
    renderWelcome();
    return;
  }

  for (const msg of chat.messages) {
    appendMessageRow(msg.role, msg.content, msg.attachments);
  }
  scrollToBottom();
}

function renderWelcome() {
  messagesEl.innerHTML = `
    <div class="welcome" id="welcome">
      <div class="welcome-logo">✦</div>
      <h1>How can I help you today?</h1>
      <p>Ask me anything — powered by your LiteLLM Hyperspace proxy.</p>
      <div class="suggestions">
        <button class="suggestion">Explain quantum computing simply</button>
        <button class="suggestion">Write a Python script to rename files</button>
        <button class="suggestion">Give me ideas for a weekend project</button>
        <button class="suggestion">Summarize the theory of relativity</button>
      </div>
    </div>`;
  messagesEl.querySelectorAll(".suggestion").forEach((btn) => {
    btn.onclick = () => {
      inputEl.value = btn.textContent;
      sendMessage();
    };
  });
}

function attachmentChipsHtml(attachments) {
  if (!attachments || !attachments.length) return "";
  const chips = attachments
    .map((att) => {
      const thumb =
        att.type === "image" && att.data_url
          ? `<img class="thumb" src="${att.data_url}" alt="" />`
          : `<span class="ic">${iconFor(att)}</span>`;
      const sub =
        att.type === "unsupported"
          ? escapeHtml(att.reason || "Unsupported")
          : att.size
          ? fmtSize(att.size)
          : att.type;
      return `<div class="attach-chip ${att.type === "unsupported" ? "error" : ""}">
        ${thumb}
        <div class="meta">
          <div class="name">${escapeHtml(att.filename || "file")}</div>
          <div class="sub">${sub}</div>
        </div>
      </div>`;
    })
    .join("");
  return `<div class="msg-attachments">${chips}</div>`;
}

function appendMessageRow(role, content, attachments) {
  const row = document.createElement("div");
  row.className = `msg-row ${role}`;
  const avatarLabel = role === "user" ? "U" : "✦";
  row.innerHTML = `
    <div class="msg-inner">
      <div class="avatar ${role}">${avatarLabel}</div>
      <div class="msg-content"></div>
    </div>`;
  const contentEl = row.querySelector(".msg-content");

  const chipsHtml = role === "user" ? attachmentChipsHtml(attachments) : "";

  if (role === "assistant") {
    contentEl.innerHTML = renderMarkdown(content);
  } else {
    // Render attachment chips (safe HTML) + escaped text.
    const textHtml = content ? `<div>${escapeHtml(content)}</div>` : "";
    contentEl.innerHTML = chipsHtml + textHtml;
  }
  messagesEl.appendChild(row);
  return contentEl;
}

// ---- Sending / streaming ----
async function sendMessage() {
  const text = inputEl.value.trim();

  // Only send finished (non-loading) attachments.
  const ready = state.pendingAttachments.filter((a) => !a.loading);
  const stillLoading = state.pendingAttachments.some((a) => a.loading);
  if (stillLoading) {
    // Wait for uploads to finish before sending.
    return;
  }

  // Need either text or at least one attachment.
  if ((!text && ready.length === 0) || state.streaming) return;

  let chat = currentChat();
  if (!chat) {
    newChat();
    chat = currentChat();
  }

  // Clear welcome
  if (chat.messages.length === 0) messagesEl.innerHTML = "";

  // Build the user message (with attachments if any)
  const userMsg = { role: "user", content: text };
  if (ready.length) userMsg.attachments = ready;
  chat.messages.push(userMsg);
  appendMessageRow("user", text, ready);

  // Clear pending attachments now that they're attached to the message.
  state.pendingAttachments = [];
  renderPendingAttachments();

  // Title from first message
  if (chat.messages.filter((m) => m.role === "user").length === 1) {
    const t = text || (ready[0] && ready[0].filename) || "New chat";
    chat.title = t.slice(0, 40) + (t.length > 40 ? "…" : "");
    renderChatList();
  }

  inputEl.value = "";
  autoGrow();
  saveState();

  // Prepare assistant placeholder
  const assistantEl = appendMessageRow("assistant", "");
  assistantEl.innerHTML = '<span class="cursor-blink"></span>';
  scrollToBottom();

  setStreaming(true);
  let acc = "";

  try {
    state.abortCtrl = new AbortController();
    const res = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: state.abortCtrl.signal,
      body: JSON.stringify({
        messages: chat.messages,
        model: state.model,
        temperature: state.settings.temperature,
        max_tokens: state.settings.maxTokens || null,
        system_prompt: state.settings.systemPrompt || null,
        stream: true,
      }),
    });

    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop(); // keep incomplete

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        if (data.token) {
          acc += data.token;
          assistantEl.innerHTML =
            renderMarkdown(acc) + '<span class="cursor-blink"></span>';
          scrollToBottom();
        } else if (data.error) {
          throw new Error(data.error);
        } else if (data.done) {
          // finished
        }
      }
    }

    assistantEl.innerHTML = renderMarkdown(acc);
    chat.messages.push({ role: "assistant", content: acc });
    saveState();
  } catch (err) {
    if (err.name === "AbortError") {
      assistantEl.innerHTML =
        renderMarkdown(acc) + '<div class="error-msg">⏹ Stopped.</div>';
      if (acc) chat.messages.push({ role: "assistant", content: acc });
    } else {
      assistantEl.innerHTML = `<div class="error-msg">⚠️ ${escapeHtml(
        err.message
      )}</div>`;
    }
    saveState();
  } finally {
    setStreaming(false);
    state.abortCtrl = null;
  }
}

function stopStreaming() {
  if (state.abortCtrl) state.abortCtrl.abort();
}

function setStreaming(on) {
  state.streaming = on;
  sendBtn.classList.toggle("hidden", on);
  stopBtn.classList.toggle("hidden", !on);
  inputEl.disabled = on;
}

// ---- Input auto-grow ----
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}

// ---- Models ----
async function loadModels() {
  // Show a loading placeholder while we fetch the live list from the proxy.
  modelSelect.innerHTML = "";
  const loadingOpt = document.createElement("option");
  loadingOpt.textContent = "Loading models…";
  loadingOpt.disabled = true;
  modelSelect.appendChild(loadingOpt);
  modelSelect.disabled = true;

  try {
    const res = await fetch(`${API}/models`);
    const data = await res.json();

    modelSelect.innerHTML = "";
    const availableIds = [];
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      modelSelect.appendChild(opt);
      availableIds.push(m.id);
    }

    // Keep the user's previously selected model if it's still offered by the
    // proxy; otherwise fall back to the server-provided default.
    if (!state.model || !availableIds.includes(state.model)) {
      state.model = data.default;
    }
    modelSelect.value = state.model;
    modelSelect.disabled = false;
    saveState();

    // Surface where the list came from (helps diagnose proxy issues).
    const count = availableIds.length;
    modelSelect.title =
      data.source === "proxy"
        ? `${count} model(s) from proxy`
        : `${count} model(s) (proxy unavailable — using configured fallback list)`;
  } catch (e) {
    console.warn("Failed to load models", e);
    modelSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.textContent = "⚠️ Could not load models";
    opt.disabled = true;
    modelSelect.appendChild(opt);
    modelSelect.disabled = false;
  }
}

// ---- Attachments ----
function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function iconFor(att) {
  if (att.type === "image") return "🖼️";
  if (att.type === "unsupported") return "⚠️";
  const n = (att.filename || "").toLowerCase();
  if (n.endsWith(".pdf")) return "📕";
  if (n.endsWith(".docx")) return "📘";
  if (n.endsWith(".xlsx") || n.endsWith(".csv")) return "📊";
  return "📄";
}

function renderPendingAttachments() {
  attachmentsEl.innerHTML = "";
  if (state.pendingAttachments.length === 0) {
    attachmentsEl.classList.add("hidden");
    return;
  }
  attachmentsEl.classList.remove("hidden");
  state.pendingAttachments.forEach((att, idx) => {
    const chip = document.createElement("div");
    chip.className =
      "attach-chip" +
      (att.type === "unsupported" ? " error" : "") +
      (att.loading ? " loading" : "");
    const sub = att.loading
      ? "Reading…"
      : att.type === "unsupported"
      ? att.reason || "Unsupported"
      : fmtSize(att.size || 0);
    const thumb =
      att.type === "image" && att.data_url
        ? `<img class="thumb" src="${att.data_url}" alt="" />`
        : `<span class="ic">${iconFor(att)}</span>`;
    chip.innerHTML = `
      ${thumb}
      <div class="meta">
        <div class="name">${escapeHtml(att.filename)}</div>
        <div class="sub">${escapeHtml(sub)}</div>
      </div>
      <button class="rm" title="Remove">✕</button>`;
    chip.querySelector(".rm").onclick = () => {
      state.pendingAttachments.splice(idx, 1);
      renderPendingAttachments();
    };
    attachmentsEl.appendChild(chip);
  });
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      state.pendingAttachments.push({
        type: "unsupported",
        filename: file.name,
        reason: `Too large (${fmtSize(file.size)} > 100 MB)`,
      });
      renderPendingAttachments();
      continue;
    }

    // Placeholder while uploading
    const placeholder = { type: "text", filename: file.name, loading: true, size: file.size };
    state.pendingAttachments.push(placeholder);
    renderPendingAttachments();

    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/upload`, { method: "POST", body: fd });
      if (!res.ok) {
        let detail = `Upload failed (${res.status})`;
        try {
          const j = await res.json();
          detail = j.detail || detail;
        } catch {}
        throw new Error(detail);
      }
      const result = await res.json();
      const i = state.pendingAttachments.indexOf(placeholder);
      if (i !== -1) state.pendingAttachments[i] = result;
    } catch (err) {
      const i = state.pendingAttachments.indexOf(placeholder);
      const errAtt = {
        type: "unsupported",
        filename: file.name,
        reason: err.message,
      };
      if (i !== -1) state.pendingAttachments[i] = errAtt;
      else state.pendingAttachments.push(errAtt);
    }
    renderPendingAttachments();
  }
}

// ---- Settings ----
function openSettings() {
  $("systemPrompt").value = state.settings.systemPrompt || "";
  const hasTemp = state.settings.temperature !== null && state.settings.temperature !== undefined;
  $("tempEnabled").checked = hasTemp;
  $("temperature").value = hasTemp ? state.settings.temperature : 0.7;
  $("temperature").disabled = !hasTemp;
  $("tempValue").textContent = hasTemp ? state.settings.temperature : "model default";
  $("maxTokens").value = state.settings.maxTokens || "";
  $("settingsModal").classList.remove("hidden");
}

function saveSettings() {
  state.settings.systemPrompt = $("systemPrompt").value.trim();
  state.settings.temperature = $("tempEnabled").checked
    ? parseFloat($("temperature").value)
    : null;
  const mt = parseInt($("maxTokens").value, 10);
  state.settings.maxTokens = Number.isFinite(mt) ? mt : null;
  saveState();
  $("settingsModal").classList.add("hidden");
}

// ---- Event wiring ----
function init() {
  loadState();
  loadModels();

  if (!state.currentId || !state.chats[state.currentId]) {
    if (Object.keys(state.chats).length) {
      state.currentId = Object.keys(state.chats)[0];
    } else {
      newChat();
    }
  }
  renderChatList();
  renderMessages();

  // Send / stop
  sendBtn.onclick = sendMessage;
  stopBtn.onclick = stopStreaming;

  // Enter to send, Shift+Enter for newline
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  inputEl.addEventListener("input", autoGrow);

  // New chat / clear all
  $("newChatBtn").onclick = newChat;
  $("clearAllBtn").onclick = clearAllChats;

  // Model select
  modelSelect.onchange = () => {
    state.model = modelSelect.value;
    saveState();
  };

  // Refresh model list from the proxy on demand
  $("refreshModelsBtn").onclick = () => loadModels();

  // Attachments: click 📎 to open the picker; handle chosen files.
  attachBtn.onclick = () => fileInput.click();
  fileInput.addEventListener("change", (e) => {
    handleFiles(e.target.files);
    fileInput.value = ""; // allow re-selecting the same file
  });

  // Drag & drop files onto the composer
  const composerInner = document.querySelector(".composer-inner");
  ["dragover", "dragenter"].forEach((ev) =>
    composerInner.addEventListener(ev, (e) => {
      e.preventDefault();
      composerInner.style.opacity = "0.85";
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    composerInner.addEventListener(ev, (e) => {
      e.preventDefault();
      composerInner.style.opacity = "1";
    })
  );
  composerInner.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });

  // Sidebar toggle (mobile)
  $("hamburger").onclick = () => $("sidebar").classList.toggle("collapsed");

  // Settings modal
  $("settingsBtn").onclick = openSettings;
  $("closeSettings").onclick = () => $("settingsModal").classList.add("hidden");
  $("saveSettings").onclick = saveSettings;
  $("temperature").addEventListener("input", (e) => {
    $("tempValue").textContent = e.target.value;
  });
  $("tempEnabled").addEventListener("change", (e) => {
    const on = e.target.checked;
    $("temperature").disabled = !on;
    $("tempValue").textContent = on ? $("temperature").value : "model default";
  });
  $("settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") e.target.classList.add("hidden");
  });

  // Welcome suggestions (initial render)
  document.querySelectorAll(".suggestion").forEach((btn) => {
    btn.onclick = () => {
      inputEl.value = btn.textContent;
      sendMessage();
    };
  });
}

document.addEventListener("DOMContentLoaded", init);
