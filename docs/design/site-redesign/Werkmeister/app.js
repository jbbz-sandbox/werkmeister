(() => {
  const menuButton = document.querySelector('.mobile-menu');
  const menu = document.getElementById('mobile-links');
  function setMenu(open) {
    menu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  menuButton.addEventListener('click', () => setMenu(menu.hidden));
  menu.addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      setMenu(false);
      menuButton.focus();
    }
  });

  const model = document.getElementById('workbench-art');
  const viewButtons = [...document.querySelectorAll('[data-model]')];
  for (const button of viewButtons) {
    button.addEventListener('click', () => {
      const exploded = button.dataset.model === 'exploded';
      model.dispatchEvent(new CustomEvent('werk-view', { detail: { exploded } }));
      model.setAttribute('aria-label', (exploded ? 'Exploded' : 'Assembled') + ' conceptual model of a workspace containing a coding session, service containers, and a Git worktree.');
      for (const other of viewButtons) other.setAttribute('aria-pressed', String(button === other));
    });
  }

  const stages = [
    {
      label: 'Workspace creation', title: 'Give the ticket a workbench.',
      text: 'A checkout bug gets its own branch and worktree. The agent can change files here while other tickets move forward in their own workspaces.',
      rows: [['Issue snapshot', 'SW-123'], ['Git worktree', 'checkout-retry'], ['Checkout service', 'local container']],
      status: 'Workspace isolated', next: 'Start the session'
    },
    {
      label: 'Agent session', title: 'Fix the bug in context.',
      text: 'The agent reproduces the failed checkout, makes a fix, then exercises it. Requests for the changed checkout service reach this workspace. Other services can use the shared baseline.',
      rows: [['Reproduce', 'retry fails'], ['Fix', 'update checkout'], ['Exercise', 'retry succeeds']],
      status: 'The fix is ready to propose', next: 'Review the change'
    },
    {
      label: 'Human review', title: 'You make the merge decision.',
      text: 'Werkmeister runs the pull request checks. A person inspects the diff and the behavior before merging. Try that decision with this example.',
      rows: [['Pull request', 'checkout-retry'], ['Change', 'retry handling'], ['Reviewer', 'waiting for you']],
      status: 'Awaiting review in this example', next: 'Merge example PR'
    },
    {
      label: 'Workspace close-out', title: 'Clear the workbench.',
      text: 'After the change merges and releases, close the workspace. Its worktrees and service containers are removed. Other tickets can keep running.',
      rows: [['Pull request', 'merged'], ['Release', 'complete'], ['Workspace', 'closed']],
      status: 'Example walkthrough complete', next: 'Replay the example'
    }
  ];
  const merged = {
    label: 'Human review', title: 'The example PR is merged.',
    text: 'You made the review decision. Once the change has released, the workspace can be closed.',
    rows: [['Pull request', 'checkout-retry'], ['Review', 'approved'], ['Merge', 'recorded']],
    status: 'Review complete in this example', next: 'See close-out'
  };
  const tabs = [...document.querySelectorAll('[data-step]')];
  const panel = document.getElementById('step-panel');
  const next = document.getElementById('next-step');
  let active = 0;
  let reviewed = false;
  function showStep(index) {
    active = index;
    const stage = index === 2 && reviewed ? merged : stages[index];
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', tabs[index].id);
    for (const [id, value] of Object.entries({
      'step-role': stage.label, 'step-title': stage.title, 'step-description': stage.text,
      'trace-foot': stage.status, 'next-step': stage.next
    })) document.getElementById(id).textContent = value;
    const rows = stage.rows.map(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'trace-row';
      for (const [className, content] of [['trace-branch', ''], ['trace-label', label], ['trace-value', value]]) {
        const part = document.createElement('span');
        part.className = className;
        part.textContent = content;
        row.append(part);
      }
      return row;
    });
    document.getElementById('trace-rows').replaceChildren(...rows);
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => showStep(i));
    tab.addEventListener('keydown', (event) => {
      const targets = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (!(event.key in targets)) return;
      event.preventDefault();
      const index = targets[event.key];
      showStep(index);
      tabs[index].focus();
    });
  });
  next.addEventListener('click', () => {
    if (active === 2 && !reviewed) {
      reviewed = true;
      showStep(2);
    } else {
      if (active === stages.length - 1) reviewed = false;
      showStep((active + 1) % stages.length);
    }
  });
  showStep(0);
})();
