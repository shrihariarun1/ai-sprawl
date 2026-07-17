"""FastAPI app: analyze + full capture funnel, SQLite, local outbox stub."""
import os
import json
import sqlite3
import random
import string
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import rules
import llm

DB = Path(__file__).parent / "sprawl.db"
OUTBOX = Path(__file__).parent / "outbox"
OUTBOX.mkdir(exist_ok=True)

app = FastAPI(title="AI Sprawl Map")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = db()
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS runs (
            diagnostic_id TEXT PRIMARY KEY, run_at TEXT, payload TEXT
        );
        CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            diagnostic_id TEXT, work_email TEXT, kind TEXT, created_at TEXT
        );
        """
    )
    con.commit()
    con.close()


init_db()


def new_id():
    return "SM-" + "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def now():
    return datetime.now(timezone.utc).isoformat()


class AnalyzeIn(BaseModel):
    lines: list[str]


class CaptureIn(BaseModel):
    diagnostic_id: str
    work_email: str


@app.post("/api/analyze")
def analyze(body: AnalyzeIn):
    # classify (rules), let the LLM fill unknowns, THEN derive findings —
    # so LLM-classified systems contribute evidence like any other
    items = rules.classify(body.lines)
    items = llm.classify_unknowns(items)
    part = rules.derive(items)
    diag = {
        "diagnostic_id": new_id(),
        "run_at": now(),
        "status": part["status"],
        "initiatives": part["items"],
        "counts": part["counts"],
        "graph": part["graph"],
        "findings": part["findings"],
        "sprawl_score": rules.sprawl_score(part["counts"], part["graph"]["missing_edges"]),
        "total_cost_estimate": part["total_cost_estimate"],
        "cost_disclosure": part["cost_disclosure"],
    }
    diag = llm.write_prose(diag)

    con = db()
    con.execute("INSERT INTO runs VALUES (?,?,?)",
                (diag["diagnostic_id"], diag["run_at"], json.dumps(diag)))
    con.commit()
    con.close()
    return diag


@app.get("/api/report/{diagnostic_id}")
def get_report(diagnostic_id: str):
    con = db()
    row = con.execute("SELECT payload FROM runs WHERE diagnostic_id=?", (diagnostic_id,)).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="Report not found")
    return json.loads(row["payload"])


@app.get("/api/badge/{diagnostic_id}.svg")
def get_badge(diagnostic_id: str):
    con = db()
    row = con.execute("SELECT payload FROM runs WHERE diagnostic_id=?", (diagnostic_id,)).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="Report not found")

    diag = json.loads(row["payload"])
    score = diag.get("sprawl_score", {})
    value = score.get("score", 0)
    color = score.get("color", "#94A3B8")
    suffix_x = 16 + len(str(value)) * 14 + 6

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="220" height="56" viewBox="0 0 220 56">
  <rect width="220" height="56" rx="8" fill="#0A0E1A" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="16" y="22" font-family="Inter, sans-serif" font-size="10" letter-spacing="1" fill="#94A3B8">AI SPRAWL SCORE</text>
  <text x="16" y="44" font-family="JetBrains Mono, monospace" font-size="22" font-weight="700" fill="{color}">{value}</text>
  <text x="{suffix_x}" y="44" font-family="Inter, sans-serif" font-size="13" fill="rgba(255,255,255,0.35)">/ 100</text>
</svg>"""
    return Response(content=svg, media_type="image/svg+xml")


MIN_BENCHMARK_RUNS = 5


@app.get("/api/benchmark")
def benchmark():
    con = db()
    rows = con.execute("SELECT payload FROM runs").fetchall()
    con.close()
    n = len(rows)
    if n < MIN_BENCHMARK_RUNS:
        return {"available": False, "runs": n}

    totals = {"problem_domains": 0, "rebuilt_capabilities": 0, "independent_data_touches": 0}
    for row in rows:
        counts = json.loads(row["payload"]).get("counts", {})
        for k in totals:
            totals[k] += counts.get(k, 0)

    return {
        "available": True,
        "runs": n,
        "avg_problem_domains": round(totals["problem_domains"] / n, 1),
        "avg_rebuilt_capabilities": round(totals["rebuilt_capabilities"] / n, 1),
        "avg_independent_data_touches": round(totals["independent_data_touches"] / n, 1),
    }


def _outbox(email, subject, body):
    fn = OUTBOX / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{email}.txt"
    fn.write_text(f"TO: {email}\nSUBJECT: {subject}\n\n{body}")
    print(f"[outbox] wrote {fn}")


TAG_COLORS = {"DUPLICATED": "#b07a10", "SHARED": "#b05510", "MISSING": "#c22318"}


