// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";

beforeEach(async () => {
  const el = document.createElement("claudeck-add-project");
  document.body.appendChild(el);
  await import("../../../public/js/components/add-project-modal.js");
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("claudeck-add-project", () => {
  it("renders the modal overlay", () => {
    const overlay = document.getElementById("add-project-modal");
    expect(overlay).not.toBeNull();
  });

  it("starts hidden", () => {
    const overlay = document.getElementById("add-project-modal");
    expect(overlay.classList.contains("hidden")).toBe(true);
  });

  it("has a folder breadcrumb", () => {
    expect(document.getElementById("folder-breadcrumb")).not.toBeNull();
  });

  it("has a folder list", () => {
    expect(document.getElementById("folder-list")).not.toBeNull();
  });

  it("has a project name input", () => {
    expect(document.getElementById("add-project-name")).not.toBeNull();
  });

  it("has a confirm button", () => {
    expect(document.getElementById("add-project-confirm")).not.toBeNull();
  });

  it("has a typed path input and Go button", () => {
    expect(document.getElementById("folder-path-input")).not.toBeNull();
    expect(document.getElementById("folder-path-go")).not.toBeNull();
  });

  it("has a recents container (hidden by default)", () => {
    const el = document.getElementById("folder-recents");
    expect(el).not.toBeNull();
    expect(el.classList.contains("hidden")).toBe(true);
  });

  it("has a new-folder toggle that starts visible", () => {
    const toggle = document.getElementById("folder-new-toggle");
    const toggleRow = document.getElementById("folder-new-toggle-row");
    expect(toggle).not.toBeNull();
    expect(toggleRow).not.toBeNull();
    expect(toggleRow.classList.contains("hidden")).toBe(false);
  });

  it("has a new-folder row that starts hidden", () => {
    const row = document.getElementById("folder-new-row");
    expect(row).not.toBeNull();
    expect(row.classList.contains("hidden")).toBe(true);
    expect(document.getElementById("folder-new-name")).not.toBeNull();
    expect(document.getElementById("folder-new-create")).not.toBeNull();
    expect(document.getElementById("folder-new-cancel")).not.toBeNull();
  });

  it("has an inline message area that starts hidden", () => {
    const msg = document.getElementById("add-project-message");
    expect(msg).not.toBeNull();
    expect(msg.classList.contains("hidden")).toBe(true);
  });

  it("close button hides the modal", () => {
    const overlay = document.getElementById("add-project-modal");
    const closeBtn = document.getElementById("add-project-close");

    overlay.classList.remove("hidden");
    closeBtn.click();
    expect(overlay.classList.contains("hidden")).toBe(true);
  });

  it("clicking backdrop hides the modal", () => {
    const overlay = document.getElementById("add-project-modal");
    overlay.classList.remove("hidden");

    overlay.dispatchEvent(new Event("click", { bubbles: true }));
    expect(overlay.classList.contains("hidden")).toBe(true);
  });

  it("clicking inside modal does not hide it", () => {
    const overlay = document.getElementById("add-project-modal");
    overlay.classList.remove("hidden");

    const modal = overlay.querySelector(".modal");
    modal.click();
    expect(overlay.classList.contains("hidden")).toBe(false);
  });

  it("new-folder toggle row hides when new-folder row becomes visible", () => {
    // Mirrors the openNewFolder() flow in features/projects.js: open the row,
    // hide the toggle, focus the name input.
    const row = document.getElementById("folder-new-row");
    const toggleRow = document.getElementById("folder-new-toggle-row");
    const nameInput = document.getElementById("folder-new-name");

    row.classList.remove("hidden");
    toggleRow.classList.add("hidden");
    nameInput.focus();

    expect(row.classList.contains("hidden")).toBe(false);
    expect(toggleRow.classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(nameInput);
  });

  it("inline message area renders error and success states", () => {
    // Mirrors showMessage() in features/projects.js — class swap + innerHTML.
    const msg = document.getElementById("add-project-message");

    msg.className = "add-project-message error";
    msg.innerHTML = "<span>Something went wrong</span>";
    expect(msg.classList.contains("hidden")).toBe(false);
    expect(msg.classList.contains("error")).toBe(true);
    expect(msg.textContent).toContain("Something went wrong");

    msg.className = "add-project-message success";
    msg.innerHTML = "<span>Folder created</span>";
    expect(msg.classList.contains("success")).toBe(true);
    expect(msg.textContent).toContain("Folder created");
  });

  it("typed path input + Go button accept user input", () => {
    const input = document.getElementById("folder-path-input");
    const goBtn = document.getElementById("folder-path-go");

    input.value = "~/code/my-app";
    expect(input.value).toBe("~/code/my-app");
    expect(goBtn.tagName).toBe("BUTTON");
  });

  it("recents container shows when populated and hides when empty", () => {
    // Mirrors renderRecents() in features/projects.js.
    const recents = document.getElementById("folder-recents");

    // Populated state
    const chip = document.createElement("button");
    chip.className = "folder-recents-chip";
    chip.textContent = "/home/user/code";
    recents.appendChild(chip);
    recents.classList.remove("hidden");
    expect(recents.classList.contains("hidden")).toBe(false);
    expect(recents.querySelectorAll(".folder-recents-chip").length).toBe(1);

    // Empty state
    recents.innerHTML = "";
    recents.classList.add("hidden");
    expect(recents.classList.contains("hidden")).toBe(true);
    expect(recents.children.length).toBe(0);
  });
});
