/* Expense Tracker Lite - personal PWA for Khushnood khan
 * Frontend: vanilla JS. Backend: Google Apps Script web app (see backend/Code.gs).
 * Works offline: changes are saved locally and synced automatically when online. */
(() => {
  'use strict';

  /* ---------- tiny helpers ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full/blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const ymOf = (dateStr) => dateStr.slice(0, 7);
  const shiftMonth = (ym, delta) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  };
  const monthLabel = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  };
  const dayLabel = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const money = (() => {
    const f = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return (n) => f.format(n || 0);
  })();
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));

  /* ---------- constants & state ---------- */
  const DEFAULT_CATS = ['Food', 'Travel', 'Bills', 'Shopping', 'Health', 'Rent', 'Other'];
  const MODES = ['Cash', 'UPI', 'Card'];
  const view = $('#view');
  const state = {
    month: ymOf(todayStr()),
    tab: 'home',
    tx: [],
    cats: LS.get('cats', DEFAULT_CATS),
    q: '',
    form: null,
    lastError: null
  };
  let deferredInstall = null;

  const cfg = () => LS.get('cfg', null);
  const txKey = (m) => 'tx:' + m;
  const queue = () => LS.get('queue', []);
  const sortTx = (arr) => arr.sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : (a.date < b.date ? 1 : -1)));

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ---------- network layer (Google Apps Script) ---------- */
  async function call(action, data, post) {
    const c = cfg();
    if (!c) throw Object.assign(new Error('Not connected'), { fatal: true });
    let res;
    if (post) {
      // No custom headers => "simple" request, no CORS preflight (Apps Script can't answer one).
      res = await fetch(c.url, { method: 'POST', body: JSON.stringify(Object.assign({}, data, { action, key: c.key })), redirect: 'follow' });
    } else {
      const q = new URLSearchParams(Object.assign({}, data, { action, key: c.key }));
      res = await fetch(c.url + (c.url.includes('?') ? '&' : '?') + q.toString(), { redirect: 'follow' });
    }
    let j;
    try { j = await res.json(); } catch (e) {
      throw Object.assign(new Error('Bad response - check the web app is deployed with access "Anyone"'), { fatal: true });
    }
    if (!j.success) {
      throw Object.assign(new Error(j.error || 'Server error'), { server: true, fatal: j.error === 'Unauthorized' });
    }
    return j.data;
  }

  /* ---------- offline queue ---------- */
  let flushing = false;
  async function flush() {
    if (flushing || !cfg() || !navigator.onLine) return;
    flushing = true;
    try {
      let q = queue();
      while (q.length) {
        const it = q[0];
        try {
          await call(it.action, it.data, true);
          q.shift();
          LS.set('queue', q);
        } catch (e) {
          if (e.server && !e.fatal) { // invalid change: drop it so it doesn't block the rest
            q.shift();
            LS.set('queue', q);
            toast('Skipped a change: ' + e.message);
          } else { throw e; }
        }
        q = queue();
      }
      state.lastError = null;
    } catch (e) {
      state.lastError = e.fatal ? e.message : null; // plain network errors just retry later
    } finally {
      flushing = false;
      updateSync();
    }
  }

  function enqueue(action, data) {
    const q = queue();
    q.push({ action, data });
    LS.set('queue', q);
    updateSync();
    flush();
  }

  function updateSync() {
    const n = queue().length;
    let t = 'Synced';
    if (!cfg()) t = 'Not connected';
    else if (state.lastError) t = state.lastError;
    else if (!navigator.onLine) t = n ? `Offline · ${n} pending` : 'Offline';
    else if (n) t = `Syncing ${n}…`;
    $('#sync').textContent = t;
  }

  /* ---------- local data ---------- */
  function cachedKeys() {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('tx:')) out.push(k); } } catch (e) { /* ignore */ }
    return out;
  }
  function removeLocal(id) {
    cachedKeys().forEach((k) => {
      const arr = LS.get(k, []);
      const next = arr.filter((t) => t.id !== id);
      if (next.length !== arr.length) LS.set(k, next);
    });
  }
  function putLocal(tx) {
    removeLocal(tx.id);
    const k = txKey(ymOf(tx.date));
    const arr = LS.get(k, []);
    arr.push(tx);
    LS.set(k, sortTx(arr));
  }
  const refreshTx = () => { state.tx = LS.get(txKey(state.month), []); };

  async function loadMonth() {
    const m = state.month;
    refreshTx();
    render();
    if (!cfg() || !navigator.onLine) return;
    await flush();
    if (queue().length) return; // unsynced local changes win; keep local view
    try {
      const data = await call('list', { month: m }, false);
      if (queue().length) return;
      LS.set(txKey(m), sortTx(data));
      if (state.month === m) { state.tx = LS.get(txKey(m), []); render(); }
      state.lastError = null;
    } catch (e) {
      state.lastError = e.fatal ? e.message : null;
    }
    updateSync();
  }

  async function loadCategories() {
    if (!cfg() || !navigator.onLine || queue().length) return;
    try {
      const cats = await call('categories', {}, false);
      if (Array.isArray(cats) && cats.length) { state.cats = cats; LS.set('cats', cats); }
    } catch (e) { /* offline or error: keep local list */ }
  }

  /* ---------- rendering ---------- */
  function setTab(t) {
    state.tab = t;
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $('#monthBar').style.visibility = (t === 'home' || t === 'history') ? 'visible' : 'hidden';
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    $('#monthLabel').textContent = monthLabel(state.month);
    ({ home: renderHome, add: renderAdd, history: renderHistory, settings: renderSettings })[state.tab]();
    updateSync();
  }

  function totals(list) {
    let expense = 0, income = 0;
    const by = {};
    list.forEach((t) => {
      if (t.type === 'Income') income += t.amount;
      else { expense += t.amount; by[t.category] = (by[t.category] || 0) + t.amount; }
    });
    const top = Object.keys(by).map((k) => ({ c: k, v: by[k] })).sort((a, b) => b.v - a.v).slice(0, 5);
    return { expense, income, balance: income - expense, top };
  }

  function txRow(t) {
    const sign = t.type === 'Income' ? '+' : '−';
    const sub = [t.mode, t.note].filter(Boolean).join(' · ');
    return `<button class="tx" data-id="${esc(t.id)}">
      <span class="a"><span class="c">${esc(t.category)}</span><span class="n" style="display:block">${esc(sub)}</span></span>
      <span class="m ${esc(t.type)}">${sign}${money(t.amount)}</span></button>`;
  }

  function bindTxClicks(root) {
    $$('.tx', root).forEach((b) => b.addEventListener('click', () => {
      const t = state.tx.find((x) => x.id === b.dataset.id);
      if (!t) return;
      state.form = Object.assign({ editing: true, amount: String(t.amount), cat: t.category }, t);
      setTab('add');
    }));
  }

  function renderHome() {
    const s = totals(state.tx);
    const max = s.top.length ? s.top[0].v : 1;
    const recent = state.tx.slice(0, 5);
    view.innerHTML = `
      <section class="card">
        <div class="muted small">Balance · ${esc(monthLabel(state.month))}</div>
        <div class="balance ${s.balance < 0 ? 'neg' : ''}">${money(s.balance)}</div>
        <div class="row2">
          <div class="stat exp"><span class="small muted">Expense</span><b>${money(s.expense)}</b></div>
          <div class="stat inc"><span class="small muted">Income</span><b>${money(s.income)}</b></div>
        </div>
      </section>
      <section class="card">
        <h2>Top categories</h2>
        ${s.top.length ? s.top.map((t) => `
          <div class="bar"><div class="l"><span>${esc(t.c)}</span><b>${money(t.v)}</b></div>
          <div class="t"><i style="width:${Math.max(3, Math.round((t.v / max) * 100))}%"></i></div></div>`).join('')
          : '<div class="empty">No expenses this month yet</div>'}
      </section>
      <section>
        <h2 style="margin:6px 4px">Recent</h2>
        ${recent.length ? recent.map(txRow).join('') : '<div class="empty">Tap Add to log your first transaction</div>'}
      </section>`;
    bindTxClicks(view);
  }

  function newForm() {
    return { editing: false, id: null, type: 'Expense', amount: '', cat: null, date: todayStr(), mode: 'UPI', note: '' };
  }

  function renderAdd() {
    if (!state.form) state.form = newForm();
    const f = state.form;
    const cats = state.cats.includes(f.cat) || !f.cat ? state.cats : state.cats.concat(f.cat);
    const chip = (list, sel, attr) => list.map((c) => `<button type="button" class="${c === sel ? 'on' : ''}" data-${attr}="${esc(c)}">${esc(c)}</button>`).join('');
    view.innerHTML = `
      <form class="card" id="addForm" autocomplete="off">
        <h2>${f.editing ? 'Edit transaction' : 'Add transaction'}</h2>
        <div class="seg" role="group" aria-label="Type">
          ${['Expense', 'Income'].map((t) => `<button type="button" class="${f.type === t ? 'on' : ''}" data-type="${t}">${t}</button>`).join('')}
        </div>
        <label class="f" for="amt">Amount (₹)</label>
        <input id="amt" class="amount" type="text" inputmode="decimal" placeholder="0" value="${esc(f.amount)}" aria-label="Amount in rupees">
        <label class="f">Category</label>
        <div class="chips" id="cats">${chip(cats, f.cat, 'cat')}</div>
        <label class="f">Payment mode</label>
        <div class="chips" id="modes">${chip(MODES, f.mode, 'mode')}</div>
        <label class="f" for="date">Date</label>
        <input id="date" type="date" value="${esc(f.date)}">
        <label class="f" for="note">Note (optional)</label>
        <input id="note" type="text" maxlength="200" placeholder="e.g. Lunch with team" value="${esc(f.note)}">
        <button class="btn" type="submit">${f.editing ? 'Save changes' : 'Save'}</button>
        ${f.editing ? '<button class="btn danger" type="button" id="del">Delete</button><button class="btn ghost" type="button" id="cancel">Cancel</button>' : ''}
      </form>`;

    $$('[data-type]', view).forEach((b) => b.addEventListener('click', () => { f.type = b.dataset.type; renderAdd(); }));
    $$('[data-cat]', view).forEach((b) => b.addEventListener('click', () => { f.cat = b.dataset.cat; syncInputs(); renderAdd(); }));
    $$('[data-mode]', view).forEach((b) => b.addEventListener('click', () => { f.mode = b.dataset.mode; syncInputs(); renderAdd(); }));
    const syncInputs = () => { f.amount = $('#amt').value; f.date = $('#date').value; f.note = $('#note').value; };
    $('#amt').addEventListener('input', (e) => {
      let v = e.target.value.replace(/[^\d.]/g, '');
      const i = v.indexOf('.');
      if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '').slice(0, 2);
      e.target.value = v;
      f.amount = v;
    });
    $('#date').addEventListener('input', syncInputs);
    $('#note').addEventListener('input', syncInputs);
    if (!f.editing && !f.amount) $('#amt').focus({ preventScroll: true });

    $('#addForm').addEventListener('submit', (e) => {
      e.preventDefault();
      syncInputs();
      const amount = Number(f.amount);
      if (!(amount > 0)) return toast('Enter an amount');
      if (!f.cat) return toast('Pick a category');
      if (!f.date) return toast('Pick a date');
      const now = new Date().toISOString();
      const tx = {
        id: f.id || uuid(), date: f.date, type: f.type, amount: Math.round(amount * 100) / 100,
        category: f.cat, mode: f.mode, note: f.note.trim(),
        createdAt: f.createdAt || now, updatedAt: now
      };
      const editing = f.editing;
      putLocal(tx);
      enqueue(editing ? 'update' : 'add', { tx });
      state.form = null;
      state.month = ymOf(tx.date);
      refreshTx();
      toast(editing ? 'Updated' : 'Saved');
      setTab(editing ? 'history' : 'home');
    });

    if (f.editing) {
      $('#cancel').addEventListener('click', () => { state.form = null; setTab('history'); });
      $('#del').addEventListener('click', () => {
        if (!confirm('Delete this transaction?')) return;
        removeLocal(f.id);
        enqueue('delete', { id: f.id });
        state.form = null;
        refreshTx();
        toast('Deleted');
        setTab('history');
      });
    }
  }

  function renderHistory() {
    view.innerHTML = `
      <input id="q" type="search" placeholder="Search note, category, mode…" value="${esc(state.q)}" aria-label="Search">
      <div id="list"></div>`;
    $('#q').addEventListener('input', (e) => { state.q = e.target.value; fillList(); });
    fillList();
  }

  function fillList() {
    const q = state.q.trim().toLowerCase();
    const list = state.tx.filter((t) => !q || [t.note, t.category, t.mode, String(t.amount)].join(' ').toLowerCase().includes(q));
    const box = $('#list');
    if (!list.length) { box.innerHTML = `<div class="empty">${q ? 'No matches' : 'No transactions this month'}</div>`; return; }
    let html = '', day = '';
    list.forEach((t) => {
      if (t.date !== day) { day = t.date; html += `<div class="day">${esc(dayLabel(day))}</div>`; }
      html += txRow(t);
    });
    box.innerHTML = html;
    bindTxClicks(box);
  }

  function renderSettings() {
    const c = cfg();
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    view.innerHTML = `
      <section class="card">
        <h2>Categories</h2>
        <div id="catList">${state.cats.map((n) => `<div class="list-row"><span>${esc(n)}</span><button data-delcat="${esc(n)}" aria-label="Remove ${esc(n)}">×</button></div>`).join('')}</div>
        <form class="inline" id="catForm" style="margin-top:10px">
          <input id="newCat" type="text" maxlength="40" placeholder="New category" aria-label="New category">
          <button class="btn" type="submit">Add</button>
        </form>
      </section>
      <section class="card">
        <h2>Data</h2>
        <button class="btn ghost" id="csv" style="margin-top:0">Export ${esc(monthLabel(state.month))} to CSV</button>
        <button class="btn ghost" id="backup">Backup all to Google Drive</button>
        <button class="btn ghost" id="syncNow">Sync now</button>
      </section>
      <section class="card">
        <h2>App</h2>
        ${standalone ? '<p class="muted small" style="margin-top:0">Installed ✔</p>'
          : (deferredInstall ? '<button class="btn" id="install" style="margin-top:0">Install app</button>'
            : `<p class="muted small" style="margin-top:0">${ios ? 'To install: tap Share, then “Add to Home Screen”.' : 'To install: open the browser menu and choose “Install app” / “Add to Home screen”.'}</p>`)}
        <button class="btn ghost" id="chgPin">Change PIN</button>
        <button class="btn ghost" id="lockNow">Lock now</button>
        <button class="btn ghost" id="conn">Server connection</button>
        <p class="muted small">Connected to: ${c ? esc(c.url.slice(0, 48)) + '…' : 'nothing'}</p>
      </section>`;

    $('#catForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#newCat').value.trim().slice(0, 40);
      if (!name) return;
      if (!state.cats.some((x) => x.toLowerCase() === name.toLowerCase())) {
        state.cats.push(name); LS.set('cats', state.cats);
        enqueue('addCategory', { name });
      }
      renderSettings();
    });
    $$('[data-delcat]', view).forEach((b) => b.addEventListener('click', () => {
      const name = b.dataset.delcat;
      if (state.cats.length <= 1) return toast('Keep at least one category');
      if (!confirm(`Remove "${name}"? Existing transactions keep it.`)) return;
      state.cats = state.cats.filter((x) => x !== name); LS.set('cats', state.cats);
      enqueue('deleteCategory', { name });
      renderSettings();
    }));
    $('#csv').addEventListener('click', exportCsv);
    $('#backup').addEventListener('click', async () => {
      if (!navigator.onLine) return toast('You are offline');
      try { await flush(); const r = await call('backup', {}, true); toast('Saved ' + r.file + ' in Drive'); }
      catch (e) { toast('Backup failed: ' + e.message); }
    });
    $('#syncNow').addEventListener('click', async () => { toast('Syncing…'); await loadMonth(); await loadCategories(); renderSettings(); toast(state.lastError || 'Up to date'); });
    const inst = $('#install');
    if (inst) inst.addEventListener('click', async () => {
      deferredInstall.prompt();
      await deferredInstall.userChoice.catch(() => {});
      deferredInstall = null; renderSettings();
    });
    $('#chgPin').addEventListener('click', () => showPinSetup(true));
    $('#lockNow').addEventListener('click', lock);
    $('#conn').addEventListener('click', showConnectionSetup);
  }

  function exportCsv() {
    const esc2 = (v) => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const rows = [['date', 'type', 'amount', 'category', 'mode', 'note']]
      .concat(state.tx.slice().reverse().map((t) => [t.date, t.type, t.amount, t.category, t.mode, t.note]));
    const blob = new Blob([rows.map((r) => r.map(esc2).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `expenses-${state.month}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- PIN lock & first-run setup ---------- */
  async function hashPin(pin) {
    const data = 'etl:' + pin;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return 'plain:' + btoa(data); // only used on non-secure origins
  }

  const overlay = $('#overlay');
  function openOverlay(html) { overlay.innerHTML = html; overlay.hidden = false; $('#top').hidden = true; $('#tabs').hidden = true; view.hidden = true; }
  function closeOverlay() { overlay.hidden = true; overlay.innerHTML = ''; $('#top').hidden = false; $('#tabs').hidden = false; view.hidden = false; }

  function lock() {
    if (!LS.get('pin', null)) return showPinSetup(false);
    openOverlay(`
      <form class="box" id="lockForm">
        <img class="big" src="icons/logo.png" alt="">
        <h1>Hello, Khushnood</h1>
        <p class="muted">Enter your PIN to open Expense Tracker</p>
        <input id="pin" class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" aria-label="PIN">
        <div class="err" id="err" role="alert"></div>
        <button class="btn" type="submit">Unlock</button>
      </form>`);
    $('#pin').focus();
    $('#lockForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if ((await hashPin($('#pin').value)) === LS.get('pin', null)) { closeOverlay(); start(); }
      else { $('#err').textContent = 'Wrong PIN'; $('#pin').value = ''; }
    });
  }

  function showPinSetup(changing) {
    openOverlay(`
      <form class="box" id="pinForm">
        <img class="big" src="icons/logo.png" alt="">
        <h1>${changing ? 'Change PIN' : 'Create a PIN'}</h1>
        <p class="muted">4 to 6 digits. It locks this app on this device.</p>
        <input id="p1" class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="PIN" autocomplete="off" aria-label="New PIN">
        <input id="p2" class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="Repeat" autocomplete="off" style="margin-top:10px" aria-label="Repeat PIN">
        <div class="err" id="err" role="alert"></div>
        <button class="btn" type="submit">Save PIN</button>
        ${changing ? '<button class="btn ghost" type="button" id="back">Cancel</button>' : ''}
      </form>`);
    $('#p1').focus();
    if (changing) $('#back').addEventListener('click', () => { closeOverlay(); setTab('settings'); });
    $('#pinForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const a = $('#p1').value, b = $('#p2').value;
      if (!/^\d{4,6}$/.test(a)) return ($('#err').textContent = 'Use 4 to 6 digits');
      if (a !== b) return ($('#err').textContent = 'PINs do not match');
      LS.set('pin', await hashPin(a));
      closeOverlay();
      toast('PIN saved');
      start();
    });
  }

  function showConnectionSetup() {
    const c = cfg() || { url: '', key: '' };
    openOverlay(`
      <form class="box tl" id="cfgForm">
        <div style="text-align:center"><img class="big" src="icons/logo.png" alt=""><h1>Connect your sheet</h1></div>
        <p class="muted small">Paste the Web App URL from Apps Script (Deploy › Manage deployments) and the secret key you set in <code>SETUP_API_KEY</code>. These stay on this device only.</p>
        <label class="f" for="u">Web App URL</label>
        <input id="u" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c.url)}" autocomplete="off">
        <label class="f" for="k">API key</label>
        <input id="k" type="password" value="${esc(c.key)}" autocomplete="off">
        <div class="err" id="err" role="alert"></div>
        <button class="btn" type="submit">Test &amp; save</button>
        ${cfg() ? '<button class="btn ghost" type="button" id="back">Cancel</button>' : ''}
      </form>`);
    const back = $('#back');
    if (back) back.addEventListener('click', () => { closeOverlay(); start(); setTab('settings'); });
    $('#cfgForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('#u').value.trim(), key = $('#k').value.trim();
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return ($('#err').textContent = 'URL must start with https://script.google.com/');
      if (key.length < 16) return ($('#err').textContent = 'Key looks too short');
      const btn = e.submitter; if (btn) btn.disabled = true;
      $('#err').textContent = 'Testing…';
      const old = cfg();
      LS.set('cfg', { url, key });
      try {
        await call('ping', {}, false);
        state.lastError = null;
        closeOverlay(); toast('Connected'); start();
      } catch (err) {
        if (old) LS.set('cfg', old); else LS.del('cfg');
        $('#err').textContent = 'Could not connect: ' + err.message;
        if (btn) btn.disabled = false;
      }
    });
  }

  /* ---------- boot ---------- */
  let started = false;
  function start() {
    if (!cfg()) return showConnectionSetup();
    $('#top').hidden = false; $('#tabs').hidden = false; view.hidden = false;
    if (!started) {
      started = true;
      $$('#tabs button').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.tab !== 'add') state.form = null;
        setTab(b.dataset.tab);
      }));
      $('#prevM').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); loadMonth(); });
      $('#nextM').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); loadMonth(); });
    }
    setTab(state.tab);
    loadMonth();
    loadCategories().then(() => { if (state.tab === 'add' || state.tab === 'settings') render(); });
  }

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; if (state.tab === 'settings' && overlay.hidden) renderSettings(); });
  window.addEventListener('online', () => { if (overlay.hidden) loadMonth(); });
  window.addEventListener('offline', updateSync);

  // Re-lock after 5 minutes in the background.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000 && overlay.hidden && LS.get('pin', null)) lock();
    else if (!document.hidden && overlay.hidden) flush();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // First run: PIN first, then connection. Otherwise unlock.
  if (!LS.get('pin', null)) showPinSetup(false);
  else lock();
})();
