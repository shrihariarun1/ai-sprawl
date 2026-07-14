# AI Sprawl Map

Local rebuild of the Kaara AI Sprawl Map. Hybrid analysis (deterministic rules +
optional Claude API), full lead-capture funnel, SQLite storage, local email outbox.

## Run

Backend:
```
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-...   # optional; omit to run rules-only
uvicorn main:app --reload --port 8000
```

Frontend:
```
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 . Click "Load an example stack" then "Map my portfolio".

## What's done vs. left for Claude Code
Done: rules engine, LLM fallback, all 3 API endpoints, SQLite + outbox, working 3-screen UI.
Left (see CLAUDE.md): the SVG node graph with red dashed missing-connection edges +
"MISSING LAYER" bar, expandable finding rows, sticky header/footer bars, PDF-style
team brief. Tune domain/data-touch constants in rules.py to match the reference
(5 domains, 7 touches).

## Data
- backend/sprawl.db  — runs + captured leads
- backend/outbox/    — "sent" emails as .txt files

## "Send me this map" (results page)
The results page's second CTA posts `{Email, Company, Source, Diagnostic ID, Timestamp}`
to a Google Sheet via Apps Script, independent of the backend/outbox above.
1. Create a Google Sheet.
2. Extensions > Apps Script, paste `google-apps-script/sheet-webhook.gs`.
3. Deploy > New deployment > Web app. Execute as: Me. Access: Anyone.
4. Copy the deployment URL into `frontend/.env`:
   `VITE_SHEET_WEBHOOK_URL=https://script.google.com/macros/s/.../exec`
Without this set, the button still works end-to-end in the UI (shows "MAP SENT")
but the submission isn't recorded anywhere — a warning is logged to the console.
