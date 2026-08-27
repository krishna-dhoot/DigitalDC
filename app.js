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

const EXTRACT_TIMEOUT_MS = 40000;

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
    let res;
    try {
      [res] = await Promise.all([
        fetch(APP.scriptUrl, { method: 'POST', body: JSON.stringify({ action: 'extract', image: dataUrl }), signal: controller.signal }),
        fetchLists(), // refresh so anything added since the last capture is selectable
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    APP.draft.fields = normalizeFields(data);
    APP.draft.confidence = data.field_confidence || {};
    APP.draft.extractError = null;
  } catch (err) {
    // Extraction failed (offline, timed out, or the model/server choked) --
    // don't lose the photo. Drop into the confirm screen with blank fields
    // to fill by hand, but keep the photo so "Retry" doesn't need a retake.
    APP.draft.fields = normalizeFields({});
    APP.draft.extractError = err.name === 'AbortError'
      ? 'Timed out reading the chit — the connection may be slow. Fill it in below, or retry.'
      : (err.message || 'Could not read the chit automatically — fill it in below.');
  }
  renderConfirm();
}

function normalizeFields(data) {
  return {
    date: data.date || new Date().toISOString().slice(0, 10),
    dc_number: data.dc_number || '',
    vendor: data.vendor || '',        // raw handwritten text -- shown as a hint only, never pre-filled as a value
    vendor_match: data.vendor_match || '', // exact existing-list entry, only if the model was confident
    vehicle_no: data.vehicle_no || '',
    site_address: data.site_address || APP.site || '',
    materials: (data.materials && data.materials.length ? data.materials : [{ name: '', match: '', qty: '', unit: '' }]),
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
      ${APP.draft.extractError ? `
        <div class="status-row" style="color:var(--warn);">⚠ ${escapeHtml(APP.draft.extractError)}</div>
        <button type="button" class="btn btn-secondary" style="margin-bottom:14px;" onclick="retryExtraction()">↻ Retry reading this photo</button>
      ` : ''}

      <label>Date</label>
      <input type="date" id="f-date" value="${f.date}">

      <label>Vendor / supplier</label>
      ${pickOrAddHtml('f-vendor', APP.vendorList, f.vendor_match, f.vendor, cls('vendor'))}
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
  const materialNames = APP.materialList.map(m => m.name);
  wrap.innerHTML = APP.draft.fields.materials.map((m, i) => `
    <div class="mat-row">
      <div>${pickOrAddHtml(`mat-${i}-name`, materialNames, m.match, m.name, conf[i] === 'low' ? 'conf-low' : '', `onMaterialPicked(${i})`)}</div>
      <input type="text" id="mat-${i}-qty" placeholder="Qty" value="${escapeHtml(m.qty)}">
      <input type="text" id="mat-${i}-unit" placeholder="Unit" value="${escapeHtml(m.unit || '')}">
      <button type="button" class="mat-remove" onclick="removeMatRow(${i})">✕</button>
    </div>
  `).join('');
  // Autofill also applies when a row starts out pre-matched (extraction was
  // confident) -- the select's onchange doesn't fire just from being
  // pre-selected in markup, so trigger it explicitly here.
  APP.draft.fields.materials.forEach((m, i) => onMaterialPicked(i));
}

// Picking a known material pre-fills its remembered unit (from the
// Materials sheet), so unit doesn't need retyping every time the same
// material comes up -- but only into an empty box, never overwriting
// something already typed for this row.
function onMaterialPicked(i) {
  const unitInput = document.getElementById(`mat-${i}-unit`);
  if (!unitInput || unitInput.value.trim()) return;
  const name = getPickOrAddValue(`mat-${i}-name`);
  const entry = APP.materialList.find(m => m.name === name);
  if (entry && entry.unit) unitInput.value = entry.unit;
}
function addMatRow() { syncMatRowsFromDom(); APP.draft.fields.materials.push({ name: '', match: '', qty: '', unit: '' }); renderMatRows(); }
function removeMatRow(i) {
  syncMatRowsFromDom();
  APP.draft.fields.materials.splice(i, 1);
  if (!APP.draft.fields.materials.length) APP.draft.fields.materials.push({ name: '', match: '', qty: '', unit: '' });
  renderMatRows();
}

// Re-render (add/remove a row, or save) replaces mat-rows' HTML from
// APP.draft.fields.materials -- so anything typed since the last render has
// to be pulled back into that array first, or it's lost. Once synced, m.name
// holds whatever the person actually picked/typed; m.match (the model's
// suggestion, if any) has done its job and isn't used again.
function syncMatRowsFromDom() {
  APP.draft.fields.materials.forEach((m, i) => {
    if (!document.getElementById(`mat-${i}-qty`)) return; // not rendered (shouldn't happen, but don't crash)
    m.name = getPickOrAddValue(`mat-${i}-name`);
    m.match = '';
    m.qty = document.getElementById(`mat-${i}-qty`).value;
    m.unit = document.getElementById(`mat-${i}-unit`).value;
  });
}

// ── "Pick from list, or add new" control shared by vendor + each material row ──
// matchedValue: an exact existing-list entry, only when extraction was
// confident it's the same vendor/material -- this alone gets preselected.
// rawText: what was actually handwritten, shown only as a read-only hint so
// staff can tell what they're matching against -- never used to fill the
// "Add new" box. Without a confident match, nothing is preselected and
// nothing is pre-typed: picking the right list entry, or explicitly choosing
// "Add new" and typing it, is a deliberate action every time.
function pickOrAddHtml(id, list, matchedValue, rawText, extraClass, onChangeExtra) {
  const matched = list.find(v => v === matchedValue) || null;
  const hint = (rawText || '').trim();
  const options = list.map(v => `<option value="${escapeHtml(v)}" ${v === matched ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
  const select = list.length ? `
    <select id="${id}-select" class="${extraClass || ''}" onchange="onPickChange('${id}');${onChangeExtra || ''}">
      <option value="" ${matched ? '' : 'selected'} disabled>${matched ? '' : '— Select —'}</option>
      ${options}
      <option value="__new__">＋ Add new…</option>
    </select>` : '';
  // The "Add new" text box only opens once someone explicitly picks that
  // option from the dropdown (see onPickChange) -- except when the list is
  // still empty and there's no dropdown to pick it from.
  return `
    ${select}
    <input type="text" id="${id}-new" placeholder="${list.length ? 'New name' : 'Type name (first time — starts the list)'}"
      value="" class="${extraClass || ''}"
      style="${list.length ? 'display:none;' : ''}margin-top:${list.length ? '6px' : '0'};">
    ${hint ? `<div class="conf-flag" style="color:var(--ink-soft);">As written: "${escapeHtml(hint)}"</div>` : ''}
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
  if (sel && sel.value && sel.value !== '__new__') return sel.value;
  const newInput = document.getElementById(`${id}-new`);
  return newInput ? newInput.value.trim() : '';
}

function discardDraft() { APP.draft = null; renderCapture(); }

// Re-runs extraction against the photo already in hand -- no retake needed.
// This is the fix for a flaky connection: retrying costs one more request,
// not another trip back to the delivery to re-photograph the chit.
function retryExtraction() {
  extractFields(APP.draft.photoDataUrl);
}

async function saveDraft() {
  const vendor = getPickOrAddValue('f-vendor');
  if (!vendor) { alert('Pick or type a vendor name before saving.'); return; }
  syncMatRowsFromDom();
  const abandoned = APP.draft.fields.materials.some(m => !m.name.trim() && (m.qty.trim() || m.unit.trim()));
  if (abandoned) { alert('One of the material rows has a quantity but no material picked — select or add its name (or remove the row) before saving.'); return; }
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
