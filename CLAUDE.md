# AI Sprawl Map — build brief

A prospect-facing diagnostic tool by Kaara. A CTO pastes their AI/automation/data
initiatives (one per line). The tool clusters them by problem domain, detects
duplicated capabilities, missing connections, and shared-data collisions, then
renders a "fragmentation map" plus a findings list. It ends in a lead-capture
funnel (team brief + book a working session).

## Stack
- Backend: FastAPI + SQLite (local), Python 3.11+
- Frontend: React + Vite + plain CSS (dark terminal aesthetic, red #E5342A accent, mono headers)
- Analysis: HYBRID. Rules engine runs first and always. LLM (Anthropic API) is a
  fallback: it classifies lines the rules can't, and writes narrative prose.
  Everything must still render with no ANTHROPIC_API_KEY set.

## Analysis contract
Input: list of freeform initiative strings.
Output JSON:
{
  "diagnostic_id": "SM-XXXXXX",
  "run_at": "ISO ts",
  "status": "FRAGMENTED | CONNECTED",
  "initiatives": [{ "raw", "domain", "capability", "system_label" }],
  "counts": { "initiatives", "problem_domains", "independent_data_touches", "rebuilt_capabilities" },
  "graph": { "nodes": [...], "missing_edges": [{from,to,label}], "missing_layer": bool },
  "summary": "portfolio summary prose",
  "key_observation": "prose",
  "findings": [{ "type": "DUPLICATED|SHARED|MISSING", "title", "detail" }],
  "closing": "prose stat sentence"
}

### Rules layer (deterministic, no API)
Keyword maps -> problem domain and capability. Suggested seeds:
- fraud / anomaly / risk score      -> domain: fraud,      cap: anomaly_detection
- kyc / identity / onboarding / doc -> domain: identity,   cap: doc_parsing
- loan / underwriting / lending     -> domain: lending,    cap: doc_parsing (if parses docs)
- chatbot / support / contact       -> domain: support,    cap: conversational
- aml / compliance / monitoring     -> domain: compliance, cap: anomaly_detection
- analytics / copilot / warehouse   -> domain: analytics,  cap: bi_query
Derive findings deterministically:
- capability counted >=2 times      -> DUPLICATED finding
- >=2 systems touching same data ent-> SHARED finding
- known cross-domain gaps (fraud->lending, fraud->support, etc.) -> MISSING edges + findings
- always emit "no shared feature/signal bus" MISSING layer

### LLM fallback (only when key present)
1. Any line the rules score below confidence threshold -> ask Claude to classify
   into the fixed taxonomy above (return strict JSON, no prose).
2. Generate `summary`, `key_observation`, and humanized MISSING `detail` strings.
Model: claude-sonnet-... (latest). Always wrap in try/except and degrade to
rule-generated prose on any failure.

## Funnel (full capture)
SQLite tables: runs, leads.
- POST /api/analyze -> store run, return diagnostic JSON
- POST /api/team-brief { diagnostic_id, work_email } -> store lead, generate a
  PDF-style HTML brief, "send" via logged stub, return brief
- POST /api/book-session { diagnostic_id, work_email } -> store lead, return stub confirmation
Local email = write to backend/outbox/*.txt instead of real SMTP.

## Screens (match the uploaded design)
1. Paste screen: hero "You have more AI projects than you think.", textarea,
   "Load an example stack" dropdown, "Map my portfolio" button, privacy line.
2. Loading: "Clustering by problem domain..." with dot animation.
3. Report: sticky header with diagnostic id/run/initiatives/status(FRAGMENTED),
   portfolio summary, key observation callout, the node graph with red dashed
   "missing connection" edges + a "MISSING LAYER: Shared feature and signal bus",
   4 stat cards, findings list with ALL/DUPLICATED/SHARED/MISSING filter tabs,
   closing stat sentence, "Generate team brief" + "Book working session" CTAs,
   sticky footer bar.

## Run
- backend:  cd backend && pip install -r requirements.txt && uvicorn main:app --reload --port 8000
- frontend: cd frontend && npm install && npm run dev  (proxy /api -> :8000)

## Task order for Claude Code
1. Finish backend/rules.py (the keyword maps + finding derivation).
2. Finish backend/llm.py (fallback classify + prose gen, graceful no-key).
3. Wire backend/main.py endpoints + SQLite + outbox stub.
4. Build the three React screens to match design. Graph can be SVG.
5. Seed one example stack (the 6 BFSI systems from the reference) behind the dropdown.
