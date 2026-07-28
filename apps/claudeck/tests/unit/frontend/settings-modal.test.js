// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { THEMES } from "../../../public/js/ui/theme.js";

// customElements.define throws on a second registration for the same tag, so
// the component is imported once here rather than re-imported per test. Both
// modules are stateless apart from the DOM and localStorage, which beforeEach
// resets, so each test still starts clean.
import "../../../public/js/components/settings-modal.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = "";
});

function mount() {
  // The open handler binds to #settings-btn, which lives in index.html.
  const btn = document.createElement("button");
  btn.id = "settings-btn";
  document.body.appendChild(btn);

  const el = document.createElement("claudeck-settings-modal");
  document.body.appendChild(el);
  return {
    btn,
    overlay: el.querySelector("#settings-modal"),
    closeBtn: el.querySelector("#settings-modal-close"),
    themeSelect: el.querySelector("#setting-theme"),
    botToggle: el.querySelector("#setting-assistant-bot"),
  };
}

describe("settings modal", () => {
  describe("theme picker", () => {
    it("renders one option per registered theme, in registry order", () => {
      const { themeSelect } = mount();
      expect([...themeSelect.options].map((o) => o.value)).toEqual(THEMES.map((t) => t.id));
      expect([...themeSelect.options].map((o) => o.textContent.trim()))
        .toEqual(THEMES.map((t) => t.label));
    });

    it("preselects the theme that is currently applied", () => {
      document.documentElement.dataset.theme = "nord";
      const { themeSelect } = mount();
      expect(themeSelect.value).toBe("nord");
    });

    it("falls back to the first theme when nothing is applied yet", () => {
      const { themeSelect } = mount();
      expect(themeSelect.value).toBe(THEMES[0].id);
    });

    it("applies and persists the theme when the select changes", () => {
      const { themeSelect } = mount();
      themeSelect.value = "flatly";
      themeSelect.dispatchEvent(new Event("change"));

      expect(document.documentElement.getAttribute("data-theme")).toBe("flatly");
      expect(localStorage.getItem("claudeck-theme")).toBe("flatly");
    });

    it("re-reads the active theme each time the modal is opened", () => {
      const { btn, themeSelect } = mount();
      // Something outside the modal changed the theme after it was built.
      document.documentElement.dataset.theme = "darkly";
      btn.click();
      expect(themeSelect.value).toBe("darkly");
    });
  });

  describe("existing behaviour", () => {
    it("opens on the settings button and closes on the close button", () => {
      const { btn, overlay, closeBtn } = mount();
      expect(overlay.classList.contains("hidden")).toBe(true);

      btn.click();
      expect(overlay.classList.contains("hidden")).toBe(false);

      closeBtn.click();
      expect(overlay.classList.contains("hidden")).toBe(true);
    });

    it("persists the assistant bot toggle", () => {
      const { botToggle } = mount();
      botToggle.checked = false;
      botToggle.dispatchEvent(new Event("change"));
      expect(JSON.parse(localStorage.getItem("claudeck-settings")).assistantBot).toBe(false);
    });
  });
});
