class AddProjectModal extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
  <div id="add-project-modal" class="modal-overlay hidden">
    <div class="modal add-project-modal">
      <style>
        .ap-tabs { display: flex; gap: 4px; padding: 0 12px; border-bottom: 1px solid var(--border); }
        .ap-tab { background: none; border: none; color: var(--text-secondary); font: inherit;
          padding: 8px 12px; cursor: pointer; border-bottom: 2px solid transparent; }
        .ap-tab.active { color: var(--text); border-bottom-color: var(--accent); }
        .ap-panel.hidden { display: none; }
        .sw-cf-form { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
        .sw-cf-row { display: flex; flex-direction: column; gap: 4px; }
        .sw-cf-label { font-size: 12px; font-weight: 600; }
        .sw-cf-desc { font-size: 11px; color: var(--text-dim); }
        .sw-cf-input { background: var(--bg); color: var(--text); border: 1px solid var(--border-strong);
          border-radius: var(--radius); padding: 6px 8px; font: inherit; }
        .sw-cf-input:invalid { border-color: var(--error); }
        .sw-cf-checks { display: flex; flex-wrap: wrap; gap: 10px; }
        .sw-cf-check { display: flex; align-items: center; gap: 4px; font-size: 12px; }
        .sw-cf-inline, .sw-cf-refine { display: flex; gap: 6px; align-items: flex-start; }
        .sw-cf-inline .sw-cf-input, .sw-cf-refine .sw-cf-input { flex: 1; }
        .sw-cf-side-btn { white-space: nowrap; background: var(--bg-tertiary); color: var(--text);
          border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px; cursor: pointer; }
        .sw-cf-side-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .sw-cf-create { background: var(--accent-solid); color: var(--on-accent); border: none;
          border-radius: var(--radius); padding: 8px; font-weight: 600; cursor: pointer; }
        .sw-cf-create:disabled { opacity: 0.6; cursor: not-allowed; }
        .sw-cf-output { background: var(--bg-deep); border: 1px solid var(--border); border-radius: var(--radius);
          padding: 8px; font-size: 11px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; margin: 0; }
        .sw-cf-loading, .sw-cf-error { padding: 16px; color: var(--text-dim); font-size: 12px; }
        .hidden { display: none; }
      </style>
      <div class="modal-header">
        <h3>Add Project</h3>
        <button id="add-project-close" class="modal-close">&times;</button>
      </div>
      <div class="ap-tabs">
        <button id="ap-tab-folder" class="ap-tab active" type="button">Open Folder</button>
        <button id="ap-tab-create" class="ap-tab" type="button">Create Workspace</button>
      </div>
      <div id="ap-panel-folder" class="ap-panel add-project-body">
        <div class="folder-path-row">
          <input id="folder-path-input" type="text" placeholder="Type a path (e.g. ~/code/my-app) and press Enter" autocomplete="off" spellcheck="false">
          <button id="folder-path-go" class="folder-path-go" title="Go to path">Go</button>
        </div>
        <div id="folder-recents" class="folder-recents hidden"></div>
        <div id="folder-breadcrumb" class="folder-breadcrumb"></div>
        <div id="folder-list" class="folder-list"></div>
        <div id="folder-new-row" class="folder-new-row hidden">
          <input id="folder-new-name" type="text" placeholder="New folder name" autocomplete="off" spellcheck="false">
          <button id="folder-new-create" class="modal-btn-save">Create</button>
          <button id="folder-new-cancel" class="modal-btn-cancel">Cancel</button>
        </div>
        <div id="folder-new-toggle-row" class="folder-new-toggle-row">
          <button id="folder-new-toggle" class="folder-new-toggle" type="button">+ New folder here</button>
        </div>
        <div id="add-project-message" class="add-project-message hidden"></div>
        <div class="folder-select-row">
          <input id="add-project-name" type="text" placeholder="Project name" autocomplete="off">
          <button id="add-project-confirm" class="modal-btn-save">Add</button>
        </div>
      </div>
      <div id="ap-panel-create" class="ap-panel hidden"></div>
    </div>
  </div>`;

    const overlay = this.querySelector('#add-project-modal');
    const closeBtn = this.querySelector('#add-project-close');
    if (closeBtn) closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
  }
}
customElements.define('claudeck-add-project', AddProjectModal);
