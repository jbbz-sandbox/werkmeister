// Project selection & system prompts
import { $ } from '../core/dom.js';
import { getState, setState } from '../core/store.js';
import { CHAT_IDS } from '../core/constants.js';
import * as api from '../core/api.js';
import { commandRegistry, registerCommand } from '../ui/commands.js';
import { panes } from '../ui/parallel.js';
import { loadSessions } from './sessions.js';
import { loadStats } from './cost-dashboard.js';
import { showWhalyPlaceholder, addSkillUsedMessage } from '../ui/messages.js';
import { updateAttachmentBadge, clearImageAttachments } from './attachments.js';

export async function loadProjects() {
  try {
    const projects = await api.fetchProjects();
    setState("projectsData", projects);
    const saved = localStorage.getItem("claudeck-cwd") || "";

    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p.path;
      opt.textContent = p.name;
      $.projectSelect.appendChild(opt);
    }

    if (saved && [...$.projectSelect.options].some((o) => o.value === saved)) {
      $.projectSelect.value = saved;
    }
    updateSystemPromptIndicator();
    updateHeaderProjectName();
    updateSessionControls();
    loadProjectCommands();
    // Load sessions after project dropdown is populated so they filter correctly
    loadSessions();

    // If a session was restored from localStorage, load its messages
    const { getState } = await import('../core/store.js');
    const { loadMessages } = await import('./sessions.js');
    const restoredSid = getState("sessionId");
    if (restoredSid) {
      loadMessages(restoredSid);
    }
  } catch (err) {
    console.error("Failed to load projects:", err);
  }
}

const sessionControls = document.getElementById("session-controls");

function updateSessionControls() {
  if ($.projectSelect.value) {
    sessionControls.classList.remove("hidden");
  } else {
    sessionControls.classList.add("hidden");
  }
}

export function updateSystemPromptIndicator() {
  const cwd = $.projectSelect.value;
  const project = getState("projectsData").find((p) => p.path === cwd);
  if (project && project.systemPrompt) {
    $.spBadge.classList.remove("hidden");
  } else {
    $.spBadge.classList.add("hidden");
  }
}

export function openSystemPromptModal() {
  const cwd = $.projectSelect.value;
  if (!cwd) return;
  const project = getState("projectsData").find((p) => p.path === cwd);
  $.spTextarea.value = project?.systemPrompt || "";
  $.spModal.classList.remove("hidden");
  $.spTextarea.focus();
}

export async function saveSystemPrompt(prompt) {
  const cwd = $.projectSelect.value;
  if (!cwd) return;
  try {
    await api.saveSystemPromptApi(cwd, prompt);
    const project = getState("projectsData").find((p) => p.path === cwd);
    if (project) project.systemPrompt = prompt;
    updateSystemPromptIndicator();
  } catch (err) {
    console.error("Failed to save system prompt:", err);
  }
}

export function updateHeaderProjectName() {
  const opt = $.projectSelect.options[$.projectSelect.selectedIndex];
  $.headerProjectName.textContent = opt && opt.value ? opt.textContent : "";
}

// Skill lookup map — exported so chat.js can look up model-invoked skills
export const skillLookup = new Map();

export async function loadProjectCommands() {
  // Remove old project commands and skills
  for (const [name, cmd] of Object.entries(commandRegistry)) {
    if (cmd.category === "project" || cmd.category === "skill") delete commandRegistry[name];
  }
  skillLookup.clear();

  const cwd = $.projectSelect.value;
  if (!cwd) return;

  try {
    const commands = await api.fetchProjectCommands(cwd);
    if (!Array.isArray(commands) || commands.length === 0) return;

    for (const c of commands) {
      const slug = c.command;
      if (!slug || commandRegistry[slug]) continue;
      const hasArgs = c.prompt.includes("$ARGUMENTS");
      const label = c.source === "skill" ? `${c.description}` : (c.description || c.command);

      // Build skill lookup map
      if (c.source === "skill") {
        skillLookup.set(slug, { description: label, scope: "project" });
      }

      registerCommand(slug, {
        category: c.source === "skill" ? "skill" : "project",
        description: label,
        needsArgs: hasArgs,
        argumentHint: c.argumentHint || "",
        execute(args, pane) {
          // Show "Skill used" message for skills
          if (c.source === "skill") {
            addSkillUsedMessage(slug, c.description, pane);
          }

          let prompt = c.prompt;
          if (hasArgs) {
            prompt = prompt.replace(/\$ARGUMENTS/g, args || "");
          }
          pane.messageInput.value = prompt;
          pane.messageInput.style.height = "auto";
          pane.messageInput.style.height = Math.min(pane.messageInput.scrollHeight, 200) + "px";
          // Lazy import to avoid circular dep
          import('./chat.js').then(({ sendMessage }) => sendMessage(pane));
        },
      });
    }
  } catch (err) {
    console.error("Failed to load project commands:", err);
  }
}

