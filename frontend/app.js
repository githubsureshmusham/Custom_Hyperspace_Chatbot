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
};

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = $("sendBtn");
const stopBtn = $("stopBtn");
const chatListEl = $("chatList");
const modelSelect = $("modelSelect");

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
    appendMessageRow(msg.role, msg.content);
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

function appendMessageRow(role, content) {
  const row = document.createElement("div");
  row.className = `msg-row ${role}`;
  const avatarLabel = role === "user" ? "U" : "✦";
  row.innerHTML = `
    <div class="msg-inner">
      <div class="avatar ${role}">${avatarLabel}</div>
      <div class="msg-content"></div>
    </div>`;
  const contentEl = row.querySelector(".msg-content");
  if (role === "assistant") {
    contentEl.innerHTML = renderMarkdown(content);
  } else {
    contentEl.textContent = content;
  }
  messagesEl.appendChild(row);
  return contentEl;
}

// ---- Sending / streaming ----
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || state.streaming) return;

  let chat = currentChat();
  if (!chat) {
    newChat();
    chat = currentChat();
  }

  // Clear welcome
  if (chat.messages.length === 0) messagesEl.innerHTML = "";

  // Add user message
  chat.messages.push({ role: "user", content: text });
  appendMessageRow("user", text);

  // Title from first message
  if (chat.messages.filter((m) => m.role === "user").length === 1) {
    chat.title = text.slice(0, 40) + (text.length > 40 ? "…" : "");
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
