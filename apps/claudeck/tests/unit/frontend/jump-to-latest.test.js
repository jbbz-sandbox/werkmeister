// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";

beforeEach(async () => {
  const el = document.createElement("claudeck-jump-to-latest");
  document.body.appendChild(el);
  await import("../../../public/js/components/jump-to-latest.js");
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("claudeck-jump-to-latest", () => {
  it("renders the pill button hidden by default", () => {
    const btn = document.getElementById("jump-to-latest-btn");
    expect(btn).not.toBeNull();
    expect(btn.classList.contains("hidden")).toBe(true);
    expect(btn.textContent).toContain("New messages");
  });

  it("shows the pill on claudeck:scroll-state with hasNewBelow=true (single pane)", () => {
    const btn = document.getElementById("jump-to-latest-btn");
    window.dispatchEvent(new CustomEvent("claudeck:scroll-state", {
      detail: { chatId: null, hasNewBelow: true },
    }));
    expect(btn.classList.contains("hidden")).toBe(false);
  });

  it("hides the pill on claudeck:scroll-state with hasNewBelow=false", () => {
    const btn = document.getElementById("jump-to-latest-btn");
    // Show first
    window.dispatchEvent(new CustomEvent("claudeck:scroll-state", {
      detail: { chatId: null, hasNewBelow: true },
    }));
    expect(btn.classList.contains("hidden")).toBe(false);
    // Then hide
    window.dispatchEvent(new CustomEvent("claudeck:scroll-state", {
      detail: { chatId: null, hasNewBelow: false },
    }));
    expect(btn.classList.contains("hidden")).toBe(true);
  });

  it("ignores events for non-null chatId (parallel-mode panes manage themselves)", () => {
    const btn = document.getElementById("jump-to-latest-btn");
    window.dispatchEvent(new CustomEvent("claudeck:scroll-state", {
      detail: { chatId: "chat-1", hasNewBelow: true },
    }));
    expect(btn.classList.contains("hidden")).toBe(true);
  });
});