// ── Add Project (folder browser) ────────────────────────
let currentBrowsePath = "";

const RECENTS_KEY = "claudeck-folder-recents";
const RECENTS_MAX = 5;

function loadRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(path) {
  if (!path) return;
  const existing = loadRecents().filter((p) => p !== path);
  existing.unshift(path);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(existing.slice(0, RECENTS_MAX)));
}

function renderRecents() {
  const recents = loadRecents();
  $.folderRecents.innerHTML = "";
  if (recents.length === 0) {
    $.folderRecents.classList.add("hidden");
    return;
  }
  $.folderRecents.classList.remove("hidden");
  const label = document.createElement("span");
  label.className = "folder-recents-label";
  label.textContent = "Recent:";
  $.folderRecents.appendChild(label);
  for (const p of recents) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "folder-recent-chip";
    chip.title = p;
    chip.textContent = p.split(/[/\\]/).filter(Boolean).pop() || p;
    chip.addEventListener("click", () => navigateToDir(p));
    $.folderRecents.appendChild(chip);
  }
}

function showMessage(text, kind = "error", action) {
  if (!text) {
    hideMessage();
    return;
  }
  $.addProjectMessage.innerHTML = "";
  $.addProjectMessage.className = `add-project-message add-project-message-${kind}`;
  const span = document.createElement("span");
  span.textContent = text;
  $.addProjectMessage.appendChild(span);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add-project-message-action";
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    $.addProjectMessage.appendChild(btn);
  }
}

function hideMessage() {
  $.addProjectMessage.className = "add-project-message hidden";
  $.addProjectMessage.innerHTML = "";
}

function openAddProjectModal() {
  $.addProjectModal.classList.remove("hidden");
  $.addProjectName.value = "";
  $.folderPathInput.value = "";
  hideMessage();
  hideNewFolderRow();
  renderRecents();
  navigateToDir(""); // defaults to $HOME on server
}

function closeAddProjectModal() {
  $.addProjectModal.classList.add("hidden");
}

async function navigateToDir(dir) {
  $.folderList.innerHTML = '<div class="folder-list-loading">Loading...</div>';
  hideMessage();
  hideNewFolderRow();
  try {
    const data = await api.browseFolders(dir || undefined);
    currentBrowsePath = data.current;
    renderBreadcrumb(data.current);
    renderFolderList(data);
    // Auto-fill name from last segment
    const base = data.current.split(/[/\\]/).filter(Boolean).pop() || "";
    $.addProjectName.value = base;
    $.folderPathInput.value = data.current;
  } catch (err) {
    $.folderList.innerHTML = `<div class="folder-list-empty">Error: ${err.message}</div>`;
  }
}

function showNewFolderRow() {
  $.folderNewRow.classList.remove("hidden");
  $.folderNewToggleRow.classList.add("hidden");
  $.folderNewName.value = "";
  $.folderNewName.focus();
}

function hideNewFolderRow() {
  $.folderNewRow.classList.add("hidden");
  $.folderNewToggleRow.classList.remove("hidden");
}

