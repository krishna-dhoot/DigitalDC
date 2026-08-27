# DigitalDC

Photograph a delivery challan on site, get back structured data — date, materials,
quantities, vendor, vehicle number — instead of retyping a torn carbon-copy chit
by hand. Standalone from the procurement app; see the [architecture note](https://claude.ai/code/artifact/b9cb16b6-3100-42aa-8c6c-9e6882a12f24)
for the full design.

**Phase 1** (this build): capture → confirm → save. No offline queue yet — a
network connection is needed at extraction time, but a photo is never lost:
if extraction fails, the confirm screen still opens with blank fields to fill
in by hand.

## Setup

### 1. Backend (Google Apps Script)

1. Create a new Google Sheet (this becomes the "Challans" ledger).
2. Extensions → Apps Script. Delete the default code, paste in `apps-script/Code.gs`.
3. Project Settings (gear icon) → Script Properties → add:
   - `ANTHROPIC_API_KEY` = your Claude API key ([console.anthropic.com](https://console.anthropic.com))
4. Deploy → New deployment → type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone with the link**
5. Copy the deployment's `/exec` URL.

### 2. Client

1. Open `app.js`, set `APP.scriptUrl` to the `/exec` URL from step above.
2. Host `index.html`, `app.js`, `manifest.json` anywhere static (GitHub Pages works —
   Settings → Pages → deploy from this branch).
3. Open the page on a phone, "Add to Home Screen" for an installable app.
4. On first open, tap ⚙️ Site and set your name and site name.

## How it works

- **Capture**: opens the phone camera directly, compresses the photo client-side.
- **Extract**: photo is POSTed to the Apps Script backend, which calls Claude's
  vision API server-side (keeps the API key off the client) and returns typed
  JSON: date, DC number, vendor, vehicle number, site, and a materials array.
  Low-confidence fields come back flagged and are highlighted on the confirm screen.
- **Confirm**: every field is editable — nothing saves until a person taps
  "Save challan". Materials are mapped to a standard name during extraction
  (see below) but still fully editable if the mapping is wrong.
- **Save**: record + original photo are written to the Sheet/Drive backend, and
  cached locally in IndexedDB so the ledger works even if you go straight back offline.

## Material name standardization

Handwritten material names vary a lot ("Bricks tukda", "brick bat", "toda
bricks" — all the same item). Extraction maps each line to the closest entry
in `MATERIAL_CATALOG` (top of `Code.gs`) and uses that as the material name;
the original handwritten text is kept alongside it as `raw_text` in the saved
record (visible in the Sheet's Materials JSON column) so nothing written on
the chit is lost even though the UI only shows the mapped name.

To edit the list: open `Code.gs` in the Apps Script editor, edit the
`MATERIAL_CATALOG` array, save, then **Deploy → Manage deployments → Edit →
New version** (saving alone does not update the live `/exec` endpoint).
No client changes needed.

## Next phases

- **Phase 2**: offline capture queue (IndexedDB) with background sync retry —
  right now a failed save stays `queued` locally but needs the ledger reopened
  online to retry; Phase 2 makes that automatic.
- **Phase 3**: searchable ledger (by site/vendor/date), CSV export.
- **Phase 4**: optional cross-reference against procurement app PO numbers.
