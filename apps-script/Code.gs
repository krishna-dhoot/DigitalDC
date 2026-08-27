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
 */

const DRIVE_FOLDER_ID = ''; // optional: paste a Drive folder ID, or leave blank to auto-create
const SHEET_NAME = 'Challans';
const CLAUDE_MODEL = 'claude-sonnet-5';

// Standard material names — handwritten material names on the chit (however
// they're spelled/abbreviated) get mapped to one of these during extraction,
// so "Bricks tukda", "brick bat", "toda bricks" etc. all land as the same
// name in the ledger instead of each spelling being its own item. Edit this
// list freely; it's read fresh on every extraction call, no redeploy of the
// mapping logic needed — just save the script.
const MATERIAL_CATALOG = [
  'Cement (OPC)', 'Cement (PPC)', 'Sand (River)', 'Sand (Crush/M-Sand)',
  'Aggregate 10mm', 'Aggregate 20mm', 'Aggregate 40mm',
  'Bricks (Full)', 'Broken Brick Pieces', 'AAC Blocks', 'Fly Ash Bricks',
  'Steel (TMT Bar)', 'Steel (Binding Wire)', 'Cement Blocks',
  'RMC (Ready Mix Concrete)', 'Water',
  'Plywood', 'Timber/Wood', 'Shuttering Material',
  'Tiles (Floor)', 'Tiles (Wall)', 'Granite', 'Marble',
  'PVC Pipe', 'GI Pipe', 'CPVC Pipe', 'Electrical Conduit', 'Electrical Wire/Cable',
  'Paint', 'Primer', 'Putty', 'Waterproofing Chemical',
  'Glass', 'Aluminium Section', 'MS Angle/Channel', 'Hardware/Fasteners',
  'Bitumen', 'Gravel/Murum', 'Soil (Filling)',
];

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
    return jsonOut({ error: 'Unknown action: ' + body.action });
  } catch (err) {
    return jsonOut({ error: err.message || String(err) });
  }
}

// ── Extraction: send the photo to Claude, get structured fields back ──
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
        vendor: { type: 'string', description: 'Supplier/vendor name as handwritten.' },
        vehicle_no: { type: 'string', description: 'Vehicle registration number as handwritten.' },
        site_address: { type: 'string', description: 'Site name/address as handwritten.' },
        materials: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The closest matching name from the provided standard materials list. Only fall back to the handwritten text verbatim if nothing in the list is a reasonable match.' },
              raw_text: { type: 'string', description: 'The material exactly as handwritten on the chit, unedited — kept for audit even when name above is a mapped standard name.' },
              qty: { type: 'string' },
              unit: { type: 'string' },
            },
            required: ['name', 'raw_text'],
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
        { type: 'text', text: 'Extract this construction delivery challan into the delivery_challan tool. It is a printed pad with Marathi field labels and handwritten English/Marathi answers. Flag anything illegible or ambiguous with low confidence rather than guessing silently.\n\n'
          + 'For each material line, map the handwritten item to the closest match in this standard materials list, and use that standard name as "name" (keep the handwritten text verbatim in "raw_text" regardless):\n'
          + MATERIAL_CATALOG.join(', ')
          + '\n\nOnly use the handwritten text as-is for "name" if none of the above is a reasonable match (e.g. a material genuinely not on the list) — do not force a bad match. If the mapping is uncertain, flag that material row low confidence.' },
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

// ── Save: append row to the sheet, store the photo in Drive ──
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

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
