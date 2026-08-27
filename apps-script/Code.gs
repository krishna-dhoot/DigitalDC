/**
 * DigitalDC — Apps Script backend
 *
 * Deploy: Extensions > Apps Script in a Google Sheet, paste this in, then
 * Deploy > New deployment > Web app (Execute as: Me, Access: Anyone with the link).
 * Copy the resulting /exec URL into app.js as APP.scriptUrl.
 *
 * Setup (one-time):
 *   1. Project Settings > Script Properties > add ANTHROPIC_API_KEY = <your key>.
 *   2. Create a Google Drive folder for challan photos, put its ID in DRIVE_FOLDER_ID below
 *      (or leave blank to auto-create one named "DigitalDC Photos" on first run).
 *   3. This script writes rows to a sheet named "Challans" in the bound spreadsheet,
 *      creating it with headers on first run if it doesn't exist.
 *   4. "Vendors" and "Materials" sheet tabs are auto-created empty on first use.
 *      Staff pick from these lists on the confirm screen, or add a new entry if
 *      theirs isn't there yet — a new entry is appended to the sheet on save, so
 *      the lists grow only from names someone has actually confirmed, never from
 *      the model's own guess. You can also edit these tabs by hand any time.
 */

const DRIVE_FOLDER_ID = ''; // optional: paste a Drive folder ID, or leave blank to auto-create
const SHEET_NAME = 'Challans';
const VENDORS_SHEET_NAME = 'Vendors';
const MATERIALS_SHEET_NAME = 'Materials';
const CLAUDE_MODEL = 'claude-sonnet-5';

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ error: 'Bad request body' });
  }

  try {
    if (body.action === 'extract') return jsonOut(extractFromImage(body.image));
    if (body.action === 'save') return jsonOut(saveRecord(body.record));
    if (body.action === 'lists') return jsonOut(getLists());
    return jsonOut({ error: 'Unknown action: ' + body.action });
  } catch (err) {
    return jsonOut({ error: err.message || String(err) });
  }
}

// GET is used for the lists refresh (cheap, no body needed).
function doGet(e) {
  try {
    if (e.parameter.action === 'lists') return jsonOut(getLists());
    return jsonOut({ error: 'Unknown action' });
  } catch (err) {
    return jsonOut({ error: err.message || String(err) });
  }
}

function getLists() {
  return { vendors: readNameList(VENDORS_SHEET_NAME), materials: readNameList(MATERIALS_SHEET_NAME) };
}

// ── Extraction: send the photo to Claude, get structured fields back ──
// Extraction reads the chit as handwritten — it does NOT try to match against
// the vendor/material lists. That matching (and the choice to add a genuinely
// new name) is a confirm-screen decision a person makes, not something the
// model silently resolves.
function extractFromImage(dataUrl) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');

  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Invalid image data');
  const mediaType = match[1];
  const base64 = match[2];

  const schema = {
    name: 'delivery_challan',
    description: 'Structured fields extracted from a handwritten construction delivery challan photo.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date on the chit, as YYYY-MM-DD. Guess the year from context if only DD/MM is legible.' },
        dc_number: { type: 'string', description: 'The printed or stamped serial number of the chit.' },
        vendor: { type: 'string', description: 'Supplier/vendor name exactly as handwritten.' },
        vehicle_no: { type: 'string', description: 'Vehicle registration number as handwritten.' },
        site_address: { type: 'string', description: 'Site name/address as handwritten.' },
        materials: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Material name exactly as handwritten.' },
              qty: { type: 'string' },
              unit: { type: 'string' },
            },
            required: ['name'],
          },
        },
        field_confidence: {
          type: 'object',
          description: 'Per-field confidence: "low" for anything illegible or guessed, omit otherwise. Also include a "materials" array of per-row confidence ("low"/omit) aligned by index.',
        },
      },
      required: ['materials'],
    },
  };

  const payload = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    tools: [schema],
    tool_choice: { type: 'tool', name: 'delivery_challan' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'Extract this construction delivery challan into the delivery_challan tool, exactly as handwritten -- do not standardize or guess a "proper" name for the vendor or any material, just transcribe what is written. It is a printed pad with Marathi field labels and handwritten English/Marathi answers. Flag anything illegible or ambiguous with low confidence rather than guessing silently.' },
      ],
    }],
  };

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const status = res.getResponseCode();
  const data = JSON.parse(res.getContentText());
  if (status !== 200) throw new Error((data.error && data.error.message) || 'Claude API error ' + status);

  const toolUse = (data.content || []).find(c => c.type === 'tool_use');
  if (!toolUse) throw new Error('Model did not return structured data');
  return toolUse.input;
}

// ── Save: append row to the sheet, store the photo in Drive, grow the lists ──
function saveRecord(rec) {
  if (!rec || !rec.id) throw new Error('Missing record');

  const photoUrl = savePhoto(rec.id, rec.photo);

  const sheet = getOrCreateSheet();
  sheet.appendRow([
    rec.id,
    rec.date,
    rec.dc_number,
    rec.vendor,
    rec.vehicle_no,
    rec.site_address,
    JSON.stringify(rec.materials),
    photoUrl,
    rec.captured_by,
    rec.captured_at,
    rec.confirmed_at,
  ]);

  // Only the names a person actually confirmed on save go into the lists --
  // this is how the (initially empty) Vendors/Materials tabs grow over time.
  ensureInList(VENDORS_SHEET_NAME, rec.vendor);
  (rec.materials || []).forEach(m => ensureInList(MATERIALS_SHEET_NAME, m.name));

  return { ok: true, id: rec.id, photo_url: photoUrl };
}

function savePhoto(id, dataUrl) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return '';
  const blob = Utilities.newBlob(Utilities.base64Decode(match[2]), match[1], id + '.jpg');
  const folder = getOrCreateFolder();
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function getOrCreateFolder() {
  if (DRIVE_FOLDER_ID) return DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const name = 'DigitalDC Photos';
  const existing = DriveApp.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : DriveApp.createFolder(name);
}

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['ID', 'Date', 'DC Number', 'Vendor', 'Vehicle No', 'Site', 'Materials (JSON)', 'Photo URL', 'Captured By', 'Captured At', 'Confirmed At']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ── Vendors / Materials lists — start empty, grow only from confirmed saves ──
function getOrCreateListSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(['Name']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readNameList(sheetName) {
  const sheet = getOrCreateListSheet(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 1).getValues()
    .map(row => String(row[0] || '').trim())
    .filter(Boolean);
}

function ensureInList(sheetName, value) {
  const name = String(value || '').trim();
  if (!name) return;
  const sheet = getOrCreateListSheet(sheetName);
  const existing = readNameList(sheetName);
  const alreadyThere = existing.some(n => n.toLowerCase() === name.toLowerCase());
  if (!alreadyThere) sheet.appendRow([name]);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
