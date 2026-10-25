/**
 * Expense Tracker Lite - Google Apps Script backend
 * Owner: Khushnood khan (personal use)
 *
 * Database: the Google Sheet this script is bound to (Extensions > Apps Script).
 * Tabs: Transactions, Categories, Settings.
 *
 * FIRST-TIME SETUP
 *  1. Change SETUP_API_KEY below to a long random secret.
 *  2. Run setup() once (authorize when asked).
 *  3. Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone.
 *  4. Delete the secret from SETUP_API_KEY afterwards if you like (it is now stored in Script Properties).
 *  After any code change: Deploy > Manage deployments > Edit > New version > Deploy.
 */

const SETUP_API_KEY = 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET';

const TX_SHEET = 'Transactions';
const CAT_SHEET = 'Categories';
const SET_SHEET = 'Settings';
const TX_HEADERS = ['id', 'date', 'type', 'amount', 'category', 'mode', 'note', 'createdAt', 'updatedAt'];
const DEFAULT_CATEGORIES = ['Food', 'Travel', 'Bills', 'Shopping', 'Health', 'Rent', 'Other'];
const TYPES = ['Expense', 'Income'];
const MODES = ['Cash', 'UPI', 'Card'];
const BACKUP_FOLDER = 'ExpenseTrackerLite Backups';

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

/** Run once. Creates tabs, headers, default categories and stores the API key. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let tx = ss.getSheetByName(TX_SHEET) || ss.insertSheet(TX_SHEET);
  if (tx.getLastRow() === 0) {
    tx.getRange(1, 1, 1, TX_HEADERS.length).setValues([TX_HEADERS]).setFontWeight('bold');
    tx.setFrozenRows(1);
  }
  tx.getRange('B:B').setNumberFormat('@');   // keep dates as plain YYYY-MM-DD text
  tx.getRange('H:I').setNumberFormat('@');

  let cat = ss.getSheetByName(CAT_SHEET) || ss.insertSheet(CAT_SHEET);
  if (cat.getLastRow() === 0) {
    cat.getRange(1, 1).setValue('name').setFontWeight('bold');
    cat.getRange(2, 1, DEFAULT_CATEGORIES.length, 1)
      .setValues(DEFAULT_CATEGORIES.map(function (c) { return [c]; }));
  }

  let set = ss.getSheetByName(SET_SHEET) || ss.insertSheet(SET_SHEET);
  if (set.getLastRow() === 0) {
    set.getRange(1, 1, 3, 2).setValues([['key', 'value'], ['owner', 'Khushnood khan'], ['currency', 'INR']]);
    set.getRange(1, 1, 1, 2).setFontWeight('bold');
  }

  if (SETUP_API_KEY === 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET' || SETUP_API_KEY.length < 16) {
    throw new Error('Set SETUP_API_KEY to a random secret of at least 16 characters, then run setup() again.');
  }
  PropertiesService.getScriptProperties().setProperty('API_KEY', SETUP_API_KEY);

  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  Logger.log('Setup complete.');
}

/* ------------------------------------------------------------------ */
/* HTTP entry points                                                   */
/* ------------------------------------------------------------------ */

function doGet(e) {
  return handle_((e && e.parameter) || {}, false);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ success: false, error: 'Bad request' });
  }
  return handle_(body, true);
}

