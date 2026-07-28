// Jump-to-latest pill — shown when new content arrives while the user has
// scrolled up. Click to force-scroll to the bottom and re-engage stick-to-bottom.
class JumpToLatest extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <button id="jump-to-latest-btn" class="jump-to-latest hidden" type="button" aria-label="Jump to latest message">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="jump-to-latest-label">New messages</span>
      </button>`;

    this._btn = this.querySelector('#jump-to-latest-btn');
    this._onState = (e) => {
      // Only react to the active (single-mode) pane for now. In parallel mode
      // each pane handles its own scroll independently and the global pill stays hidden.
      const detail = e.detail || {};
      if (detail.chatId != null) return;
      if (detail.hasNewBelow) {
        this._btn.classList.remove('hidden');
      } else {
        this._btn.classList.add('hidden');
      }
    };
    window.addEventListener('claudeck:scroll-state', this._onState);

    this._btn.addEventListener('click', async () => {
      // Lazy import to avoid pulling parallel.js into component init.
      const [{ getPane }, { scrollToBottom }] = await Promise.all([
        import('../ui/parallel.js'),
        import('../core/utils.js'),
      ]);
      const pane = getPane(null);
      if (pane) scrollToBottom(pane, { force: true });
    });
  }

  disconnectedCallback() {
    if (this._onState) window.removeEventListener('claudeck:scroll-state', this._onState);
  }
}
customElements.define('claudeck-jump-to-latest', JumpToLatest);