async function createFolderInline() {
  const name = $.folderNewName.value.trim();
  if (!name) {
    $.folderNewName.focus();
    return;
  }
  if (/[\/\\]/.test(name) || name === "." || name === "..") {
    showMessage("Folder name cannot contain '/', '\\', or be '.' / '..'", "error");
    return;
  }
  if (!currentBrowsePath) return;

  try {
    const result = await api.createFolder(currentBrowsePath, name);
    hideNewFolderRow();
    await navigateToDir(result.path);
    showMessage(`Created "${name}". Click Add to use it as a project.`, "success");
  } catch (err) {
    if (err.status === 409) {
      showMessage(`"${name}" already exists here.`, "error", {
        label: "Open it",
        onClick: async () => {
          const target = currentBrowsePath.replace(/\/$/, "") + "/" + name;
          hideNewFolderRow();
          await navigateToDir(target);
        },
      });
    } else {
      showMessage(err.message || "Failed to create folder", "error");
    }
  }
}

async function goToTypedPath() {
  const raw = $.folderPathInput.value.trim();
  if (!raw) return;
  // Expand leading ~ to $HOME on the server side — client just passes it along;
  // the server resolves. But browse route uses resolve() which does not expand ~.
  // So expand here against a best-effort guess: leave ~ as-is and let the user
  // type absolute paths, OR expand client-side using a hardcoded "~" marker.
  // Simpler: if the user types "~", ask the server to browse default (homedir)
  // and then append the rest.
  let target = raw;
  if (raw === "~") {
    await navigateToDir(""); // defaults to $HOME on server
    return;
  }
  if (raw.startsWith("~/")) {
    // Browse home first to learn its absolute path, then descend.
    try {
      const home = await api.browseFolders(undefined);
      target = home.current.replace(/\/$/, "") + "/" + raw.slice(2);
    } catch {
      showMessage("Could not resolve ~", "error");
      return;
    }
  }
  await navigateToDir(target);
}

function renderBreadcrumb(pathStr) {
  $.folderBreadcrumb.innerHTML = "";
  const parts = pathStr.split(/[/\\]/).filter(Boolean);
  // Root
  const rootSeg = document.createElement("span");
  rootSeg.className = "folder-breadcrumb-seg";
  rootSeg.textContent = "/";
  rootSeg.addEventListener("click", () => navigateToDir("/"));
  $.folderBreadcrumb.appendChild(rootSeg);

  let accumulated = "";
  for (const part of parts) {
    accumulated += "/" + part;
    const sep = document.createElement("span");
    sep.className = "folder-breadcrumb-sep";
    sep.textContent = "/";
    $.folderBreadcrumb.appendChild(sep);

    const seg = document.createElement("span");
    seg.className = "folder-breadcrumb-seg";
    seg.textContent = part;
    const target = accumulated;
    seg.addEventListener("click", () => navigateToDir(target));
    $.folderBreadcrumb.appendChild(seg);
  }
}

function renderFolderList(data) {
  $.folderList.innerHTML = "";

  // Parent directory entry
  if (data.parent) {
    const parentItem = document.createElement("div");
    parentItem.className = "folder-list-item";
    parentItem.innerHTML = '<span class="folder-icon">..</span><span>Parent directory</span>';
    parentItem.addEventListener("click", () => navigateToDir(data.parent));
    $.folderList.appendChild(parentItem);
  }

  if (data.dirs.length === 0 && !data.parent) {
    $.folderList.innerHTML = '<div class="folder-list-empty">No subdirectories</div>';
    return;
  }

  if (data.dirs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "folder-list-empty";
    empty.textContent = "No subdirectories";
    $.folderList.appendChild(empty);
    return;
  }

  for (const dir of data.dirs) {
    const item = document.createElement("div");
    item.className = "folder-list-item";
    item.innerHTML = `<span class="folder-icon">\u{1F4C1}</span><span>${dir.name}</span>`;
    item.addEventListener("click", () => navigateToDir(dir.path));
    $.folderList.appendChild(item);
  }
}

function selectExistingProject(path) {
  if (![...$.projectSelect.options].some((o) => o.value === path)) return false;
  $.projectSelect.value = path;
  $.projectSelect.dispatchEvent(new Event("change"));
  closeAddProjectModal();
  return true;
}

