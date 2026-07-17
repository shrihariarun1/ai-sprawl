import { useEffect, useMemo, useRef, useState } from "react";
import SprawlField from "./SprawlField.jsx";
import ResultsCanvas from "./ResultsCanvas.jsx";

// easter egg: typing exactly this word into the textarea swaps in a stack
// of deliberately absurd "initiatives" instead of a real example
const CHAOS_TRIGGER = "chaos";
const CHAOS_STACK = [
  "blockchain-powered stapler tracker",
  "AI that reviews the other AI's commits",
  "quantum-ready email signature generator",
  "sentiment analysis for the office plant",
  "roomba fleet optimization engine",
  "GPT wrapper for the GPT wrapper",
  "excel macro rebranded as machine learning",
];

// easter egg: placeholder escalates into nonsense if the textarea sits
// empty long enough — reward for anyone lingering on the page
const PLACEHOLDER_VARIANTS = [
  "fraud detection model\nKYC document parser\ncustomer support chatbot\ninvoice OCR\n(one initiative per line)",
  "blockchain for the water cooler\nAI-powered stapler tracker\nsentiment analysis for the break room\n(one initiative per line)",
  "a chatbot for the chatbot\nGPT wrapper for another GPT wrapper\nquantum-ready expense report scanner\n(one initiative per line)",
  "\"innovation\" (undefined scope, Q3)\nroomba fleet optimization engine\nexcel macro rebranded as machine learning\n(one initiative per line)",
];

// shown until /api/benchmark reports 5+ real runs, then the real numbers take over
const PLACEHOLDER_BENCHMARK = {
  available: true, runs: 42,
  avg_problem_domains: 4.2, avg_rebuilt_capabilities: 2.3, avg_independent_data_touches: 14.6,
};

const CONFETTI_COLORS = ["#ef4444", "#ececec", "#f59e0b"];
function spawnConfetti(x, y) {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (let i = 0; i < 26; i++) {
    const el = document.createElement("span");
    el.className = "confetti-bit";
    const dx = (Math.random() - 0.5) * 240;
    const dy = (Math.random() - 0.5) * 240 - 70;
    const rot = Math.random() * 720 - 360;
    el.style.setProperty("--dx", `${dx}px`);
    el.style.setProperty("--dy", `${dy}px`);
    el.style.setProperty("--rot", `${rot}deg`);
    el.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    document.body.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }
}

