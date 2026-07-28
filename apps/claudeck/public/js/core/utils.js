// Pure utility functions

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function getToolDetail(name, input) {
  if (!input) return "";
  if (input.file_path) return escapeHtml(input.file_path);
  if (input.command) return escapeHtml(input.command.slice(0, 80));
  if (input.pattern) return escapeHtml(input.pattern);
  if (input.query) return escapeHtml(input.query);
  if (input.prompt) return escapeHtml(input.prompt.slice(0, 80));
  return "";
}

// Distance from bottom (px) within which we still consider the user "at bottom".
// Absorbs sub-pixel rounding, momentum scrolling, and small layout shifts.
export const NEAR_BOTTOM_THRESHOLD = 100;

export function isNearBottom(el) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
}

// Stick-to-bottom: only scrolls if the user is already near the bottom, or
// if `force` is set (e.g. user sent a message). When new content arrives
// while the user has scrolled up, we set `pane.hasNewBelow = true` so the
// "Jump to latest" pill can surface, and we leave their scroll position alone.
export function scrollToBottom(pane, opts = {}) {
  if (!pane || !pane.messagesDiv) return;
  const el = pane.messagesDiv;
  if (opts.force) {
    el.scrollTop = el.scrollHeight;
    pane.followBottom = true;
    pane.hasNewBelow = false;
    notifyPillUpdate(pane);
    return;
  }
  if (pane.followBottom !== false && isNearBottom(el)) {
    el.scrollTop = el.scrollHeight;
    pane.followBottom = true;
    pane.hasNewBelow = false;
  } else {
    pane.hasNewBelow = true;
  }
  notifyPillUpdate(pane);
}

function notifyPillUpdate(pane) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("claudeck:scroll-state", {
    detail: { chatId: pane.chatId, hasNewBelow: !!pane.hasNewBelow },
  }));
}