async function confirmAddProject() {
  const name = $.addProjectName.value.trim();
  if (!name) {
    showMessage("Enter a project name.", "error");
    $.addProjectName.focus();
    return;
  }
  if (!currentBrowsePath) return;

  // Check for duplicate in dropdown — offer to switch instead of blocking.
  const existing = [...$.projectSelect.options].find((o) => o.value === currentBrowsePath);
  if (existing) {
    showMessage("This folder is already added as a project.", "error", {
      label: "Switch to it",
      onClick: () => selectExistingProject(currentBrowsePath),
    });
    return;
  }

  try {
    const result = await api.addProject(name, currentBrowsePath);
    const project = result.project;

    // Add to dropdown and select it
    const opt = document.createElement("option");
    opt.value = project.path;
    opt.textContent = project.name;
    $.projectSelect.appendChild(opt);
    $.projectSelect.value = project.path;

    // Update state
    const projects = getState("projectsData");
    projects.push({ name: project.name, path: project.path });

    localStorage.setItem("claudeck-cwd", project.path);
    pushRecent(project.path);
    updateSystemPromptIndicator();
    updateHeaderProjectName();
    updateSessionControls();
    loadProjectCommands();
    loadSessions();
    loadStats();

    closeAddProjectModal();
  } catch (err) {
    showMessage("Failed to add project: " + err.message, "error");
  }
}

// Open in VS Code
$.openVscodeBtn.addEventListener("click", async () => {
  const path = $.projectSelect.value;
  if (!path) return;
  try {
    await fetch("/api/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "code .", cwd: path }),
    });
  } catch { /* ignore */ }
});

// Remove project
$.removeProjectBtn.addEventListener("click", async () => {
  const path = $.projectSelect.value;
  if (!path) return;
  const name = $.projectSelect.options[$.projectSelect.selectedIndex].textContent;
  if (!confirm(`Remove "${name}" from your projects?\n\nThis only removes it from Claudeck — your files won't be deleted.`)) return;
  try {
    await api.deleteProject(path);
    // Remove from dropdown
    const opt = [...$.projectSelect.options].find(o => o.value === path);
    if (opt) opt.remove();
    // Remove from state
    const projects = getState("projectsData");
    const idx = projects.findIndex(p => p.path === path);
    if (idx !== -1) projects.splice(idx, 1);
    // Reset selection
    $.projectSelect.value = "";
    localStorage.removeItem("claudeck-cwd");
    updateSystemPromptIndicator();
    updateHeaderProjectName();
    updateSessionControls();
    loadProjectCommands();
    $.messagesDiv.innerHTML = "";
    showWhalyPlaceholder();
    loadSessions();
  } catch (err) {
    alert("Failed to remove project: " + err.message);
  }
});

// Add project button & modal event listeners
$.addProjectBtn.addEventListener("click", openAddProjectModal);
$.addProjectClose.addEventListener("click", closeAddProjectModal);
$.addProjectConfirm.addEventListener("click", confirmAddProject);
$.addProjectModal.addEventListener("click", (e) => {
  if (e.target === $.addProjectModal) closeAddProjectModal();
});

// ── Add Project modal: Open Folder / Create Workspace tabs ──────────────────
let createFormLoaded = false;
const apTabFolder = document.getElementById("ap-tab-folder");
const apTabCreate = document.getElementById("ap-tab-create");
const apPanelFolder = document.getElementById("ap-panel-folder");
const apPanelCreate = document.getElementById("ap-panel-create");

function selectAddProjectTab(which) {
  const folder = which === "folder";
  apTabFolder.classList.toggle("active", folder);
  apTabCreate.classList.toggle("active", !folder);
  apPanelFolder.classList.toggle("hidden", !folder);
  apPanelCreate.classList.toggle("hidden", folder);
  if (!folder && !createFormLoaded) {
    createFormLoaded = true;
    loadCreateForm();
  }
}

async function loadCreateForm() {
  try {
    const mod = await import("/plugins/sandbox-workspace/create-form.mjs");
    await mod.renderCreateForm(apPanelCreate, { onCreated: onWorkspaceCreated });
  } catch {
    apPanelCreate.textContent = "Enable the Sandbox Workspace plugin to create workspaces.";
    createFormLoaded = false; // allow a retry on next tab open
  }
}

