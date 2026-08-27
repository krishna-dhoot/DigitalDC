// DigitalDC — Phase 1 client
// Capture -> extract (Apps Script -> Claude vision) -> confirm -> save.
// Offline queueing is Phase 2; this build requires a connection at capture time
// but never loses a photo mid-flow (it's held in memory/IndexedDB until saved).

// Surfaces JS errors as an on-screen alert — there's no devtools console on a
// site phone, so this is how we see what actually broke instead of guessing.
window.addEventListener('error', (e) => alert('DigitalDC error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => alert('DigitalDC error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));

const APP = {
  // Set this after deploying the Apps Script web app (Deploy > New deployment > Web app).
  scriptUrl: 'https://script.google.com/macros/s/AKfycbwLm0nMxq4JCxsh0JjqloZc_lPi15j-F8-PcvGi9pocJ_--mDAgJJxjqEKm23DPFPUY/exec',
  site: localStorage.getItem('digitaldc_site') || '',
  capturedBy: localStorage.getItem('digitaldc_user') || '',
  records: [],     // local cache of saved records, newest first
  draft: null,     // { photoDataUrl, fields } while mid-capture
  vendorList: [],   // grows only from names confirmed on save -- starts empty
  materialList: [], // same
};

// Pulls the current Vendors/Materials lists from the sheet. Best-effort: if it
// fails (offline), whatever lists we already have (possibly empty) are kept,
// and every field just falls back to "Add new" -- never blocks capture.
async function fetchLists() {
  try {
    const res = await fetch(`${APP.scriptUrl}?action=lists`);
    const data = await res.json();
    if (!data.error) {
      APP.vendorList = data.vendors || [];
      APP.materialList = data.materials || [];
    }
  } catch (err) { /* keep existing lists */ }
}

const DB_NAME = 'digitaldc';
const STORE = 'records';

// ── IndexedDB (local cache of saved records, for offline viewing) ──
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPutRecord(rec) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbAllRecords() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => (b.captured_at || '').localeCompare(a.captured_at || '')));
    req.onerror = () => reject(req.error);
  });
}

// ── Boot ──
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('site-label').textContent = APP.site ? `Site: ${APP.site}` : 'Tap ⚙️ Site to set your site';
  APP.records = await dbAllRecords();
  fetchLists(); // don't block first paint on this
  renderCapture();
});

function showTab(name) {
  ['capture', 'ledger', 'settings'].forEach(t => document.getElementById(`tab-${t}`).classList.toggle('active', t === name));
  if (name === 'capture') renderCapture();
  if (name === 'ledger') renderLedger();
  if (name === 'settings') renderSettings();
}

// ── Capture view ──
function renderCapture() {
  const main = document.getElementById('view-capture');
  if (APP.draft && APP.draft.fields) { renderConfirm(); return; }
  if (APP.draft) { main.innerHTML = `<div class="card"><img id="preview" src="${APP.draft.photoDataUrl}"><div class="status-row"><div class="spinner"></div> Reading the chit…</div></div>`; return; }
  main.innerHTML = `
    <div class="card">
      <label style="margin-top:0;">Photograph the delivery challan</label>
      <div class="capture-zone" onclick="document.getElementById('file-input').click()">
        <span class="icon">📷</span>
        Tap to open camera
      </div>
      <input type="file" id="file-input" accept="image/*" capture="environment" onchange="onPhotoChosen(event)">
    </div>
  `;
}

async function onPhotoChosen(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeToDataUrl(file, 1600, 0.82);
    APP.draft = { photoDataUrl: dataUrl, fields: null, confidence: {} };
    extractFields(dataUrl); // draws its own loading state, then the confirm screen once fields land
  } catch (err) {
    alert('Could not read that photo: ' + (err.message || err) + '\nTry taking the photo again.');
  }
}