function wrapCanvasText(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const STATUS_COLOR = { FRAGMENTED: "#ef4444", CONNECTED: "#10b981" };

// small decorative node-cluster motif echoing the real fragmentation map —
// solid lines between connected nodes, one dashed line for the "missing" one
// (colored red for a fragmented result, green for a connected one)
function drawShareCardMotif(ctx, x, y, accent) {
  const pts = [[0, 0], [86, -34], [150, 30], [70, 78], [10, 132]];
  const edges = [[0, 1], [1, 2], [3, 4], [0, 4]];
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = "rgba(255,255,255,.16)";
  ctx.lineWidth = 1.5;
  edges.forEach(([a, b]) => {
    ctx.beginPath();
    ctx.moveTo(pts[a][0], pts[a][1]);
    ctx.lineTo(pts[b][0], pts[b][1]);
    ctx.stroke();
  });
  ctx.strokeStyle = accent;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(pts[2][0], pts[2][1]);
  ctx.lineTo(pts[3][0], pts[3][1]);
  ctx.stroke();
  ctx.setLineDash([]);
  pts.forEach(([px, py], i) => {
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = i === 2 || i === 3 ? accent : "#c8c8d0";
    ctx.fill();
  });
  ctx.restore();
}

const HEADLINE_BY_STATUS = {
  FRAGMENTED: "Your AI portfolio is fragmented.",
  CONNECTED: "Your AI portfolio is connected.",
};

// renders a branded 1200x630 summary of a diagnostic for download/sharing
async function buildShareCardBlob(diag) {
  if (document.fonts?.ready) await document.fonts.ready;

  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext("2d");
  const mono = "'JetBrains Mono', ui-monospace, monospace";
  const sans = "'Inter', 'Segoe UI', system-ui, sans-serif";

  const accent = STATUS_COLOR[diag.status] || "#f59e0b";

  ctx.fillStyle = "#0A0E1A";
  ctx.fillRect(0, 0, 1200, 630);

  // dot-grain texture, matching the site's background treatment
  ctx.fillStyle = "rgba(255,255,255,.045)";
  for (let gx = 11; gx < 1200; gx += 22) {
    for (let gy = 11; gy < 630; gy += 22) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // soft corner glow — ambient brand accent, always amber regardless of status
  const glow = ctx.createRadialGradient(120, 60, 0, 120, 60, 520);
  glow.addColorStop(0, "rgba(245,158,11,.10)");
  glow.addColorStop(1, "rgba(245,158,11,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 1200, 630);

  ctx.fillStyle = "#f59e0b";
  ctx.fillRect(0, 0, 10, 630);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 27px ${sans}`;
  ctx.fillText("Kaara", 72, 92);
  ctx.fillStyle = "#94a3b8";
  ctx.font = `16px ${mono}`;
  ctx.fillText("AI SPRAWL MAP", 180, 92);

  ctx.fillStyle = "#7a7a86";
  ctx.font = `13px ${mono}`;
  ctx.fillText(
    `${diag.diagnostic_id} · ${new Date(diag.run_at).toISOString().slice(0, 10)} · ${diag.counts.initiatives} INITIATIVES`,
    72, 128
  );

  // status pill — red for a fragmented result, green for a connected one
  ctx.font = `700 13px ${mono}`;
  const pillLabel = diag.status;
  const pillW = ctx.measureText(pillLabel).width + 36;
  roundRectPath(ctx, 72, 144, pillW, 30, 15);
  ctx.strokeStyle = accent + "8c";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.fillText(pillLabel, 72 + 18, 164);

  ctx.fillStyle = "#ffffff";
  ctx.font = `700 46px ${sans}`;
  wrapCanvasText(ctx, HEADLINE_BY_STATUS[diag.status] || "Here's where your AI portfolio stands.", 760)
    .slice(0, 2)
    .forEach((l, j) => ctx.fillText(l, 72, 260 + j * 54));

  drawShareCardMotif(ctx, 900, 210, accent);

  const stats = [
    [diag.counts.problem_domains, "PROBLEM DOMAINS"],
    [diag.counts.rebuilt_capabilities, "REBUILT CAPABILITIES"],
    [diag.counts.independent_data_touches, "INDEPENDENT DATA TOUCHES"],
    [diag.findings.length, "FINDINGS"],
  ];
  const tileW = 252, tileH = 108, gap = 16, tileY = 356;
  stats.forEach(([n, label], i) => {
    const x = 72 + i * (tileW + gap);
    roundRectPath(ctx, x, tileY, tileW, tileH, 10);
    ctx.fillStyle = "rgba(255,255,255,.035)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.10)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#ececec";
    ctx.font = `700 38px ${sans}`;
    ctx.fillText(String(n), x + 20, tileY + 52);
    ctx.fillStyle = "#8a8a98";
    ctx.font = `11px ${mono}`;
    wrapCanvasText(ctx, label, tileW - 40).forEach((l, j) => ctx.fillText(l, x + 20, tileY + 76 + j * 15));
  });

  const topFinding = diag.findings.find((f) => f.evidence?.severity === "HIGH") || diag.findings[0];
  if (topFinding) {
    ctx.fillStyle = "#7a7a86";
    ctx.font = `12px ${mono}`;
    ctx.fillText(`TOP FINDING · ${topFinding.type}`, 72, 512);
    ctx.fillStyle = "#ececec";
    ctx.font = `600 24px ${sans}`;
    wrapCanvasText(ctx, topFinding.title, 1056).slice(0, 2).forEach((l, j) => ctx.fillText(l, 72, 542 + j * 30));
  }

  ctx.strokeStyle = "rgba(255,255,255,.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(72, 596);
  ctx.lineTo(1128, 596);
  ctx.stroke();
  ctx.fillStyle = "#7a7a86";
  ctx.font = `13px ${mono}`;
  ctx.fillText("Mapped with the Kaara AI Sprawl Map — free, in under a minute", 72, 618);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

const STACKS = {
  "Banking stack": {
    meta: "6 SYSTEMS · BFSI",
    lines: [
      "fraud detection model",
      "KYC document parser",
      "loan underwriting assistant",
      "customer support chatbot",
      "AML transaction monitoring",
      "analytics copilot",
    ],
  },
  "Insurance stack": {
    meta: "6 SYSTEMS · P&C",
    lines: [
      "claims intake document parser",
      "claims fraud scoring model",
      "policyholder support chatbot",
      "AML & sanctions screening",
      "customer churn prediction model",
      "claims analytics dashboard",
    ],
  },
  "Retail stack": {
    meta: "7 SYSTEMS · COMMERCE",
    lines: [
      "product recommendation engine",
      "demand forecasting model",
      "dynamic pricing engine",
      "customer support chatbot",
      "returns fraud detection model",
      "marketing content generator",
      "sales analytics copilot",
    ],
  },
};

// client-side mirror of the rules engine, for live domain chips + field clusters
// (the first two are an easter egg — checked before the real taxonomy)
const HINTS = [
  [/\bskynet\b/i, "self-aware (uh oh)"],
  [/\broomba\b/i, "physical + ai (bold)"],
  [/\bfraud\b|anomaly|risk score|risk model/i, "fraud"],
  [/\bkyc\b|identity|onboard/i, "identity"],
  [/underwrit|lending|\bloan\b/i, "lending"],
  [/chatbot|customer support|contact center|support/i, "support"],
  [/\baml\b|compliance|monitoring|sanction/i, "compliance"],
  [/analytic|copilot|warehouse|\bbi\b|reporting/i, "analytics"],
  [/claim/i, "claims"],
  [/\bocr\b|document pars|invoice|extract/i, "documents"],
  [/recommend|personaliz/i, "marketing"],
  [/churn|retention/i, "marketing"],
  [/marketing|content gen|copywrit|campaign/i, "marketing"],
  [/forecast|inventory|demand|pricing|\bprice\b/i, "operations"],
  [/\bthreat\b|cyber|\bsiem\b|phishing|intrusion|malware/i, "security"],
  [/recruit|hiring|resume screen|applicant track|candidate screen/i, "hr"],
];

// domain -> accent color, mirrors ResultsCanvas.jsx's DOMAIN_COLORS
const DOMAIN_COLORS = {
  fraud: "#ef4444", compliance: "#3b82f6", support: "#10b981", lending: "#f59e0b",
  analytics: "#8b5cf6", identity: "#ec4899", marketing: "#f97316", claims: "#fde047",
  documents: "#94a3b8", operations: "#06b6d4", security: "#f43f5e", hr: "#a3e635",
};

function domainOf(label) {
  const hit = HINTS.find(([re]) => re.test(label));
  return hit ? hit[1] : null;
}

function detectDomains(lines) {
  const found = [];
  let unknown = 0;
  for (const l of lines) {
    const d = domainOf(l);
    if (d) { if (!found.includes(d)) found.push(d); }
    else unknown++;
  }
  return { domains: found, unknown };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function evidenceSystems(ev) {
  if (!ev) return [];
  if (ev.from_systems || ev.to_systems)
    return [...(ev.from_systems || []), ...(ev.to_systems || [])];
  if (ev.systems) return ev.systems.map((s) => (typeof s === "string" ? s : s.label));
  return [];
}

/* ═════════════════════ RESULTS: consequence text ═════════════════════ */

function domainBlast(graph, domain) {
  return graph.nodes.filter((n) => n.domain === domain).length;
}

// the worst gap: HIGH first, widest downstream blast radius, fraud-adjacent wins ties
function rankWorstEdge(graph) {
  let worst = null, best = -1;
  graph.missing_edges.forEach((e, i) => {
    const blast = domainBlast(graph, e.to);
    const score = (e.severity === "HIGH" ? 100 : 0) + blast * 10 +
      (e.from === "fraud" || e.to === "fraud" ? 5 : 0) - i * 0.01;
    if (score > best) { best = score; worst = e; }
  });
  return worst;
}

function worstEdgeForDomain(graph, domain) {
  const touching = graph.missing_edges.filter((e) => e.from === domain || e.to === domain);
  if (!touching.length) return null;
  return [...touching].sort((a, b) => (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2))[0];
}

// display-only casing helpers — never applied to values used for matching
// (system_label lookups, domain keys), only to text as it's rendered
function toTitleCase(s) {
  return s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : s;
}
function toSentence(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function failureModeFor(diag, edge) {
  if (!edge) return "These systems make decisions without each other's signals.";
  const f = diag.findings.find((x) => x.type === "MISSING" && x.evidence &&
    x.evidence.from_domain === edge.from && x.evidence.to_domain === edge.to);
  const line = f?.evidence?.reasoning?.find((r) => r.startsWith("Failure mode:"));
  if (!line) return "These systems make decisions without each other's signals.";
  return line.replace("Failure mode: ", "").replace(/^./, (c) => c.toUpperCase()).replace(/\.?$/, ".");
}

// diagnostic (right panel): hover previews live, falls back to the pinned
// selection, falls back to the portfolio's single worst gap
function resolveDiagnostic(diag, info, defaultEdge) {
  if (!info)
    return defaultEdge
      ? { label: `${defaultEdge.from.toUpperCase()} → ${defaultEdge.to.toUpperCase()} · ${defaultEdge.severity}`, text: failureModeFor(diag, defaultEdge), active: false }
      : { label: "PORTFOLIO", text: failureModeFor(diag, defaultEdge), active: false };
  if (info.kind === "edge") {
    return {
      label: `${info.edge.from.toUpperCase()} → ${info.edge.to.toUpperCase()} · ${info.edge.severity}`,
      text: failureModeFor(diag, info.edge),
      active: true,
    };
  }
  const e = worstEdgeForDomain(diag.graph, info.domain);
  return e
    ? { label: `${info.domain.toUpperCase()} · ${e.severity}`, text: failureModeFor(diag, e), active: true }
    : { label: info.domain.toUpperCase(), text: "No missing connections touch this system directly.", active: true };
}

// audit (left panel): only updates on click/selection, so it stays put
// while the user casually hovers elsewhere — the pinned explanation
function findingForEdge(diag, edge) {
  return diag.findings.find((x) => x.type === "MISSING" && x.evidence &&
    x.evidence.from_domain === edge.from && x.evidence.to_domain === edge.to);
}
function resolveAudit(diag, selected, defaultEdge) {
  const edge = selected?.kind === "edge" ? selected.edge : !selected ? defaultEdge : null;
  if (edge) {
    const f = findingForEdge(diag, edge);
    return {
      kind: "edge",
      title: f?.title || `No live connection between ${toTitleCase(edge.from)} and ${toTitleCase(edge.to)}.`,
      sub: f ? `${f.evidence.severity} · CONFIDENCE ${f.evidence.confidence.toFixed(2)}` : "",
      trace: f?.evidence?.reasoning || [],
    };
  }
  const item = diag.initiatives.find((i) => i.system_label === selected.label);
  const findings = diag.findings.filter((f) => evidenceSystems(f.evidence).includes(selected.label));
  return {
    kind: "node",
    title: toTitleCase(selected.label),
    sub: item?.domain
      ? `${item.domain.toUpperCase()} · ${item.capability} · matched '${item.matched_on || "semantic"}' · by ${item.classified_by}`
      : "UNCLASSIFIED — no rule matched, no LLM available",
    findings,
  };
}
const FINDING_ICON = { MISSING: "●", DUPLICATED: "▲", SHARED: "▲" };

// per-initiative detail: entities touched (+ who else touches them), which
// other systems duplicate its capability, which missing edges its domain
// sits on, and a rule-based (not LLM) one-line recommendation
function buildProjectCards(diag) {
  const classified = diag.initiatives.filter((i) => i.domain);

  const byCapability = {};
  classified.forEach((i) => { (byCapability[i.capability] ||= []).push(i.system_label); });

  const byEntity = {};
  classified.forEach((i) => (i.entities || []).forEach((e) => { (byEntity[e] ||= []).push(i.system_label); }));

  const edgesByDomain = {};
  (diag.graph.missing_edges || []).forEach((e) => {
    (edgesByDomain[e.from] ||= []).push(e);
    (edgesByDomain[e.to] ||= []).push(e);
  });

  return classified.map((i) => {
    const entities = (i.entities || []).map((e) => ({
      name: e,
      sharedWith: (byEntity[e] || []).filter((l) => l !== i.system_label).length,
    }));
    const dupWith = (byCapability[i.capability] || []).filter((l) => l !== i.system_label);
    const missing = edgesByDomain[i.domain] || [];
    const topMissing = missing[0];
    const severity = topMissing?.severity || (dupWith.length ? "MEDIUM" : "LOW");

    let recommendation;
    if (dupWith.length) {
      recommendation = `Consolidate into one shared ${i.capability.replace(/_/g, " ")} service instead of ${dupWith.length + 1} separate builds.`;
    } else if (topMissing) {
      recommendation = `Establish a live connection between ${toTitleCase(topMissing.from)} and ${toTitleCase(topMissing.to)}.`;
    } else {
      recommendation = "Not currently duplicated or isolated — no action needed here.";
    }

    return { label: i.system_label, domain: i.domain, capability: i.capability, severity, entities, dupWith, missing, recommendation };
  });
}

// cursor-reactive panel glow — set directly on the DOM node rather than via
// React state, so tracking the mouse doesn't trigger a re-render per pixel
function handlePanelMove(e) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
  el.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
}
function handlePanelEnter(e) { e.currentTarget.classList.add("glow-on"); }
function handlePanelLeave(e) { e.currentTarget.classList.remove("glow-on"); }

/* ═══════════════════════════ APP ═══════════════════════════ */

const MAP_STEPS = [
  "parsing initiatives",
  "clustering by problem domain",
  "checking capability overlap",
  "tracing shared data entities",
  "searching for live connections between systems",
  "rendering fragmentation map",
];

const BOOKING_URL = "https://outlook.office.com/bookwithme/user/c3aec71cb9e040ff98f5edffaa621e24@kaaratech.com/meetingtype/dNDMrCLLMEeGzctgkDWr-g2?anonymous&ismsaljsauthenabled&ep=mCardFromTile";
const SHEET_WEBHOOK_URL = import.meta.env.VITE_SHEET_WEBHOOK_URL || "";

export default function App() {
  const [screen, setScreen] = useState("paste"); // paste | report
  const [text, setText] = useState("");
  const [phase, setPhase] = useState("chaos");
  const [mapping, setMapping] = useState(false);
  const [diag, setDiag] = useState(null);
  const [menu, setMenu] = useState(false);
  const [hoverInfo, setHoverInfo] = useState(null);  // {kind:'node'|'edge', domain?|edge?} — live hover preview
  const [selected, setSelected] = useState(null);    // {kind:'node',domain,label} | {kind:'edge',edge} — pinned by click
  const [sendForm, setSendForm] = useState({ open: false, email: "", company: "", sending: false, sent: false, error: "" });
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [slowJoke, setSlowJoke] = useState(false);
  const [benchmark, setBenchmark] = useState(PLACEHOLDER_BENCHMARK);
  const [mapMode, setMapMode] = useState("chaos"); // chaos | potential — before/after toggle
  const [showProjectCards, setShowProjectCards] = useState(false);
  const [expandedCard, setExpandedCard] = useState(0);
  const [showEmbed, setShowEmbed] = useState(false);
  const taRef = useRef(null);
  const gutRef = useRef(null);
  const brandClicks = useRef({ count: 0, last: 0 });

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const { domains, unknown } = detectDomains(lines);
  const islands = Math.max(domains.length, 1);
  const feedRevealed = Math.min(lines.length, MAP_STEPS.length - 1);

  // hooks must run unconditionally — computed here, before the paste-screen's
  // early return, even though it's only meaningful once `diag` exists
  const defaultEdge = useMemo(() => (diag ? rankWorstEdge(diag.graph) : null), [diag]);

  // easter egg: cycle the empty-textarea placeholder into nonsense the
  // longer someone lingers without typing anything
  useEffect(() => {
    if (text) return;
    const id = setInterval(() => {
      setPlaceholderIdx((i) => (i + 1) % PLACEHOLDER_VARIANTS.length);
    }, 6000);
    return () => clearInterval(id);
  }, [text]);

  // easter egg: if mapping runs longer than the choreographed ~2.9s, the
  // last log line swaps to a wry aside instead of just... still loading
  useEffect(() => {
    if (!mapping) { setSlowJoke(false); return; }
    const id = setTimeout(() => setSlowJoke(true), 3600);
    return () => clearTimeout(id);
  }, [mapping]);

  // portfolio-wide benchmark stat, shown only once enough runs exist to be meaningful
  useEffect(() => {
    fetch("/api/benchmark")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data?.available) setBenchmark(data); })
      .catch(() => {});
  }, []);

  // deep-linked shareable report: /report/SM-XXXXXX loads that diagnostic
  // directly, skipping the paste screen and the mapping animation entirely
  useEffect(() => {
    const m = window.location.pathname.match(/\/report\/(SM-[A-Z0-9]+)/i);
    if (!m) return;
    fetch(`/api/report/${m[1]}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        setDiag(data);
        setScreen("report");
      })
      .catch(() => {});
  }, []);

  function handleTextChange(e) {
    const v = e.target.value;
    if (v.trim().toLowerCase() === CHAOS_TRIGGER) {
      setText(CHAOS_STACK.join("\n"));
      return;
    }
    setText(v);
  }

  // easter egg: five quick clicks on the wordmark pops a confetti burst
  function handleBrandClick(e) {
    const now = Date.now();
    const b = brandClicks.current;
    b.count = now - b.last < 900 ? b.count + 1 : 1;
    b.last = now;
    if (b.count >= 5) {
      b.count = 0;
      const r = e.currentTarget.getBoundingClientRect();
      spawnConfetti(r.left + r.width / 2, r.top + r.height / 2);
    }
  }

  async function run() {
    if (!lines.length || mapping) return;
    setMenu(false);
    setPhase("mapped");
    setMapping(true);
    const req = fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines }),
    }).then((r) => r.json()).catch(() => null);
    const [data] = await Promise.all([req, delay(2900)]);
    if (data) {
      setDiag(data);
      setHoverInfo(null);
      setSelected(null);
      setSendForm({ open: false, email: "", company: "", sending: false, sent: false });
      setScreen("report");
      window.history.pushState(null, "", `/report/${data.diagnostic_id}`);
    }
    setMapping(false);
    setPhase("chaos");
  }

  async function submitSendMap(e) {
    e.preventDefault();
    if (sendForm.sending) return;
    setSendForm((f) => ({ ...f, sending: true, error: "" }));

    // fire-and-forget: Apps Script web apps don't return CORS headers for
    // cross-origin reads, so no-cors + text/plain avoids a failed preflight.
    // The response is opaque either way, so this can't affect the
    // success/failure state below — /api/team-brief is the source of truth
    // for that, since we can actually read its response.
    if (SHEET_WEBHOOK_URL) {
      fetch(SHEET_WEBHOOK_URL, {
        method: "POST", mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          Email: sendForm.email,
          Company: sendForm.company,
          Source: "AI Sprawl Map",
          "Diagnostic ID": diag.diagnostic_id,
          Timestamp: new Date().toISOString(),
        }),
      }).catch((err) => console.warn("Sheet webhook failed:", err));
    } else {
      console.warn("VITE_SHEET_WEBHOOK_URL is not set — lead wasn't logged to the sheet. See google-apps-script/sheet-webhook.gs.");
    }

    try {
      const res = await fetch("/api/team-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diagnostic_id: diag.diagnostic_id, work_email: sendForm.email }),
      });
      if (!res.ok) throw new Error(`team-brief returned ${res.status}`);
      setSendForm((f) => ({ ...f, sending: false, sent: true, open: false }));
    } catch (err) {
      console.warn("Send map failed:", err);
      setSendForm((f) => ({ ...f, sending: false, error: "Couldn't send that — check the backend is running and try again." }));
    }
  }

  function onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
  }

  const [linkCopied, setLinkCopied] = useState(false);
  async function handleCopyReportLink() {
    const url = `${window.location.origin}/report/${diag.diagnostic_id}`;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2200);
    } catch {
      console.warn("Clipboard write failed — report URL:", url);
    }
  }

  async function handleDownloadShareCard() {
    const blob = await buildShareCardBlob(diag);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sprawl-map-${diag.diagnostic_id}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (screen === "paste")
    return (
      <main className="hero" data-mapping={mapping ? "true" : "false"}>
        <SprawlField className="field" initiatives={lines} categoryOf={domainOf}
          phase={mapping ? "mapped" : phase} />
        <div className="field-veil" aria-hidden="true" />

        <header className="hero-bar">
          <div className="shell hero-bar-in">
            <span className="wordmark"><span className="brand" onClick={handleBrandClick}>Kaara</span> AI SPRAWL MAP</span>
            <span className="badge-group">
              {benchmark && (
                <span
                  className="badge benchmark-badge"
                  title={`Across ${benchmark.runs} portfolios mapped so far, the average has ${benchmark.avg_rebuilt_capabilities} rebuilt capabilities and ${benchmark.avg_independent_data_touches} independent data touches.`}
                >
                  AVG {benchmark.avg_rebuilt_capabilities} REBUILT CAPS · {benchmark.runs} RUNS
                </span>
              )}
              <span className="badge">FREE · 90 SECONDS · NO SIGNUP</span>
            </span>
          </div>
        </header>

        <div className="shell hero-grid">
          <section className="hero-copy">
            <h1>You have more AI projects than you think.</h1>
            <p className="sub">Do any of them know about each other?</p>
            <p className="hint">
              Paste every AI, automation, and data initiative you can think of, one per line.
              We'll map the whole portfolio at once.
            </p>
          </section>

          <section className="hero-panel" aria-label="Your initiatives"
            onMouseMove={handlePanelMove} onMouseEnter={handlePanelEnter} onMouseLeave={handlePanelLeave}>
            <div className="editor">
              <div className="editor-top">
                <span className="tl" aria-hidden="true"><i /><i /><i /></span>
                <span className="fname">initiatives.txt</span>
                <span className="ecount">{lines.length} LINES</span>
              </div>
              <div className="editor-body">
                <div className="gutter" ref={gutRef} aria-hidden="true">
                  {Array.from({ length: Math.max(lines.length ? text.split("\n").length : 0, 13) }).map((_, i) => (
                    <div key={i}>{String(i + 1).padStart(2, "0")}</div>
                  ))}
                </div>
                <textarea
                  ref={taRef}
                  value={text}
                  onChange={handleTextChange}
                  onKeyDown={onKey}
                  onScroll={() => { if (gutRef.current) gutRef.current.scrollTop = taRef.current.scrollTop; }}
                  spellCheck="false"
                  disabled={mapping}
                  aria-label="AI, automation, and data initiatives, one per line"
                  placeholder={PLACEHOLDER_VARIANTS[placeholderIdx]}
                />
              </div>
              <div className="editor-status">
                <div className="chips">
                  {domains.map((d) => (
                    <span className="chip" key={d}>
                      <i className="chip-dot" style={{ background: DOMAIN_COLORS[d] || "#94a3b8" }} />
                      {d.toUpperCase()}
                    </span>
                  ))}
                  {unknown > 0 && <span className="chip dim">{unknown} UNCLASSIFIED → LLM</span>}
                  {!lines.length && <span className="chip dim">DOMAINS DETECTED LIVE AS YOU TYPE</span>}
                </div>
                <span className="kbd-hint">CTRL + ↵ TO MAP</span>
              </div>
            </div>

            {feedRevealed > 0 && (
              <div className="analysis-feed">
                {MAP_STEPS.slice(0, feedRevealed).map((s, i) => (
                  <div className={"feed-step " + (i === feedRevealed - 1 ? "active" : "done")} key={s}>
                    <span className="feed-icon">{i === feedRevealed - 1 ? "●" : "✓"}</span>
                    <span>{s}{i === 0 ? ` (${lines.length})` : ""}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="row">
              <div className="menu-anchor">
                <button className={"ghost" + (lines.length ? "" : " ghost-accent")} aria-haspopup="true" aria-expanded={menu}
                  onClick={() => setMenu(!menu)}>
                  {lines.length ? "Load an example stack" : "New here? See a sample stack"} {menu ? "▴" : "▾"}
                </button>
                {menu && (
                  <div className="menu" role="menu">
                    {Object.entries(STACKS).map(([name, s]) => (
                      <button key={name} role="menuitem"
                        onClick={() => { setText(s.lines.join("\n")); setMenu(false); }}>
                        <span>{name}</span>
                        <span className="menu-meta">{s.meta}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="lines">{lines.length} LINES · ~{Math.max(domains.length, lines.length ? 1 : 0)} DOMAINS</span>
            </div>

            <p className="hint">
              Generic descriptions work fine — no project codenames needed.
              We don't sell or share what you paste with anyone.
            </p>
            <button className="primary big-cta" onClick={run} disabled={!lines.length || mapping}>
              {mapping ? "Mapping…" : "Map my portfolio →"}
            </button>
            <p className="hint faint">
              Your list is stored to generate this diagnostic. We only ask for your email if you want a team brief or a working session.
            </p>
          </section>
        </div>

        {mapping && (
          <div className="mapping" role="status" aria-live="polite">
            <div className="processing-card">
              <div className="processing-header">
                <span className="processing-title">Analyzing your portfolio</span>
                <span className="processing-time">~90 seconds</span>
              </div>
              <div className="progress-bar-container">
                <div className="progress-bar-fill" />
              </div>
              <div className="mapping-log">
                {MAP_STEPS.map((s, i) => {
                  const isLast = i === MAP_STEPS.length - 1;
                  const line = isLast && slowJoke ? "still faster than your last integration project" : s;
                  return (
                    <div className="loadline" key={i} style={{ animationDelay: `${i * 0.32}s` }}>
                      <span className="loadmark" style={{ animationDelay: `${i * 0.32 + 0.24}s` }}>✓</span>
                      <span>{line}{i === 0 ? ` (${lines.length})` : ""}</span>
                    </div>
                  );
                })}
              </div>
              <p className="mapping-verdict">
                {islands} island{islands === 1 ? "" : "s"}.<br />No connections between them.
              </p>
            </div>
          </div>
        )}
      </main>
    );

  /* ─────────────────────────── RESULTS ─────────────────────────── */

  const runDate = new Date(diag.run_at).toISOString().slice(0, 10);
  const diagShown = resolveDiagnostic(diag, hoverInfo || selected, defaultEdge);
  const auditShown = resolveAudit(diag, selected, defaultEdge);
  const projectCards = buildProjectCards(diag);

  return (
    <div className="results">
      <header className="void-header">
        <span>
          <span className="void-brand" onClick={handleBrandClick}>Kaara</span>
          <span className="void-title">AI SPRAWL MAP</span>
        </span>
        <span className="void-meta">
          {diag.diagnostic_id} · {runDate} · {diag.counts.initiatives} INITIATIVES · <span className="void-frag">{diag.status}</span>
          {diag.sprawl_score && (
            <> · <span style={{ color: diag.sprawl_score.color }}>SCORE {diag.sprawl_score.score}/100</span></>
          )}
        </span>
      </header>

      <div className="void-body">
        <aside className="void-audit" onMouseMove={handlePanelMove} onMouseEnter={handlePanelEnter} onMouseLeave={handlePanelLeave}>
          <p className="slabel">AUDIT EXPLANATION</p>
          <p className="void-audit-title">{auditShown.title}</p>
          {auditShown.sub && <p className="void-audit-sub">{auditShown.sub}</p>}
          {auditShown.kind === "edge" ? (
            <ol className="trace">
              {auditShown.trace.map((r, j) => {
                const last = j === auditShown.trace.length - 1;
                const fail = r.startsWith("Failure mode:");
                return (
                  <li key={j} className={(last ? "last" : "") + (fail ? " fail" : "")}>
                    <span className="trace-n">{String(j + 1).padStart(2, "0")}</span>
                    <span className="trace-t">{toSentence(r)}</span>
                  </li>
                );
              })}
            </ol>
          ) : auditShown.findings.length ? (
            <div className="void-audit-findings">
              {auditShown.findings.map((f, i) => (
                <div className="void-audit-finding" key={i}>
                  <span className={"void-audit-tag " + f.type.toLowerCase()}>{FINDING_ICON[f.type]}</span>
                  <div>
                    <div className="finding-title-row">
                      {f.evidence?.severity && (
                        <span className={"severity-badge severity-" + f.evidence.severity}>{f.evidence.severity}</span>
                      )}
                      <p className="void-audit-finding-title">{f.title}</p>
                    </div>
                    <p className="void-audit-finding-detail">{f.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="void-audit-empty">No findings directly involve this system.</p>
          )}
        </aside>

        <section className="void-stage" aria-label="Fragmentation map">
          <div className="mode-toggle">
            <span className={mapMode === "chaos" ? "mode-label active" : "mode-label"}>Show the chaos</span>
            <button
              className={"mode-switch" + (mapMode === "potential" ? " on" : "")}
              role="switch"
              aria-checked={mapMode === "potential"}
              aria-label="Toggle between the current fragmented map and its potential"
              onClick={() => setMapMode((m) => (m === "chaos" ? "potential" : "chaos"))}
            >
              <span className="mode-knob" />
            </button>
            <span className={mapMode === "potential" ? "mode-label active" : "mode-label"}>Show the potential</span>
          </div>
          <ResultsCanvas graph={diag.graph} mode={mapMode} onHoverChange={setHoverInfo} onSelectChange={setSelected} />
        </section>

        <aside className="void-side" onMouseMove={handlePanelMove} onMouseEnter={handlePanelEnter} onMouseLeave={handlePanelLeave}>
          {diag.sprawl_score && (
            <div className="score-banner">
              <div className="score-circle" style={{ borderColor: diag.sprawl_score.color }}>
                <span className="score-number">{diag.sprawl_score.score}</span>
                <span className="score-label">/ 100</span>
              </div>
              <div className="score-details">
                <span className="score-level" style={{ color: diag.sprawl_score.color }}>{diag.sprawl_score.level}</span>
                <div className="score-components">
                  <span>Duplicates {diag.sprawl_score.components.duplicates}%</span>
                  <span>Missing edges {diag.sprawl_score.components.missing_edges}%</span>
                  <span>Data touches {diag.sprawl_score.components.data_touches}%</span>
                  <span>Domain diversity {diag.sprawl_score.components.domain_diversity}%</span>
                </div>
              </div>
            </div>
          )}
          <div className="void-consequence" data-active={diagShown.active ? "true" : "false"}>
            <p className="slabel">DIAGNOSTIC</p>
            <p className="void-diag-sub">{diagShown.label}</p>
            <p className="void-diag-text">{diagShown.text}</p>
          </div>
          <div className="void-divider" />
          <div className="void-cta">
            <a className="void-book" href={BOOKING_URL} target="_blank" rel="noopener noreferrer">
              Book 30 min with Shrihari →
            </a>
            <button className="void-share-btn" onClick={handleCopyReportLink}>
              {linkCopied ? "Link copied ✓" : "Copy report link 🔗"}
            </button>
            <button className="void-share-btn" onClick={handleDownloadShareCard}>
              Download results card ⬇
            </button>
            <button className="void-share-btn" onClick={() => setShowProjectCards(true)}>
              Initiative details ▾
            </button>
            <button className="void-share-btn" onClick={() => setShowEmbed((v) => !v)}>
              {showEmbed ? "Hide embed code ▴" : "Embed Sprawl Score badge ▾"}
            </button>
            {showEmbed && diag.sprawl_score && (() => {
              const origin = window.location.origin;
              const badgeUrl = `${origin}/api/badge/${diag.diagnostic_id}.svg`;
              const reportUrl = `${origin}/report/${diag.diagnostic_id}`;
              const html = `<a href="${reportUrl}"><img src="${badgeUrl}" alt="AI Sprawl Score" /></a>`;
              const markdown = `[![AI Sprawl Score](${badgeUrl})](${reportUrl})`;
              return (
                <div className="embed-panel">
                  <img className="embed-preview" src={badgeUrl} alt="AI Sprawl Score badge preview" />
                  <label className="embed-label">HTML (email signature, blog)</label>
                  <textarea className="embed-code" readOnly value={html} onClick={(e) => e.target.select()} rows={2} />
                  <label className="embed-label">Markdown (GitHub, README)</label>
                  <textarea className="embed-code" readOnly value={markdown} onClick={(e) => e.target.select()} rows={2} />
                </div>
              );
            })()}
            {sendForm.sent ? (
              <p className="void-sent">MAP SENT · Shrihari will follow up within 24h.</p>
            ) : sendForm.open ? (
              <form className="void-send-form" onSubmit={submitSendMap}>
                <input type="email" required placeholder="work email" aria-label="work email"
                  value={sendForm.email} onChange={(e) => setSendForm((f) => ({ ...f, email: e.target.value }))} />
                <input type="text" required placeholder="company" aria-label="company"
                  value={sendForm.company} onChange={(e) => setSendForm((f) => ({ ...f, company: e.target.value }))} />
                <button className="void-send-submit" type="submit" disabled={sendForm.sending}>
                  {sendForm.sending ? "Sending…" : "Send"}
                </button>
                {sendForm.error && <p className="void-send-error">{sendForm.error}</p>}
              </form>
            ) : (
              <button className="void-send-btn" onClick={() => setSendForm((f) => ({ ...f, open: true }))}>
                Send me this map
              </button>
            )}
          </div>
        </aside>
      </div>

      {showProjectCards && (
        <div className="cards-overlay" role="dialog" aria-label="Initiative details">
          <div className="cards-panel">
            <div className="cards-panel-head">
              <h3 className="cards-header">Initiative details</h3>
              <button className="cards-close" onClick={() => setShowProjectCards(false)} aria-label="Close">✕</button>
            </div>
            <div className="cards-panel-body">
              {projectCards.map((p, i) => {
                const expanded = expandedCard === i;
                return (
                  <div className={"project-card" + (expanded ? " expanded" : "")} key={p.label}>
                    <div className="card-header" onClick={() => setExpandedCard(expanded ? -1 : i)}>
                      <span className="chip-dot" style={{ background: DOMAIN_COLORS[p.domain] || "#94a3b8" }} />
                      <span className="card-name">{toTitleCase(p.label)}</span>
                      <span className="card-domain-label">{p.domain.toUpperCase()}</span>
                      <span className={"severity-badge severity-" + p.severity}>{p.severity}</span>
                      <span className="card-toggle">▾</span>
                    </div>
                    {expanded && (
                      <div className="card-body">
                        <div className="card-section">
                          <div className="section-title">Data entities touched</div>
                          {p.entities.length ? p.entities.map((e) => (
                            <p key={e.name}>
                              {toTitleCase(e.name)}
                              {e.sharedWith > 0 && <span className="shared-with"> (shared with {e.sharedWith} other system{e.sharedWith === 1 ? "" : "s"})</span>}
                            </p>
                          )) : <p className="void-audit-empty">None recorded.</p>}
                        </div>
                        <div className="card-section">
                          <div className="section-title">Duplicates identified</div>
                          {p.dupWith.length ? (
                            <p>{p.capability.replace(/_/g, " ")} rebuilt by: {p.dupWith.map(toTitleCase).join(", ")}</p>
                          ) : <p className="void-audit-empty">No duplicated capability.</p>}
                        </div>
                        <div className="card-section">
                          <div className="section-title">Missing connections</div>
                          {p.missing.length ? p.missing.map((e, j) => (
                            <p key={j}>{toTitleCase(e.from)} → {toTitleCase(e.to)} ({e.label})</p>
                          )) : <p className="void-audit-empty">None involving this domain.</p>}
                        </div>
                        <div className="card-section recommendation">
                          <div className="section-title">Recommendation</div>
                          <p>{p.recommendation}</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