async function onWorkspaceCreated(path) {
  const name = path.replace(/\/+$/, "").split("/").pop();
  try {
    await api.addProject(name, path);
    await loadProjects();
    $.projectSelect.value = path;
    $.projectSelect.dispatchEvent(new Event("change"));
    closeAddProjectModal();
  } catch (err) {
    console.error("Failed to add created workspace as project:", err);
    // Leave the modal open so the user sees it didn't complete.
  }
}

apTabFolder.addEventListener("click", () => selectAddProjectTab("folder"));
apTabCreate.addEventListener("click", () => selectAddProjectTab("create"));

// Typed path navigation
$.folderPathGo.addEventListener("click", goToTypedPath);
$.folderPathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    goToTypedPath();
  }
});

// New folder inline row
$.folderNewToggle.addEventListener("click", showNewFolderRow);
$.folderNewCancel.addEventListener("click", hideNewFolderRow);
$.folderNewCreate.addEventListener("click", createFolderInline);
$.folderNewName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createFolderInline();
  } else if (e.key === "Escape") {
    hideNewFolderRow();
  }
});

// System prompt modal event listeners
$.spEditBtn.addEventListener("click", openSystemPromptModal);
$.spForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveSystemPrompt($.spTextarea.value.trim());
  $.spModal.classList.add("hidden");
});
document.getElementById("sp-cancel-btn").addEventListener("click", () => {
  $.spModal.classList.add("hidden");
});
document.getElementById("sp-modal-close").addEventListener("click", () => {
  $.spModal.classList.add("hidden");
});
document.getElementById("sp-clear-btn").addEventListener("click", async () => {
  $.spTextarea.value = "";
  await saveSystemPrompt("");
  $.spModal.classList.add("hidden");
});
$.spModal.addEventListener("click", (e) => {
  if (e.target === $.spModal) $.spModal.classList.add("hidden");
});

// Project change handler
$.projectSelect.addEventListener("change", async () => {
  const { guardSwitch } = await import('./background-sessions.js');
  guardSwitch(() => {
    localStorage.setItem("claudeck-cwd", $.projectSelect.value);
    setState("sessionId", null);
    if ($.projectSelect.value) {
      setState("view", "chat");
    }
    // Clear attachments and input on project switch
    setState("attachedFiles", []);
    setState("allProjectFiles", []);
    clearImageAttachments();
    updateAttachmentBadge();
    $.messageInput.value = "";
    updateSystemPromptIndicator();
    updateHeaderProjectName();
    updateSessionControls();
    loadProjectCommands();
    if (getState("parallelMode")) {
      for (const chatId of CHAT_IDS) {
        const pane = panes.get(chatId);
        if (pane) {
          pane.messagesDiv.innerHTML = "";
          showWhalyPlaceholder(pane);
        }
      }
    } else {
      $.messagesDiv.innerHTML = "";
      showWhalyPlaceholder();
    }
    loadSessions();
    loadStats();
  });
});

// New session button
$.newSessionBtn.addEventListener("click", async () => {
  const { guardSwitch } = await import('./background-sessions.js');
  guardSwitch(() => {
    setState("view", "chat");
    setState("sessionId", null);
    if (getState("parallelMode")) {
      for (const chatId of CHAT_IDS) {
        const pane = panes.get(chatId);
        if (pane) {
          pane.messagesDiv.innerHTML = "";
          pane.currentAssistantMsg = null;
          showWhalyPlaceholder(pane);
        }
      }
    } else {
      $.messagesDiv.innerHTML = "";
      showWhalyPlaceholder();
    }
    loadSessions();
    if (!getState("parallelMode")) $.messageInput.focus();
  });
});

// Parallel mode toggle
$.toggleParallelBtn.addEventListener("change", () => {
  if ($.toggleParallelBtn.checked) {
    import('../ui/parallel.js').then(({ enterParallelMode }) => enterParallelMode());
  } else {
    import('../ui/parallel.js').then(({ exitParallelMode }) => exitParallelMode());
  }
});
