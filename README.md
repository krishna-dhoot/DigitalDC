# DigitalDC

Photograph a delivery challan on site, get back structured data — date, materials,
quantities, vendor, vehicle number — instead of retyping a torn carbon-copy chit
by hand. Standalone from the procurement app; see the [architecture note](https://claude.ai/code/artifact/b9cb16b6-3100-42aa-8c6c-9e6882a12f24)
for the full design.

**Phase 1** (this build): capture → confirm → save. No offline queue yet — a
network connection is needed at extraction time, but a photo is never lost:
if extraction fails, the confirm screen still opens with blank fields to fill
in by hand, with a **Retry** button to re-run extraction against the same
photo (no retake needed). The backend also retries transient failures (rate
limits, momentary overload) automatically before giving up, and the client
gives up after 40s rather than hanging indefinitely.

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
  "Save challan". Vendor and each material are picked from a known-good list
  rather than freely retyped (see below).
- **Save**: record + original photo are written to the Sheet/Drive backend, and
  cached locally in IndexedDB so the ledger works even if you go straight back offline.

## Vendor & material name discipline

Handwritten names vary a lot ("Bricks tukda", "brick bat", "toda bricks" —
all the same item; a vendor's name spelled three different ways across three
chits). Rather than have the model guess a "correct" spelling, the app makes
staff choose:

- Extraction transcribes the vendor and each material **exactly as
  handwritten** — no standardizing, no guessing.
- Separately, extraction is shown the current Vendors/Materials lists and
  asked to name an *existing* entry only if it's genuinely confident that's
  the same real-world vendor/material — never a best guess. If it is
  confident, that entry is preselected on the confirm screen. If not, the
  field is left unselected (no dropdown pick, nothing pre-typed into "Add
  new") — the handwritten text is shown underneath only as a reference
  ("As written: ..."), and a person has to actively pick from the dropdown
  or choose "Add new" and type it themselves.
- **Both lists start empty.** The `Vendors` and `Materials` sheet tabs are
  auto-created with no rows — they grow only from names a person actually
  confirmed on save, never from an unreviewed guess. The first few DCs will
  be all "Add new"; the lists fill in fast after that as the same vendors and
  materials repeat.
- `Materials` has a second column, **Default Unit** — the unit confirmed the
  first time a material was saved (or backfilled the first time it's saved
  *with* a unit, if the first save left it blank). Picking that material
  again auto-fills its unit, without overwriting anything already typed in
  that row.
- You can also edit the `Vendors`/`Materials` tabs by hand any time (fix a
  typo, merge a duplicate) — changes apply on the very next capture.

## Next phases

- **Phase 2**: offline capture queue (IndexedDB) with background sync retry —
  right now a failed save stays `queued` locally but needs the ledger reopened
  online to retry; Phase 2 makes that automatic.
- **Phase 3**: searchable ledger (by site/vendor/date), CSV export.
- **Phase 4**: optional cross-reference against procurement app PO numbers.
