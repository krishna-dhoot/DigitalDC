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
};

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
  if (APP.draft) { renderConfirm(); return; }
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
  const dataUrl = await resizeToDataUrl(file, 1600, 0.82);
  APP.draft = { photoDataUrl: dataUrl, fields: null, confidence: {} };
  renderCapture();
  extractFields(dataUrl);
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
    const res = await fetch(APP.scriptUrl, {
      method: 'POST',
      body: JSON.stringify({ action: 'extract', image: dataUrl }),
    });
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
      <input type="text" id="f-vendor" class="${cls('vendor')}" value="${escapeHtml(f.vendor)}" placeholder="As written on the chit">
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
      <input type="text" placeholder="Material" value="${escapeHtml(m.name)}" oninput="APP.draft.fields.materials[${i}].name=this.value" class="${conf[i] === 'low' ? 'conf-low' : ''}">
      <input type="text" placeholder="Qty" value="${escapeHtml(m.qty)}" oninput="APP.draft.fields.materials[${i}].qty=this.value">
      <input type="text" placeholder="Unit" value="${escapeHtml(m.unit || '')}" oninput="APP.draft.fields.materials[${i}].unit=this.value">
      <button type="button" class="mat-remove" onclick="removeMatRow(${i})">✕</button>
    </div>
  `).join('');
}
function addMatRow() { APP.draft.fields.materials.push({ name: '', qty: '', unit: '' }); renderMatRows(); }
function removeMatRow(i) { APP.draft.fields.materials.splice(i, 1); if (!APP.draft.fields.materials.length) APP.draft.fields.materials.push({ name: '', qty: '', unit: '' }); renderMatRows(); }

function discardDraft() { APP.draft = null; renderCapture(); }

async function saveDraft() {
  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const rec = {
    id: 'DC-' + Date.now(),
    date: document.getElementById('f-date').value,
    dc_number: document.getElementById('f-dcnum').value,
    vendor: document.getElementById('f-vendor').value,
    vehicle_no: document.getElementById('f-vehicle').value,
    site_address: document.getElementById('f-site').value,
    materials: APP.draft.fields.materials.filter(m => m.name.trim()),
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
  } catch (err) {
    // Stays 'queued' in IndexedDB — synced next time saveDraft or a future sync-retry runs successfully.
    // (Phase 2 adds a background retry; for now it's visible as "queued" in the ledger.)
  }

  APP.draft = null;
  showTab('ledger');
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
}

function escapeHtml(s) { return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
