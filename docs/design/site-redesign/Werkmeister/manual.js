(() => {
  const articles = Array.from(document.querySelectorAll('main article'));
  const menu = document.querySelector('#manual-nav');
  const menuButton = document.querySelector('#mobile-menu');
  const sectionNav = document.querySelector('#section-nav');
  const nextLink = document.querySelector('#next-page');
  const dialog = document.querySelector('#search-dialog');
  const searchInput = document.querySelector('#query');
  const results = document.querySelector('#results');
  const main = document.querySelector('main');
  const source = document.querySelector('#source-link');
  const searchIndex = [];
  let activeArticle;
  let observer;

  function icon(name) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    const use = document.createElementNS(svgNS, 'use');
    use.setAttribute('href', '#' + name);
    svg.setAttribute('aria-hidden', 'true');
    svg.append(use);
    return svg;
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* File previews may need the selection-based alternative. */ }
    }
    const field = document.createElement('textarea');
    field.value = text;
    field.style.cssText = 'position:fixed;top:0;left:-9999px';
    const priorFocus = document.activeElement;
    document.body.append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Browser denies clipboard. */ }
    field.remove();
    priorFocus?.focus({preventScroll:true});
    return copied;
  }

  for (const article of articles) {
    const page = article.querySelector('h1').textContent;
    searchIndex.push({page, title:page, id:article.id, body:article.querySelector('.lead').textContent, group:article.dataset.group, top:true});
    for (const section of article.querySelectorAll('section')) {
      const title = section.dataset.section;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'');
      section.id = article.id + '/' + slug;
      searchIndex.push({page, title, id:section.id, body:section.textContent, group:article.dataset.group});
    }
  }

  document.querySelectorAll('pre').forEach(pre => {
    const wrapper = document.createElement('div');
    wrapper.className = 'code';
    const head = document.createElement('div');
    head.className = 'code-head';
    const label = document.createElement('span');
    label.textContent = pre.dataset.lang;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label','Copy code');
    const message = document.createElement('span');
    message.setAttribute('aria-live','polite');
    message.textContent = 'Copy';
    button.append(icon('copy'),message);
    let timer;
    button.addEventListener('click', async () => {
      clearTimeout(timer);
      message.textContent = await copyText(pre.textContent) ? 'Copied' : 'Select to copy';
      timer = setTimeout(() => { message.textContent = 'Copy'; }, 2200);
    });
    head.append(label,button);
    pre.replaceWith(wrapper);
    wrapper.append(head,pre);
  });

  function setMenu(open) {
    menu.classList.toggle('open',open);
    menuButton.setAttribute('aria-expanded',String(open));
    menuButton.setAttribute('aria-label',open ? 'Close manual navigation' : 'Open manual navigation');
    menuButton.querySelector('use').setAttribute('href',open ? '#close' : '#menu');
  }
  menuButton.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
  menu.addEventListener('click', event => { if (event.target.closest('a')) setMenu(false); });
  document.addEventListener('click', event => {
    if (menu.classList.contains('open') && !menu.contains(event.target) && !menuButton.contains(event.target)) setMenu(false);
  });

  function markSection(id) {
    for (const link of sectionNav.children) {
      if (link.hash === '#' + id) link.setAttribute('aria-current','location');
      else link.removeAttribute('aria-current');
    }
  }

  function showRoute({first = false} = {}) {
    if (location.hash === '#manual-content') { main.focus(); return; }
    const hash = location.hash.slice(1);
    const [pageId] = hash.split('/');
    const article = articles.find(item => item.id === pageId) || articles[0];
    const target = hash.includes('/') ? document.getElementById(hash) : null;
    const pageChanged = activeArticle !== article;
    activeArticle = article;
    document.title = article.querySelector('h1').textContent + ' · Werkmeister manual';
    if (pageChanged) {
      for (const item of articles) item.hidden = item !== article;
      for (const link of menu.querySelectorAll('.nav-block a')) {
        if (link.hash === '#' + article.id) link.setAttribute('aria-current','page');
        else link.removeAttribute('aria-current');
      }
      sectionNav.replaceChildren();
      observer?.disconnect();
      const sections = Array.from(article.querySelectorAll('section'));
      for (const section of sections) {
        const link = document.createElement('a');
        link.href = '#' + section.id;
        link.textContent = section.dataset.section;
        sectionNav.append(link);
      }
      if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver(entries => {
          const visible = entries.filter(entry => entry.isIntersecting).sort((a,b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (visible.length) markSection(visible[0].target.id);
        }, {rootMargin:'-90px 0px -58% 0px'});
        sections.forEach(section => observer.observe(section));
      }
      source.href = article.dataset.source;
      const index = articles.indexOf(article);
      const next = articles[(index+1) % articles.length];
      nextLink.href = '#' + next.id;
      const text = document.createElement('span');
      const name = document.createElement('strong');
      text.append(index === articles.length-1 ? 'Back to the beginning' : 'Next in manual');
      name.textContent = next.querySelector('h1').textContent;
      text.append(name);
      nextLink.replaceChildren(text,icon('arrow'));
      markSection(sections[0].id);
    }
    setMenu(false);
    if (!first && pageChanged) main.focus({preventScroll:true});
    if (target && article.contains(target)) {
      target.scrollIntoView({block:'start'});
      markSection(target.id);
    } else if (!first || hash) window.scrollTo(0,0);
  }

  function showResults() {
    const query = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = searchIndex.map(item => {
      const title = item.title.toLowerCase();
      const page = item.page.toLowerCase();
      const body = item.body.toLowerCase();
      let score = 0;
      for (const term of query) {
        if (title.includes(term)) score += 8;
        else if (page.includes(term)) score += 3;
        else if (body.includes(term)) score += 1;
        else return {item,score:0};
      }
      return {item,score:score + (item.top && score ? 2 : 0)};
    }).filter(hit => query.length ? hit.score > 0 : hit.item.top).sort((a,b) => b.score-a.score);
    document.querySelector('#result-label').textContent = !query.length ? 'Articles' : matches.length + ' ' + (matches.length === 1 ? 'result' : 'results');
    results.replaceChildren();
    for (const {item} of matches) {
      const link = document.createElement('a');
      link.href = '#' + item.id;
      const title = document.createElement('strong');
      title.textContent = item.title;
      const context = document.createElement('small');
      context.textContent = item.top ? item.group : item.page;
      link.append(title,context);
      results.append(link);
    }
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Try a command, topic, or workspace state.';
      results.append(empty);
    }
  }

  function openSearch() {
    setMenu(false);
    searchInput.value = '';
    showResults();
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('has-dialog');
    searchInput.focus();
  }
  document.querySelector('#search-open').addEventListener('click',openSearch);
  document.querySelector('#search-close').addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => document.body.classList.remove('has-dialog'));
  dialog.addEventListener('click',event => { if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  }});
  searchInput.addEventListener('input',showResults);
  results.addEventListener('click',event => {
    const link = event.target.closest('a');
    if (!link) return;
    event.preventDefault();
    dialog.close();
    if (location.hash !== link.hash) location.hash = link.hash;
    else showRoute();
  });
  dialog.addEventListener('keydown',event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dialog.close();
      return;
    }
    const links = Array.from(results.querySelectorAll('a'));
    if (!links.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const current = links.indexOf(document.activeElement);
      if (current === 0 && event.key === 'ArrowUp') searchInput.focus();
      else links[Math.max(0,Math.min(links.length-1,current+(event.key === 'ArrowDown' ? 1 : -1)))].focus();
    } else if (event.key === 'Enter' && document.activeElement === searchInput) {
      event.preventDefault();
      links[0].click();
    }
  });
  document.addEventListener('keydown',event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' || (event.key === '/' && !/INPUT|TEXTAREA/.test(event.target.tagName))) {
      event.preventDefault();
      openSearch();
    } else if (event.key === 'Escape' && menu.classList.contains('open')) {
      setMenu(false);
      menuButton.focus();
    }
  });
  window.addEventListener('hashchange',() => showRoute());
  showRoute({first:true});
})();