function resizeToDataUrl(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.onload = () => {
      let { width, height } = img;
      const ratio = Math.min(1, maxSide / Math.max(width, height));
      width = Math.round(width * ratio); height = Math.round(height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    }; img.onerror = reject; img.src = reader.result; };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Extraction (server-side call, keeps the API key off the client) ──
async function extractFields(dataUrl) {
  const main = document.getElementById('view-capture');
  main.innerHTML = `
    <div class="card">
      <img id="preview" src="${dataUrl}">
      <div class="status-row"><div class="spinner"></div> Reading the chit…</div>
    </div>
  `;
  try {
    const [res] = await Promise.all([
      fetch(APP.scriptUrl, { method: 'POST', body: JSON.stringify({ action: 'extract', image: dataUrl }) }),
      fetchLists(), // refresh so anything added since the last capture is selectable
    ]);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    APP.draft.fields = normalizeFields(data);
    APP.draft.confidence = data.field_confidence || {};
  } catch (err) {
    // Extraction failed (offline, or the model choked) — don't lose the photo.
    // Drop into the confirm screen with everything blank so it can be filled by hand.
    APP.draft.fields = normalizeFields({});
    APP.draft.extractError = err.message || 'Could not read the chit automatically — fill it in below.';
  }
  renderConfirm();
}

function normalizeFields(data) {
  return {
    date: data.date || new Date().toISOString().slice(0, 10),
    dc_number: data.dc_number || '',
    vendor: data.vendor || '',
    vehicle_no: data.vehicle_no || '',
    site_address: data.site_address || APP.site || '',
    materials: (data.materials && data.materials.length ? data.materials : [{ name: '', qty: '', unit: '' }]),
  };
}

// ── Confirm view ──
function renderConfirm() {
  const main = document.getElementById('view-capture');
  const f = APP.draft.fields;
  const conf = APP.draft.confidence || {};
  const flag = (key) => (conf[key] === 'low') ? '<div class="conf-flag">⚠ low confidence — check this against the photo</div>' : '';
  const cls = (key) => (conf[key] === 'low') ? 'conf-low' : '';

  main.innerHTML = `
    <div class="card">
      <img id="preview" src="${APP.draft.photoDataUrl}">
      ${APP.draft.extractError ? `<div class="status-row" style="color:var(--warn);">⚠ ${APP.draft.extractError}</div>` : ''}

      <label>Date</label>
      <input type="date" id="f-date" value="${f.date}">

      <label>Vendor / supplier</label>
      ${pickOrAddHtml('f-vendor', APP.vendorList, f.vendor, cls('vendor'))}
      ${flag('vendor')}

      <label>Vehicle no.</label>
      <input type="text" id="f-vehicle" class="${cls('vehicle_no')}" value="${escapeHtml(f.vehicle_no)}" placeholder="MH12AB1234">
      ${flag('vehicle_no')}

      <label>DC / challan no.</label>
      <input type="text" id="f-dcnum" value="${escapeHtml(f.dc_number)}">

      <label>Site address</label>
      <input type="text" id="f-site" value="${escapeHtml(f.site_address)}">

      <label>Materials</label>
      <div id="mat-rows"></div>
      <button type="button" class="mat-add" onclick="addMatRow()">＋ Add material line</button>

      <div class="btn-row">
        <button class="btn btn-primary" id="save-btn" onclick="saveDraft()">Save challan</button>
        <button class="btn btn-secondary" onclick="discardDraft()">Discard & retake</button>
      </div>
    </div>
  `;
  renderMatRows();
}

function renderMatRows() {
  const wrap = document.getElementById('mat-rows');
  const conf = (APP.draft.confidence.materials || []);
  wrap.innerHTML = APP.draft.fields.materials.map((m, i) => `
    <div class="mat-row">
      <div>${pickOrAddHtml(`mat-${i}-name`, APP.materialList, m.name, conf[i] === 'low' ? 'conf-low' : '')}</div>
      <input type="text" id="mat-${i}-qty" placeholder="Qty" value="${escapeHtml(m.qty)}">
      <input type="text" id="mat-${i}-unit" placeholder="Unit" value="${escapeHtml(m.unit || '')}">
      <button type="button" class="mat-remove" onclick="removeMatRow(${i})">✕</button>
    </div>
  `).join('');
}
function addMatRow() { syncMatRowsFromDom(); APP.draft.fields.materials.push({ name: '', qty: '', unit: '' }); renderMatRows(); }
function removeMatRow(i) {
  syncMatRowsFromDom();
  APP.draft.fields.materials.splice(i, 1);
  if (!APP.draft.fields.materials.length) APP.draft.fields.materials.push({ name: '', qty: '', unit: '' });
  renderMatRows();
}

// Re-render (add/remove a row, or save) replaces mat-rows' HTML from
// APP.draft.fields.materials -- so anything typed since the last render has
// to be pulled back into that array first, or it's lost.
function syncMatRowsFromDom() {
  APP.draft.fields.materials.forEach((m, i) => {
    if (!document.getElementById(`mat-${i}-qty`)) return; // not rendered (shouldn't happen, but don't crash)
    m.name = getPickOrAddValue(`mat-${i}-name`);
    m.qty = document.getElementById(`mat-${i}-qty`).value;
    m.unit = document.getElementById(`mat-${i}-unit`).value;
  });
}

// ── "Pick from list, or add new" control shared by vendor + each material row ──
// Renders a <select> of known names plus "Add new", and a text input that
// only shows once "Add new" is chosen -- so nothing is ever silently mapped;
// a name is either an exact pick from what's already confirmed, or a fresh
// one someone is explicitly typing in right now.
function pickOrAddHtml(id, list, currentValue, extraClass) {
  const trimmed = (currentValue || '').trim();
  const match = list.find(v => v.toLowerCase() === trimmed.toLowerCase());
  const isNew = !match;
  const options = list.map(v => `<option value="${escapeHtml(v)}" ${v === match ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
  const select = list.length ? `
    <select id="${id}-select" class="${extraClass || ''}" onchange="onPickChange('${id}')">
      ${options}
      <option value="__new__" ${isNew ? 'selected' : ''}>＋ Add new…</option>
    </select>` : '';
  return `
    ${select}
    <input type="text" id="${id}-new" placeholder="${list.length ? 'New name' : 'Type name (first time — starts the list)'}"
      value="${escapeHtml(isNew ? trimmed : '')}" class="${extraClass || ''}"
      style="${list.length && !isNew ? 'display:none;' : ''}margin-top:${list.length ? '6px' : '0'};">
  `;
}
function onPickChange(id) {
  const sel = document.getElementById(`${id}-select`);
  const newInput = document.getElementById(`${id}-new`);
  newInput.style.display = sel.value === '__new__' ? 'block' : 'none';
  if (sel.value === '__new__') newInput.focus();
}
function getPickOrAddValue(id) {
  const sel = document.getElementById(`${id}-select`);
  if (sel && sel.value !== '__new__') return sel.value;
  const newInput = document.getElementById(`${id}-new`);
  return newInput ? newInput.value.trim() : '';
}

function discardDraft() { APP.draft = null; renderCapture(); }

async function saveDraft() {
  const vendor = getPickOrAddValue('f-vendor');
  if (!vendor) { alert('Pick or type a vendor name before saving.'); return; }
  syncMatRowsFromDom();
  const materials = APP.draft.fields.materials.filter(m => m.name.trim());
  if (!materials.length) { alert('Add at least one material before saving.'); return; }

  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const rec = {
    id: 'DC-' + Date.now(),
    date: document.getElementById('f-date').value,
    dc_number: document.getElementById('f-dcnum').value,
    vendor: vendor,
    vehicle_no: document.getElementById('f-vehicle').value,
    site_address: document.getElementById('f-site').value,
    materials: materials,
    photo: APP.draft.photoDataUrl,
    captured_by: APP.capturedBy || 'unknown',
    captured_at: new Date().toISOString(),
    confirmed_at: new Date().toISOString(),
    sync_status: 'queued',
  };

  await dbPutRecord(rec);
  APP.records.unshift(rec);

  try {
    const res = await fetch(APP.scriptUrl, { method: 'POST', body: JSON.stringify({ action: 'save', record: rec }) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    rec.sync_status = 'synced';
    await dbPutRecord(rec);
    fetchLists(); // pick up any name just added, for the next capture
  } catch (err) {
    // Stays 'queued' in IndexedDB — synced next time saveDraft or a future sync-retry runs successfully.
    // (Phase 2 adds a background retry; for now it's visible as "queued" in the ledger.)
  }

  APP.draft = null;
  showTab('ledger');
  toast(rec.sync_status === 'synced' ? 'Challan saved' : 'Saved — will sync when online');
}

// ── Ledger view ──
function renderLedger() {
  const main = document.getElementById('view-capture');
  if (!APP.records.length) {
    main.innerHTML = `<div class="empty"><p>No challans saved yet.<br>Tap 📷 Capture to log the first one.</p></div>`;
    return;
  }
  main.innerHTML = `<div class="card">` + APP.records.map(r => `
    <div class="rec">
      <div class="rec-top">
        <span>${escapeHtml(r.vendor) || '(vendor not entered)'}</span>
        <span class="pill pill-${r.sync_status === 'synced' ? 'synced' : 'queued'}">${r.sync_status}</span>
      </div>
      <div class="rec-date">${r.date} · ${escapeHtml(r.vehicle_no) || 'no vehicle no.'}</div>
      <div class="rec-mats">${r.materials.map(m => `${escapeHtml(m.name)} (${escapeHtml(m.qty)}${m.unit ? ' ' + escapeHtml(m.unit) : ''})`).join(', ')}</div>
    </div>
  `).join('') + `</div>`;
}

// ── Settings view ──
function renderSettings() {
  const main = document.getElementById('view-capture');
  main.innerHTML = `
    <div class="card">
      <label style="margin-top:0;">Your name</label>
      <input type="text" id="s-user" value="${escapeHtml(APP.capturedBy)}">
      <label>Site</label>
      <input type="text" id="s-site" value="${escapeHtml(APP.site)}" placeholder="e.g. Platform Square">
      <div class="btn-row"><button class="btn btn-primary" onclick="saveSettings()">Save</button></div>
    </div>
  `;
}
function saveSettings() {
  APP.capturedBy = document.getElementById('s-user').value;
  APP.site = document.getElementById('s-site').value;
  localStorage.setItem('digitaldc_user', APP.capturedBy);
  localStorage.setItem('digitaldc_site', APP.site);
  document.getElementById('site-label').textContent = APP.site ? `Site: ${APP.site}` : 'Tap ⚙️ Site to set your site';
  showTab('capture');
  toast('Settings saved');
}

// Brief on-screen confirmation — saves switch tabs right after completing,
// so without this a successful save and a silent failure looked identical.
function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:74px;transform:translateX(-50%);background:#1b2a44;color:#fff;padding:10px 18px;border-radius:20px;font-size:13.5px;font-weight:600;z-index:20;opacity:0;transition:opacity .2s;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.opacity = '1';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

function escapeHtml(s) { return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