def _brief_html(diag):
    counts = diag.get("counts", {})
    findings = diag.get("findings", [])
    stat_cells = "".join(
        f"<td><div class='n'>{counts.get(k, 0)}</div><div class='l'>{label}</div></td>"
        for k, label in [
            ("initiatives", "initiatives"),
            ("problem_domains", "problem domains"),
            ("independent_data_touches", "independent data touches"),
            ("rebuilt_capabilities", "rebuilt capabilities"),
        ]
    )
    rows = "".join(
        f"<div class='f'><span class='tag' style='color:{TAG_COLORS.get(f['type'], '#333')};"
        f"border-color:{TAG_COLORS.get(f['type'], '#333')}'>{f['type']}</span>"
        f"<div><div class='ft'>{f['title']}</div><div class='fd'>{f['detail']}</div></div></div>"
        for f in findings
    )
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>AI Sprawl Map — {diag.get('diagnostic_id', '')}</title>
<style>
body {{ font-family: Georgia, 'Times New Roman', serif; color:#1a1a1a; margin:48px 56px; line-height:1.5; }}
.mono {{ font-family: ui-monospace, 'Courier New', monospace; letter-spacing:1.5px; font-size:11px; color:#888; }}
.head {{ border-bottom:3px solid #E5342A; padding-bottom:14px; margin-bottom:28px; }}
.brand {{ color:#E5342A; font-weight:bold; font-size:22px; font-family:system-ui,sans-serif; }}
h1 {{ font-size:26px; margin:24px 0 6px; }}
.status {{ color:#E5342A; font-weight:bold; }}
.obs {{ border-left:3px solid #E5342A; background:#faf5f4; padding:14px 18px; margin:22px 0; }}
table.stats {{ width:100%; border-collapse:collapse; margin:26px 0; }}
table.stats td {{ border:1px solid #ddd; padding:14px 16px; width:25%; }}
.n {{ font-size:34px; font-weight:bold; font-family:system-ui,sans-serif; }}
.l {{ font-size:12px; color:#777; }}
.f {{ display:flex; gap:14px; border-bottom:1px solid #eee; padding:12px 0; }}
.tag {{ font-family:ui-monospace,monospace; font-size:10px; letter-spacing:1px; border:1px solid; border-radius:4px; padding:3px 8px; height:fit-content; white-space:nowrap; }}
.ft {{ font-weight:bold; font-size:14px; }}
.fd {{ font-size:13px; color:#555; }}
.closing {{ font-size:17px; font-weight:bold; margin:30px 0 8px; }}
.foot {{ margin-top:36px; padding-top:14px; border-top:1px solid #ddd; font-size:12px; color:#888; }}
</style></head><body>
<div class="head"><span class="brand">Kaara</span> <span class="mono">AI SPRAWL MAP — TEAM BRIEF</span><br>
<span class="mono">DIAGNOSTIC ID: {diag.get('diagnostic_id', '')} · RUN: {diag.get('run_at', '')[:10]} · STATUS: <span class="status">{diag.get('status', '')}</span></span></div>
<div class="mono">PORTFOLIO SUMMARY</div>
<h1>{diag.get('summary', '')}</h1>
<div class="obs"><div class="mono">KEY OBSERVATION</div><p>{diag.get('key_observation', '')}</p></div>
<table class="stats"><tr>{stat_cells}</tr></table>
<div class="mono">FINDINGS · {len(findings)}</div>
{rows}
<p class="closing">{diag.get('closing', '')}</p>
<div class="foot">Prepared by Kaara · This diagnostic is generated from the initiative list you provided. Book a working session to walk your team through it.</div>
</body></html>"""


@app.post("/api/team-brief")
def team_brief(body: CaptureIn):
    con = db()
    con.execute("INSERT INTO leads (diagnostic_id, work_email, kind, created_at) VALUES (?,?,?,?)",
                (body.diagnostic_id, body.work_email, "team-brief", now()))
    row = con.execute("SELECT payload FROM runs WHERE diagnostic_id=?",
                      (body.diagnostic_id,)).fetchone()
    con.commit()
    con.close()
    diag = json.loads(row["payload"]) if row else {}
    brief_html = _brief_html(diag)
    _outbox(body.work_email, "Your AI Sprawl Map brief",
            f"{diag.get('summary', '')}\n\n[attached: team brief {diag.get('diagnostic_id', '')}.html]")
    fn = OUTBOX / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-brief-{diag.get('diagnostic_id', 'unknown')}.html"
    fn.write_text(brief_html, encoding="utf-8")
    return {"ok": True, "brief_html": brief_html}


@app.post("/api/book-session")
def book_session(body: CaptureIn):
    con = db()
    con.execute("INSERT INTO leads (diagnostic_id, work_email, kind, created_at) VALUES (?,?,?,?)",
                (body.diagnostic_id, body.work_email, "book-session", now()))
    con.commit()
    con.close()
    _outbox(body.work_email, "Working session request received", "We'll follow up to book 20 minutes.")
    return {"ok": True, "message": "Request received. We'll follow up to find 20 minutes."}
