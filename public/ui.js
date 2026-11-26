// Pieces every page shares, loaded before the page's own script (site.js, app.js):
//
//   Dropdowns  Every <select> on the site is drawn as the site's own control: a button in the site's frame and
//              a list in its pixel style. The <select> stays in the page, hidden, and stays what everything else
//              reads and writes: .value, its options and its "change" event work as before, so code that makes
//              or changes a select needs nothing new. A select with data-native, multiple or size > 1 is left be.
//   Mod jars   mcstatsUI.modDownload(downloads, { suggested, latest }): the mod's download, as on /mod, with a
//              Minecraft version and a mod version to pick (used by /mod, /new and the admin pages).
(() => {
  const SKIP = (sel) => sel.multiple || sel.size > 1 || sel.hasAttribute('data-native');
  const buttons = new WeakMap(); // select → its button
  let open = null; // { sel, btn, list, items, active }

  // ---------- keeping the button in step with its select ----------
  // Code sets .value and .selectedIndex directly (no event), so those setters say so too.
  for (const prop of ['value', 'selectedIndex']) {
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(HTMLSelectElement.prototype, prop, {
      ...d,
      set(v) { d.set.call(this, v); if (buttons.has(this)) sync(this); },
    });
  }
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;

  function label(opt) { return opt ? (opt.label || opt.textContent || '').trim() : ''; }
  function sync(sel) {
    const btn = buttons.get(sel);
    if (!btn) return;
    const opt = sel.options[sel.selectedIndex];
    btn.firstChild.textContent = label(opt) || ' ';
    btn.disabled = sel.disabled;
    btn.hidden = sel.hidden;
    btn.className = ['mc-select', ...[...sel.classList].filter((c) => c !== 'mc-select-native')].join(' ');
    btn.style.cssText = sel.style.cssText;
    const aria = sel.getAttribute('aria-label');
    if (aria) btn.setAttribute('aria-label', aria); else btn.removeAttribute('aria-label');
    if (sel.title) btn.title = sel.title;
    if (open && open.sel === sel) render();
  }

  function enhance(sel) {
    if (buttons.has(sel)) { // moved: its button goes with it
      const b = buttons.get(sel);
      if (sel.nextSibling !== b) sel.after(b);
      return;
    }
    if (SKIP(sel)) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.append(document.createElement('span'));
    btn.firstChild.className = 'mc-select-text';
    // a <label for> points at the select: send it on to the button
    if (sel.id) {
      for (const l of document.querySelectorAll(`label[for="${CSS.escape(sel.id)}"]`)) {
        if (!l.id) l.id = `${sel.id}-label`;
        btn.setAttribute('aria-labelledby', l.id);
      }
    }
    buttons.set(sel, btn);
    sel.classList.add('mc-select-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    sel.after(btn);
    sel.addEventListener('focus', () => btn.focus());
    sel.addEventListener('change', () => sync(sel));
    new MutationObserver(() => sync(sel)).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'class', 'style', 'aria-label', 'title', 'label', 'selected'] });
    btn.addEventListener('click', () => (open && open.sel === sel ? close() : show(sel)));
    btn.addEventListener('keydown', (e) => onKey(e, sel));
    sync(sel);
  }

  // Selects come and go with the pages: each one is enhanced as it arrives, and its button leaves with it.
  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.tagName === 'SELECT') enhance(root);
    else for (const s of root.querySelectorAll('select')) enhance(s);
  }
  function unscan(root) {
    if (root.nodeType !== 1) return;
    const sels = root.tagName === 'SELECT' ? [root] : [...root.querySelectorAll('select')];
    for (const s of sels) {
      const btn = buttons.get(s);
      if (!btn || s.isConnected) continue;
      if (btn.isConnected && btn.parentNode !== root) btn.remove();
      if (open && open.sel === s) close();
    }
  }
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.removedNodes) unscan(n);
      for (const n of r.addedNodes) scan(n);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.body) scan(document.body);
  else document.addEventListener('DOMContentLoaded', () => scan(document.body));

  // ---------- the list ----------
  function show(sel) {
    close();
    const btn = buttons.get(sel);
    if (!btn || btn.disabled || !sel.options.length) return;
    const list = document.createElement('div');
    list.className = 'mc-select-list';
    list.setAttribute('role', 'listbox');
    list.id = `mc-select-list-${Math.random().toString(36).slice(2, 8)}`;
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the button
    (document.fullscreenElement || document.body).append(list);
    open = { sel, btn, list, items: [], active: sel.selectedIndex };
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-controls', list.id);
    render();
    place();
  }
  function render() {
    const { sel, list } = open;
    const items = [];
    list.replaceChildren();
    let group = null;
    [...sel.options].forEach((opt, i) => {
      const g = opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement : null;
      if (g && g !== group) list.append(Object.assign(document.createElement('div'), { className: 'mc-select-group', textContent: g.label }));
      group = g;
      if (opt.hidden) return;
      const item = document.createElement('div');
      item.className = 'mc-select-option';
      item.id = `${list.id}-${i}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === sel.selectedIndex));
      item.textContent = label(opt) || ' ';
      if (opt.disabled || (g && g.disabled)) item.setAttribute('aria-disabled', 'true');
      else {
        item.addEventListener('click', () => pick(i));
        item.addEventListener('mousemove', () => { if (open.active !== i) activate(i, false); });
      }
      item.dataset.i = i;
      items.push(item);
      list.append(item);
    });
    open.items = items;
    activate(open.active, true);
  }
  function place() {
    const { btn, list } = open;
    const r = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    list.style.minWidth = `${Math.round(r.width)}px`;
    list.style.maxHeight = '';
    const h = list.offsetHeight, w = list.offsetWidth;
    const below = vh - r.bottom - 8, above = r.top - 8;
    const down = h <= below || below >= above;
    list.style.maxHeight = `${Math.max(120, Math.min(320, down ? below : above) - 6)}px`;
    list.style.top = `${Math.round(down ? r.bottom + 6 : r.top - Math.min(h, list.offsetHeight) - 6)}px`;
    list.style.left = `${Math.round(Math.max(8, Math.min(r.left, vw - w - 8)))}px`;
  }
  function activate(i, scroll) {
    if (!open) return;
    open.active = i;
    let el = null;
    for (const item of open.items) {
      const on = Number(item.dataset.i) === i;
      item.classList.toggle('active', on);
      if (on) el = item;
    }
    if (el) {
      open.btn.setAttribute('aria-activedescendant', el.id);
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
  }
  function close() {
    if (!open) return;
    open.list.remove();
    open.btn.setAttribute('aria-expanded', 'false');
    open.btn.removeAttribute('aria-activedescendant');
    open.btn.removeAttribute('aria-controls');
    open = null;
  }
  function pick(i) {
    if (!open) return;
    const { sel, btn } = open;
    close();
    btn.focus();
    if (i === sel.selectedIndex) return;
    valueSetter.call(sel, sel.options[i].value);
    sel.selectedIndex = i; // same value on two options: the one picked
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sync(sel);
  }

  // ---------- keys: as a native select does ----------
  let typed = '', typedAt = 0;
  function enabled(sel) { return [...sel.options].map((o, i) => (o.disabled || o.hidden || o.parentElement.disabled ? -1 : i)).filter((i) => i >= 0); }
  function onKey(e, sel) {
    const isOpen = open && open.sel === sel;
    const ok = enabled(sel);
    if (!ok.length) return;
    const cur = isOpen ? open.active : sel.selectedIndex;
    const step = (d) => { const at = ok.indexOf(cur); return ok[Math.max(0, Math.min(ok.length - 1, (at < 0 ? (d > 0 ? -1 : ok.length) : at) + d))]; };
    const go = (i) => { if (isOpen) activate(i, true); else if (i !== sel.selectedIndex) { show(sel); pick(i); } };
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': if (!isOpen && e.altKey) show(sel); else go(step(1)); break;
      case 'ArrowUp': go(step(-1)); break;
      case 'Home': go(ok[0]); break;
      case 'End': go(ok[ok.length - 1]); break;
      case 'PageDown': go(step(8)); break;
      case 'PageUp': go(step(-8)); break;
      case 'Enter': case ' ': if (isOpen) pick(open.active); else show(sel); break;
      case 'Escape': if (isOpen) close(); else handled = false; break;
      case 'Tab': if (isOpen) close(); handled = false; break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
          typedAt = now;
          const from = ok.indexOf(cur);
          const order = [...ok.slice(from + (typed.length === 1 ? 1 : 0)), ...ok.slice(0, from + (typed.length === 1 ? 1 : 0))];
          const hit = order.find((i) => label(sel.options[i]).toLowerCase().startsWith(typed));
          if (hit !== undefined) go(hit);
        } else handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  // Clicking elsewhere, scrolling the page or resizing it closes the list.
  document.addEventListener('mousedown', (e) => { if (open && !open.list.contains(e.target) && !open.btn.contains(e.target)) close(); }, true);
  window.addEventListener('scroll', (e) => { if (open && !open.list.contains(e.target)) close(); }, true);
  window.addEventListener('resize', () => close());
  document.addEventListener('fullscreenchange', () => close());

  // ---------- the mod's download ----------
  function make(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) (k === 'class' ? (n.className = v) : k === 'text' ? (n.textContent = v) : n.setAttribute(k, v));
    n.append(...kids.filter((k) => k != null));
    return n;
  }
  // downloads: every jar the site has (scripts/mod-info.mjs), newest mod first. suggested: the file to start on.
  function modDownload(downloads, { suggested = null, latest = null, fallback = null } = {}) {
    const list = downloads || [];
    if (!list.length) {
      return fallback ? make('div', { class: 'mod-get' }, make('a', { class: 'btn btn-primary site-go', href: fallback.url, download: fallback.file, text: 'Download the mod' })) : make('p', { class: 'site-hint', text: 'No jars are on this site yet.' });
    }
    const labels = [...new Set(list.map((d) => d.label))];
    const start = list.find((d) => d.file === suggested) || list[0];
    const game = make('select', { 'aria-label': 'Minecraft version' }, ...labels.map((l) => make('option', { value: l, text: `Minecraft ${l}` })));
    const ver = make('select', { 'aria-label': 'Mod version' });
    const link = make('a', { class: 'btn btn-primary site-go' });
    const hint = make('span', { class: 'site-hint' });
    game.value = start.label;
    const fill = (keep) => {
      const here = list.filter((d) => d.label === game.value);
      ver.replaceChildren(...here.map((d) => make('option', { value: d.file, text: `${d.version}${d.version === latest ? ' (newest)' : ''}` })));
      ver.value = here.some((d) => d.file === keep) ? keep : here[0].file;
    };
    const show = () => {
      const d = list.find((x) => x.file === ver.value);
      link.href = `/downloads/${encodeURIComponent(d.file)}`;
      link.setAttribute('download', d.file);
      link.textContent = `Download mcstats ${d.version}`;
      hint.textContent = [d.file, `Minecraft ${d.label}`, 'Fabric', 'server side', d.java && `Java ${d.java.replace('>=', '')}+`].filter(Boolean).join(' · ');
    };
    game.addEventListener('change', () => { fill(null); show(); });
    ver.addEventListener('change', show);
    fill(start.file);
    show();
    return make('div', { class: 'mod-dl' },
      make('div', { class: 'mod-dl-picks' },
        make('label', { class: 'mod-dl-field' }, make('span', { class: 'site-label', text: 'Minecraft' }), game),
        make('label', { class: 'mod-dl-field' }, make('span', { class: 'site-label', text: 'Mod version' }), ver)),
      make('div', { class: 'mod-get' }, link, hint));
  }

  window.mcstatsUI = { modDownload, enhance, sync };
})();