function handle_(p, isPost) {
  try {
    if (!authOk_(p.key)) return out_({ success: false, error: 'Unauthorized' });
    const action = String(p.action || '');

    // Read actions
    if (action === 'ping') return out_({ success: true, data: 'pong' });
    if (action === 'list') return out_({ success: true, data: listMonth_(p.month) });
    if (action === 'summary') return out_({ success: true, data: summary_(p.month) });
    if (action === 'categories') return out_({ success: true, data: getCategories_() });

    // Write actions (POST only, serialized with a lock)
    if (!isPost) return out_({ success: false, error: 'Use POST for this action' });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (action) {
        case 'add': return out_({ success: true, data: upsert_(p.tx, true) });
        case 'update': return out_({ success: true, data: upsert_(p.tx, false) });
        case 'delete': return out_({ success: true, data: remove_(p.id) });
        case 'addCategory': return out_({ success: true, data: addCategory_(p.name) });
        case 'deleteCategory': return out_({ success: true, data: deleteCategory_(p.name) });
        case 'backup': return out_({ success: true, data: backupNow() });
        default: return out_({ success: false, error: 'Unknown action' });
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return out_({ success: false, error: String(err && err.message ? err.message : err) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function authOk_(key) {
  const stored = PropertiesService.getScriptProperties().getProperty('API_KEY');
  return !!stored && typeof key === 'string' && key.length === stored.length && key === stored;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sheet_(name) {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!s) throw new Error('Sheet "' + name + '" missing. Run setup() first.');
  return s;
}

/** Stop spreadsheet formula injection: text starting with = + - @ gets a leading apostrophe-safe space. */
function safeText_(v, max) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function normDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

function rowToTx_(r) {
  return {
    id: String(r[0]),
    date: normDate_(r[1]),
    type: String(r[2]),
    amount: Number(r[3]),
    category: String(r[4]),
    mode: String(r[5]),
    note: String(r[6] || ''),
    createdAt: String(r[7] || ''),
    updatedAt: String(r[8] || '')
  };
}

function monthOk_(m) {
  return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}

function validate_(t) {
  if (!t || typeof t !== 'object') throw new Error('Missing transaction');
  const id = String(t.id || '').trim();
  if (!/^[A-Za-z0-9\-]{8,64}$/.test(id)) throw new Error('Invalid id');
  const date = String(t.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T00:00:00Z').getTime())) throw new Error('Invalid date');
  if (TYPES.indexOf(t.type) < 0) throw new Error('Invalid type');
  const amount = Number(t.amount);
  if (!isFinite(amount) || amount <= 0 || amount > 999999999) throw new Error('Invalid amount');
  if (MODES.indexOf(t.mode) < 0) throw new Error('Invalid payment mode');
  const category = safeText_(t.category, 40);
  if (!category) throw new Error('Category required');
  return {
    id: id,
    date: date,
    type: t.type,
    amount: Math.round(amount * 100) / 100,
    category: category,
    mode: t.mode,
    note: safeText_(t.note, 200)
  };
}

/** Returns {sheet, rowIndex(1-based) or -1} for a transaction id. */
function findRow_(id) {
  const sh = sheet_(TX_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return { sh: sh, row: -1 };
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === id) return { sh: sh, row: i + 2 };
  }
  return { sh: sh, row: -1 };
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/** add + update. Idempotent: adding an existing id just updates it (safe for offline retries). */
function upsert_(raw, isAdd) {
  const t = validate_(raw);
  const now = new Date().toISOString();
  const f = findRow_(t.id);
  if (f.row < 0) {
    if (!isAdd) throw new Error('Transaction not found');
    f.sh.appendRow([t.id, t.date, t.type, t.amount, t.category, t.mode, t.note, now, now]);
    const r = f.sh.getLastRow();
    f.sh.getRange(r, 2).setNumberFormat('@').setValue(t.date);
    t.createdAt = now;
  } else {
    const created = f.sh.getRange(f.row, 8).getValue();
    f.sh.getRange(f.row, 2).setNumberFormat('@');
    f.sh.getRange(f.row, 1, 1, 9).setValues([[t.id, t.date, t.type, t.amount, t.category, t.mode, t.note, created, now]]);
    t.createdAt = String(created);
  }
  t.updatedAt = now;
  return t;
}

function remove_(id) {
  id = String(id || '');
  const f = findRow_(id);
  if (f.row > 0) f.sh.deleteRow(f.row);   // deleting a missing id is fine (idempotent)
  return { id: id };
}

function listMonth_(month) {
  if (!monthOk_(month)) throw new Error('Invalid month');
  const sh = sheet_(TX_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, 9).getValues();
  return rows
    .map(rowToTx_)
    .filter(function (t) { return t.date.indexOf(month) === 0; })
    .sort(function (a, b) {
      return a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : (a.date < b.date ? 1 : -1);
    });
}

function summary_(month) {
  const list = listMonth_(month);
  let expense = 0, income = 0;
  const byCat = {};
  list.forEach(function (t) {
    if (t.type === 'Income') income += t.amount;
    else { expense += t.amount; byCat[t.category] = (byCat[t.category] || 0) + t.amount; }
  });
  const top = Object.keys(byCat)
    .map(function (k) { return { category: k, total: Math.round(byCat[k] * 100) / 100 }; })
    .sort(function (a, b) { return b.total - a.total; })
    .slice(0, 5);
  return {
    month: month,
    expense: Math.round(expense * 100) / 100,
    income: Math.round(income * 100) / 100,
    balance: Math.round((income - expense) * 100) / 100,
    top: top
  };
}

function getCategories_() {
  const sh = sheet_(CAT_SHEET);
  const last = sh.getLastRow();
  if (last < 2) return DEFAULT_CATEGORIES.slice();
  return sh.getRange(2, 1, last - 1, 1).getValues()
    .map(function (r) { return String(r[0]); })
    .filter(String);
}

function addCategory_(name) {
  name = safeText_(name, 40);
  if (!name) throw new Error('Name required');
  const cats = getCategories_();
  const exists = cats.some(function (c) { return c.toLowerCase() === name.toLowerCase(); });
  if (!exists) sheet_(CAT_SHEET).appendRow([name]);
  return getCategories_();
}

function deleteCategory_(name) {
  const sh = sheet_(CAT_SHEET);
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = vals.length - 1; i >= 0; i--) {
      if (String(vals[i][0]) === String(name)) sh.deleteRow(i + 2);
    }
  }
  return getCategories_();
}

/* ------------------------------------------------------------------ */
/* Backup (optional)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Saves a CSV copy of all transactions to a Drive folder.
 * Run manually, or add a monthly time-driven trigger (Triggers > Add trigger).
 */
function backupNow() {
  const sh = sheet_(TX_SHEET);
  const data = sh.getDataRange().getValues();
  const csv = data.map(function (row) {
    return row.map(function (c) {
      const s = String(c instanceof Date ? normDate_(c) : c);
      return '"' + s.replace(/"/g, '""') + '"';
    }).join(',');
  }).join('\n');

  const it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
  const name = 'transactions-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd') + '.csv';
  folder.createFile(name, csv, MimeType.CSV);
  return { file: name, folder: BACKUP_FOLDER };
}
