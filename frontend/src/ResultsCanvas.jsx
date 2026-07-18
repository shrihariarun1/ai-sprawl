import { useEffect, useRef, useState } from "react";

/*
  ResultsCanvas — the entire results page. A force-directed cluster of node
  cards: general repulsion keeps them apart, a spring attraction pulls nodes
  that share a capability or a data entity toward each other (so related
  systems visibly tangle/overlap — the fragmentation made physical), and a
  weak center gravity plus continuous jitter keeps the whole thing settled
  but never fully static, like a live network. Red dashed/pulsing lines mark
  connections that should exist but do not, each bleeding a small pool of
  particles that travel halfway across the gap and die there — never
  reaching the other side. That failure, repeated, is the whole pitch.

  Clicking any node or edge focuses it: the simulation freezes, the camera
  tweens in on it, and the parent renders the explanation (App.jsx owns that
  text — this component only reports the selection). Clicking the same thing
  again, or empty canvas, releases focus and physics resumes.

  One <canvas>, one rAF loop for the component's life. Hover/click hit-testing
  runs against the same per-frame node/edge positions the draw pass uses, so
  there is only ever one source of truth for "where is everything right now."
*/

const RED = "#C62828";
const GREEN = "#2A7A7A";
const AMBER = (a) => `rgba(201,124,61,${a})`;
const RED_A = (a) => `rgba(198,40,40,${a})`;
const INK = (a) => `rgba(26,26,26,${a})`;   // dark ink — the "calm/neutral" tone on paper

// domain -> node accent color, matching the warm consultancy-report palette
const DOMAIN_COLORS = {
  fraud: "#C62828", compliance: "#2A7A7A", support: "#2A7A7A", lending: "#C97C3D",
  analytics: "#8B5CF6", identity: "#EC4899", marketing: "#F97316", claims: "#A0752A",
  documents: "#5B7B8C", operations: "#0891A8", security: "#C2185B", hr: "#6B8E23",
};
const domainColor = (d) => DOMAIN_COLORS[d] || "#8A8378";

const NODE_W = 220, NODE_H = 70, CHAMFER = 8;
const PARTICLES_PER_EDGE = 4;
const PARTICLE_TRAVEL = 4600;    // ms, source -> midpoint
const PARTICLE_REST = 900;       // ms pause before the next particle departs
const SHARD_COUNT = 5;
const SHARD_LIFE = 30;           // frames
const OPACITY_EASE = 0.03;       // per-frame ease toward target opacity — a
                                  // deliberate, slower settle instead of an instant snap
const CAM_DUR = 2000;            // ms, camera pan/zoom transition
const DEFAULT_ZOOM = 1.22;       // slightly closer than 1:1 by default
const NODE_ZOOM = 1.4;
const EDGE_ZOOM = 1.25;

// ── force-directed layout constants (tuned/validated against 6-8 node
// portfolios, sparse through fully-dense relatedness, before wiring in) ──
const REPEL_K = 55000;       // repulsion strength, inverse-square falloff
const ATTRACT_K = 0.8;       // spring constant pulling related pairs together
const REST_LENGTH = NODE_W * 0.55;  // target distance for related pairs — less
                                     // than NODE_W so related cards visibly overlap
const CENTER_K = 0.15;       // weak pull toward the void hub, keeps the graph framed
const JITTER = 6;            // continuous small random force — "living network",
                              // never fully static even once settled
const DAMPING = 0.90;        // per-step velocity decay
const MAX_SPEED = 260;       // px/s cap, guards against instability on resume
const WARMUP_STEPS = 260;    // synchronous pre-settle so the first frame isn't chaos

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a, b, t) => a + (b - a) * t;

function chamferPath(ctx, x, y, w, h, c) {
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function drawBrackets(ctx, x, y, w, h, arm, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const o = 3;
  ctx.beginPath(); ctx.moveTo(x + o, y + o + arm); ctx.lineTo(x + o, y + o); ctx.lineTo(x + o + arm, y + o); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + w - o - arm, y + o); ctx.lineTo(x + w - o, y + o); ctx.lineTo(x + w - o, y + o + arm); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + w - o, y + h - o - arm); ctx.lineTo(x + w - o, y + h - o); ctx.lineTo(x + w - o - arm, y + h - o); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + o + arm, y + h - o); ctx.lineTo(x + o, y + h - o); ctx.lineTo(x + o, y + h - o - arm); ctx.stroke();
}

// greedy word-wrap to at most 2 lines — full label text, never an ellipsis
// cut mid-thought, unless a single word alone can't fit even one line
function wrapLabel(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (cur && ctx.measureText(test).width > maxWidth) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) {
    let second = lines.slice(1).join(" ");
    while (second.length > 1 && ctx.measureText(second + "…").width > maxWidth) {
      second = second.slice(0, -1);
    }
    return [lines[0], second.trimEnd() + "…"];
  }
  return lines;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = clamp01(t);
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// one physics step, mutates node.x/y/vx/vy in place. Nodes live in a local
// coordinate space centered at the void hub (0,0) — screen position is this
// plus the canvas center, added at draw/hit-test time so the sim itself
// never needs to know the canvas size.
function stepPhysics(nodes, relatedPairs, dtMs) {
  const n = nodes.length;
  const dt = Math.min(dtMs, 32) / 1000;

  for (const nd of nodes) { nd.fx = 0; nd.fy = 0; }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; distSq = dx * dx + dy * dy + 0.01; }
      const dist = Math.sqrt(distSq);
      const force = REPEL_K / distSq;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      a.fx += fx; a.fy += fy; b.fx -= fx; b.fy -= fy;
    }
  }

  for (const [i, j] of relatedPairs) {
    const a = nodes[i], b = nodes[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const force = ATTRACT_K * (dist - REST_LENGTH);
    const fx = (dx / dist) * force, fy = (dy / dist) * force;
    a.fx += fx; a.fy += fy; b.fx -= fx; b.fy -= fy;
  }

  for (const nd of nodes) {
    nd.fx += -nd.x * CENTER_K;
    nd.fy += -nd.y * CENTER_K;
    nd.fx += (Math.random() - 0.5) * JITTER;
    nd.fy += (Math.random() - 0.5) * JITTER;

    nd.vx = (nd.vx + nd.fx * dt) * DAMPING;
    nd.vy = (nd.vy + nd.fy * dt) * DAMPING;
    const speed = Math.hypot(nd.vx, nd.vy);
    if (speed > MAX_SPEED) { nd.vx = (nd.vx / speed) * MAX_SPEED; nd.vy = (nd.vy / speed) * MAX_SPEED; }
    nd.x += nd.vx * dt;
    nd.y += nd.vy * dt;
  }
}

export default function ResultsCanvas({ graph, mode = "chaos", onHoverChange, onSelectChange }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const simRef = useRef(null);
  const dims = useRef({ w: 0, h: 0, dpr: 1 });
  const [reduced] = useState(prefersReducedMotion);
  const onHoverChangeRef = useRef(onHoverChange);
  const onSelectChangeRef = useRef(onSelectChange);
  const modeRef = useRef(mode);
  const drawRef = useRef(null);
  onHoverChangeRef.current = onHoverChange;
  onSelectChangeRef.current = onSelectChange;
  modeRef.current = mode;

  // "potential" mode is purely cosmetic re-paint of the same edges — force
  // an immediate frame on toggle so it's not waiting for the next rAF tick
  // (matters most under prefers-reduced-motion, where the loop isn't running)
  useEffect(() => { drawRef.current && drawRef.current(performance.now()); }, [mode]);

  // ── build the simulation from the graph, once per diagnostic ──
  useEffect(() => {
    const n = graph.nodes.length;
    const nodes = graph.nodes.map((g, i) => {
      const a = (i / n) * Math.PI * 2;
      return {
        ...g,
        x: Math.cos(a) * 150 + (Math.random() - 0.5) * 20,
        y: Math.sin(a) * 150 + (Math.random() - 0.5) * 20,
        vx: 0, vy: 0, fx: 0, fy: 0,
        appearAt: i * 215,
        curOp: 1,
      };
    });
    const relatedPairs = (graph.related_pairs || []).filter(
      ([i, j]) => i >= 0 && i < n && j >= 0 && j < n
    );

    // pre-settle synchronously so the very first paint isn't the chaotic
    // initial scatter — physics keeps running afterward for subtle motion
    for (let s = 0; s < WARMUP_STEPS; s++) stepPhysics(nodes, relatedPairs, 16);

    const byDomain = {};
    nodes.forEach((nd, i) => { if (nd.domain && !(nd.domain in byDomain)) byDomain[nd.domain] = i; });

    const edges = graph.missing_edges
      .filter((e) => e.from in byDomain && e.to in byDomain)
      .map((e) => ({ ...e, aIdx: byDomain[e.from], bIdx: byDomain[e.to], curOp: 0.5 }));

    const nodesDoneAt = Math.max(0, n - 1) * 215 + 580 + 300;
    const trackDoneAt = nodesDoneAt + 650;
    const voidDoneAt = trackDoneAt + 850;
    const edgeWindow = 3000;
    const stagger = edges.length > 1 ? Math.min(520, edgeWindow / (edges.length - 1)) : 0;
    const TO_MID = 950, PAUSE = 320, MID_TO_END = 460;
    edges.forEach((e, i) => {
      e.startAt = voidDoneAt + i * stagger;
      e.doneAt = e.startAt + TO_MID + PAUSE + MID_TO_END;
      e.toMid = TO_MID; e.pause = PAUSE; e.midToEnd = MID_TO_END;
      e.particles = Array.from({ length: PARTICLES_PER_EDGE }, (_, k) => ({
        phase: (k / PARTICLES_PER_EDGE) * (PARTICLE_TRAVEL + PARTICLE_REST),
        lastCycle: -1,
        spawnedThisCycle: false,
        shards: [],
      }));
    });

    let eggFound = false;
    try { eggFound = localStorage.getItem("sprawl_egg_found") === "1"; } catch { /* ignore */ }

    // spread radius of the settled cluster — same role sim.R used to play
    // (baseZoom, cursor-tether falloff), just measured instead of formula-derived
    const R = Math.max(120, ...nodes.map((nd) => Math.hypot(nd.x, nd.y))) + NODE_W / 2;

    simRef.current = {
      nodes, edges, relatedPairs, nodesDoneAt, trackDoneAt, voidDoneAt,
      R, mounted: performance.now(),
      mouse: null, hover: null, selected: null, camera: null,
      eggFound, lastStep: performance.now(),
    };
  }, [graph]);

  // ── canvas setup: resize, rAF loop, mouse/click, pause off-screen ──
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let staticLayer = null; // offscreen: ambient dot grid, screen-space, never panned/zoomed

    const buildStaticLayer = () => {
      const { w, h } = dims.current;
      const off = document.createElement("canvas");
      off.width = canvas.width; off.height = canvas.height;
      const octx = off.getContext("2d");
      octx.setTransform(dims.current.dpr, 0, 0, dims.current.dpr, 0, 0);

      const cx = w / 2, cy = h / 2;
      const maxDist = Math.hypot(w / 2, h / 2);
      for (let x = 0; x < w; x += 22) {
        for (let y = 0; y < h; y += 22) {
          const d = Math.hypot(x - cx, y - cy) / maxDist;
          const a = Math.max(0, 0.09 * (1 - d * 1.05));
          if (a <= 0.002) continue;
          octx.fillStyle = `rgba(58,53,48,${a.toFixed(3)})`;
          octx.beginPath(); octx.arc(x, y, 0.7, 0, Math.PI * 2); octx.fill();
        }
      }

      const sim = simRef.current;
      if (sim) {
        // the cluster's world-space spread is set purely by physics; whether
        // that's bigger than the visible canvas is answered by zooming out
        // rather than shrinking the cluster
        const span = 2 * sim.R + 60;
        const fit = Math.min(w, h) / span;
        sim.baseZoom = Math.min(DEFAULT_ZOOM, Math.max(0.35, fit));
      }
      staticLayer = off;
    };

    const reseat = () => { buildStaticLayer(); };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      dims.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      reseat();
      const sim = simRef.current;
      // keep the camera glued to the true center/fit whenever nothing is
      // focused — a layout shift (fonts loading, side panel content growing)
      // resizes the canvas, and a camera frozen from an earlier, different
      // size drifts away from where world positions now put the cluster.
      // Once something is selected, leave the camera alone (don't yank the
      // focused view around under the user).
      if (sim && !sim.selected) {
        const cx = rect.width / 2, cy = rect.height / 2;
        const z = sim.baseZoom || DEFAULT_ZOOM;
        sim.camera = { fromX: cx, fromY: cy, fromZoom: z, toX: cx, toY: cy, toZoom: z, start: 0, dur: 0 };
      }
    };
    resize();
    // repaint immediately on resize too — otherwise a reduced-motion session
    // (no rAF loop running) would sit on a stale frame until the next mousemove
    const onResizeEvent = () => { resize(); draw(performance.now()); };
    window.addEventListener("resize", onResizeEvent);
    const ro = new ResizeObserver(onResizeEvent);
    ro.observe(canvas);

    // ── camera: eased pan/zoom tween, frozen physics while focused ──
    const currentCamera = (sim, t) => {
      const c = sim.camera;
      const p = c.dur ? clamp01((t - c.start) / c.dur) : 1;
      const e = easeOutCubic(p);
      return { x: lerp(c.fromX, c.toX, e), y: lerp(c.fromY, c.toY, e), zoom: lerp(c.fromZoom, c.toZoom, e) };
    };
    const setCameraTarget = (sim, focal, zoom, t) => {
      const cur = currentCamera(sim, t);
      sim.camera = {
        fromX: cur.x, fromY: cur.y, fromZoom: cur.zoom,
        toX: focal.x, toY: focal.y, toZoom: zoom,
        start: t, dur: reduced ? 0 : CAM_DUR,
      };
    };

    // ── node/edge positions in world space (unaffected by camera) ──
    const computePositions = () => {
      const sim = simRef.current;
      if (!sim) return { cx: 0, cy: 0, pts: [] };
      const { w, h } = dims.current;
      const cx = w / 2, cy = h / 2;
      const pts = sim.nodes.map((nd) => {
        const x = cx + nd.x, y = cy + nd.y;
        return { x, y, left: x - NODE_W / 2, top: y - NODE_H / 2 };
      });
      return { cx, cy, pts };
    };

    const hitTestWorld = (wx, wy) => {
      const sim = simRef.current;
      if (!sim) return null;
      const { pts } = computePositions();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (wx >= p.left && wx <= p.left + NODE_W && wy >= p.top && wy <= p.top + NODE_H) {
          return { kind: "node", domain: sim.nodes[i].domain, label: sim.nodes[i].label, idx: i };
        }
      }
      for (const e of sim.edges) {
        if (performance.now() < e.doneAt && !reduced) continue;
        const a = pts[e.aIdx], b = pts[e.bIdx];
        if (distToSegment(wx, wy, a.x, a.y, b.x, b.y) < 14) return { kind: "edge", edge: e };
      }
      return null;
    };

    const toWorld = (mx, my) => {
      const sim = simRef.current;
      const { w, h } = dims.current;
      const cam = sim && sim.camera ? currentCamera(sim, performance.now()) : { x: w / 2, y: h / 2, zoom: 1 };
      return { x: (mx - w / 2) / cam.zoom + cam.x, y: (my - h / 2) / cam.zoom + cam.y };
    };

    const onMove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const sim = simRef.current;
      if (sim) sim.mouse = { x: mx, y: my };
      const world = toWorld(mx, my);
      const hit = hitTestWorld(world.x, world.y);
      canvas.style.cursor = hit ? "pointer" : "default";
      if (!sim) return;
      const prev = sim.hover;
      const changed = !prev || !hit ||
        prev.kind !== hit.kind ||
        (hit.kind === "node" && prev.domain !== hit.domain) ||
        (hit.kind === "edge" && prev.edge !== hit.edge);
      if (changed) {
        sim.hover = hit;
        onHoverChangeRef.current && onHoverChangeRef.current(
          hit ? (hit.kind === "node" ? { kind: "node", domain: hit.domain } : { kind: "edge", edge: hit.edge }) : null
        );
      }
      if (reduced) draw(performance.now());
    };
    const onLeave = () => {
      const sim = simRef.current;
      if (sim) { sim.mouse = null; sim.hover = null; }
      canvas.style.cursor = "default";
      onHoverChangeRef.current && onHoverChangeRef.current(null);
      if (reduced) draw(performance.now());
    };
    const onClick = (ev) => {
      const sim = simRef.current;
      if (!sim) return;
      const rect = canvas.getBoundingClientRect();
      const world = toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
      const hit = hitTestWorld(world.x, world.y);
      const { cx, cy } = computePositions();
      const now = performance.now();

      const release = () => {
        sim.selected = null;
        setCameraTarget(sim, { x: cx, y: cy }, sim.baseZoom || DEFAULT_ZOOM, now);
        onSelectChangeRef.current && onSelectChangeRef.current(null);
      };

      if (!hit) { if (sim.selected) release(); return; }

      const same = sim.selected && sim.selected.kind === hit.kind &&
        (hit.kind === "node" ? sim.selected.label === hit.label : sim.selected.edge === hit.edge);
      if (same) { release(); return; }

      sim.selected = hit;
      const { pts } = computePositions();
      let focal, zoom;
      if (hit.kind === "node") {
        const p = pts[hit.idx];
        focal = { x: p.left + NODE_W / 2, y: p.top + NODE_H / 2 };
        zoom = NODE_ZOOM;
      } else {
        const a = pts[hit.edge.aIdx], b = pts[hit.edge.bIdx];
        focal = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        zoom = EDGE_ZOOM;
      }
      setCameraTarget(sim, focal, zoom, now);
      onSelectChangeRef.current && onSelectChangeRef.current(
        hit.kind === "node" ? { kind: "node", domain: hit.domain, label: hit.label } : { kind: "edge", edge: hit.edge }
      );
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);

    // easter egg: a short directional code briefly flashes every missing
    // connection green. Shortened from the full Konami code to four beats,
    // and fed from both arrow keys (desktop) and swipes (touch), so it's
    // reachable on mobile where there's no keyboard at all.
    const EGG_SEQUENCE = ["up", "up", "down", "down"];
    let eggBuf = [];
    const pushDir = (dir) => {
      eggBuf.push(dir);
      eggBuf = eggBuf.slice(-EGG_SEQUENCE.length);
      if (eggBuf.length === EGG_SEQUENCE.length && eggBuf.every((d, i) => d === EGG_SEQUENCE[i])) {
        const sim = simRef.current;
        if (sim) { sim.eggStart = performance.now(); sim.eggFound = true; }
        try { localStorage.setItem("sprawl_egg_found", "1"); } catch { /* ignore */ }
        eggBuf = [];
      }
    };
    const KEY_DIR = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    const onKeydown = (ev) => { if (KEY_DIR[ev.key]) pushDir(KEY_DIR[ev.key]); };
    window.addEventListener("keydown", onKeydown);

    let touchStart = null;
    const onTouchStart = (ev) => {
      const t0 = ev.touches[0];
      touchStart = { x: t0.clientX, y: t0.clientY };
    };
    const onTouchEnd = (ev) => {
      if (!touchStart) return;
      const t0 = ev.changedTouches[0];
      const dx = t0.clientX - touchStart.x, dy = t0.clientY - touchStart.y;
      touchStart = null;
      if (Math.hypot(dx, dy) < 32) return; // too small to count as a swipe
      pushDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
    };
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchend", onTouchEnd, { passive: true });

    // ── void center: empty hub, handshake pulses that never land ──
    const drawVoid = (ctx2, cx, cy, t, sim) => {
      const since = t - sim.mounted;
      const born = reduced ? 1 : clamp01((since - sim.trackDoneAt) / 500);
      if (born <= 0) return;
      const innerR = 50 * easeOutCubic(born);

      if (!reduced) {
        const period = 4200;
        for (let i = 0; i < 3; i++) {
          const phase = ((since / period) + i / 3) % 1;
          const r = innerR + phase * 44;
          const a = (1 - phase) * 0.22;
          if (a <= 0.005) continue;
          ctx2.strokeStyle = `rgba(198,40,40,${a.toFixed(3)})`;
          ctx2.lineWidth = 1;
          ctx2.beginPath(); ctx2.arc(cx, cy, r, 0, Math.PI * 2); ctx2.stroke();
        }
      } else {
        ctx2.strokeStyle = "rgba(198,40,40,.14)";
        ctx2.lineWidth = 1;
        ctx2.beginPath(); ctx2.arc(cx, cy, innerR + 20, 0, Math.PI * 2); ctx2.stroke();
      }

      ctx2.fillStyle = "#1A1A1A";
      ctx2.beginPath(); ctx2.arc(cx, cy, innerR, 0, Math.PI * 2); ctx2.fill();
      ctx2.setLineDash([3, 4]);
      ctx2.strokeStyle = "rgba(198,40,40,.3)";
      ctx2.lineWidth = 1;
      ctx2.beginPath(); ctx2.arc(cx, cy, innerR, 0, Math.PI * 2); ctx2.stroke();
      ctx2.setLineDash([]);

      if (born > 0.6) {
        ctx2.fillStyle = "rgba(198,40,40,.9)";
        ctx2.font = "9px 'JetBrains Mono', ui-monospace, monospace";
        ctx2.textAlign = "center";
        ctx2.fillText("NO SHARED", cx, cy - 4);
        ctx2.fillText("SIGNAL BUS", cx, cy + 9);
      }
    };

    // ── "potential" mode: show the same edge as if it existed — a full
    // green dotted line, no gap-stop, no particle pool, positive label.
    // Purely a re-paint of the real missing edges, not new data.
    const drawEdgePotential = (ctx2, a, b, active, dimmed) => {
      const op = dimmed ? 0.3 : active ? 1 : 0.6;
      ctx2.strokeStyle = `rgba(42,122,122,${op.toFixed(3)})`;
      ctx2.lineWidth = active ? 2.2 : 1.4;
      ctx2.setLineDash([2, 5]);
      ctx2.beginPath(); ctx2.moveTo(a.x, a.y); ctx2.lineTo(b.x, b.y); ctx2.stroke();
      ctx2.setLineDash([]);

      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const labelOp = dimmed ? 0.4 : active ? 1 : 0.8;
      ctx2.font = "9.5px 'JetBrains Mono', ui-monospace, monospace";
      const text = "could connect";
      const tw = ctx2.measureText(text).width;
      ctx2.fillStyle = "#F5F0E8";
      ctx2.fillRect(mx - tw / 2 - 7, my - 10, tw + 14, 18);
      ctx2.fillStyle = active ? "#3A9A9A" : `rgba(42,122,122,${labelOp.toFixed(3)})`;
      ctx2.textAlign = "center";
      ctx2.fillText(text, mx, my + 4);
    };

    // severity -> base (non-focused) line treatment. HIGH reads as urgent
    // even before you hover it; MEDIUM/LOW step down in weight and alarm.
    const SEVERITY_STYLE = {
      HIGH: { rgb: "198,40,40", width: 2.4, dash: [5, 4], pulse: true },
      MEDIUM: { rgb: "201,124,61", width: 1.6, dash: [6, 5], pulse: false },
      LOW: { rgb: "166,159,152", width: 1, dash: [1.5, 4], pulse: false },
    };

    // ── one missing edge: dashed reveal, gap wash, particle pool ──
    const drawEdge = (ctx2, e, a, b, t, active, dimmed) => {
      if (modeRef.current === "potential") { drawEdgePotential(ctx2, a, b, active, dimmed); return; }
      const since = t - simRef.current.mounted;
      const localT = reduced ? 1 : since - e.startAt;
      if (!reduced && localT < 0) return;

      const targetOp = dimmed ? 0.28 : active ? 1 : 0.55;
      e.curOp = e.curOp == null || reduced ? targetOp : e.curOp + (targetOp - e.curOp) * OPACITY_EASE;

      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      let frac; // 0..1 fraction of the src->dst path currently drawn
      if (reduced) frac = 1;
      else if (localT < e.toMid) frac = 0.5 * easeOutCubic(clamp01(localT / e.toMid));
      else if (localT < e.toMid + e.pause) frac = 0.5;
      else frac = 0.5 + 0.5 * easeOutCubic(clamp01((localT - e.toMid - e.pause) / e.midToEnd));

      const ex = lerp(a.x, b.x, frac), ey = lerp(a.y, b.y, frac);
      const style = SEVERITY_STYLE[e.severity] || SEVERITY_STYLE.MEDIUM;
      // default/dimmed lines read at the edge's own severity weight; red is
      // reserved for the one you're actually focused on right now, same as
      // the active node border — active always overrides severity styling
      const lineRGB = active ? "198,40,40" : style.rgb;
      const width = active ? 2.4 : style.width;
      const pulse = active ? true : style.pulse;
      const pulseMul = pulse && !reduced ? 0.75 + 0.25 * Math.sin(t / 420) : 1;

      // gap wash: transparent at both ends, brightest at the true midpoint
      const grad = ctx2.createLinearGradient(a.x, a.y, b.x, b.y);
      const washPeak = (active ? 0.28 : 0.08) * (e.curOp / (active ? 1 : dimmed ? 0.28 : 0.55));
      grad.addColorStop(0, `rgba(${lineRGB},0)`);
      grad.addColorStop(0.5, `rgba(${lineRGB},${clamp01(washPeak).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${lineRGB},0)`);
      ctx2.strokeStyle = grad;
      ctx2.lineWidth = 15;
      ctx2.beginPath(); ctx2.moveTo(a.x, a.y); ctx2.lineTo(ex, ey); ctx2.stroke();

      ctx2.strokeStyle = `rgba(${lineRGB},${(e.curOp * pulseMul).toFixed(3)})`;
      ctx2.lineWidth = width;
      ctx2.setLineDash(active ? [5, 4] : style.dash);
      ctx2.beginPath(); ctx2.moveTo(a.x, a.y); ctx2.lineTo(ex, ey); ctx2.stroke();
      ctx2.setLineDash([]);

      const doneForParticles = reduced || since >= e.doneAt;
      if (doneForParticles && !reduced) {
        updateAndDrawParticles(ctx2, e, a, mx, my, active, dimmed, since);
      }

      if (doneForParticles) {
        const labelOp = dimmed ? 0.4 : active ? 1 : 0.8;
        ctx2.font = "9.5px 'JetBrains Mono', ui-monospace, monospace";
        const text = e.label;
        const tw = ctx2.measureText(text).width;
        ctx2.fillStyle = "#F5F0E8";
        ctx2.fillRect(mx - tw / 2 - 7, my - 10, tw + 14, 18);
        ctx2.fillStyle = active ? "#C62828" : `rgba(26,26,26,${labelOp.toFixed(3)})`;
        ctx2.textAlign = "center";
        ctx2.fillText(text, mx, my + 4);
      }
    };

    const updateAndDrawParticles = (ctx2, e, a, mx, my, active, dimmed, since) => {
      const cycle = PARTICLE_TRAVEL + PARTICLE_REST;
      const rBase = (active ? 3.8 : 2.3);
      const op = dimmed ? 0.28 : active ? 1 : 0.55;
      const rgb = active ? "198,40,40" : (SEVERITY_STYLE[e.severity] || SEVERITY_STYLE.MEDIUM).rgb;
      for (const p of e.particles) {
        const raw = since - e.doneAt + p.phase;
        const cycleIndex = Math.floor(raw / cycle);
        if (cycleIndex !== p.lastCycle) { p.lastCycle = cycleIndex; p.spawnedThisCycle = false; }
        const local = raw - cycleIndex * cycle;

        if (local < PARTICLE_TRAVEL) {
          const prog = easeOutCubic(local / PARTICLE_TRAVEL);
          const px = lerp(a.x, mx, prog), py = lerp(a.y, my, prog);
          const flare = prog > 0.94 ? 1.8 : 1;
          ctx2.fillStyle = `rgba(${rgb},${op.toFixed(3)})`;
          ctx2.beginPath(); ctx2.arc(px, py, rBase * flare, 0, Math.PI * 2); ctx2.fill();
          if (prog > 0.985 && !p.spawnedThisCycle) {
            p.spawnedThisCycle = true;
            for (let s = 0; s < SHARD_COUNT; s++) {
              const ang = Math.random() * Math.PI * 2;
              const spd = 0.5 + Math.random() * 1.1;
              p.shards.push({ x: px, y: py, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, age: 0 });
            }
          }
        }

        p.shards = p.shards.filter((sh) => sh.age <= SHARD_LIFE);
        for (const sh of p.shards) {
          sh.x += sh.vx; sh.y += sh.vy; sh.age++;
          const a2 = op * (1 - sh.age / SHARD_LIFE);
          if (a2 <= 0.01) continue;
          ctx2.fillStyle = `rgba(${rgb},${a2.toFixed(3)})`;
          ctx2.beginPath(); ctx2.arc(sh.x, sh.y, 1.5, 0, Math.PI * 2); ctx2.fill();
        }
      }
    };

    const drawNode = (ctx2, nd, p, t, sim, active, dimmed) => {
      const since = t - sim.mounted;
      const grow = reduced ? 1 : easeOutCubic(clamp01((since - nd.appearAt) / 380));
      if (grow <= 0) return;
      const targetOp = dimmed ? 0.3 : 1;
      nd.curOp = nd.curOp == null || reduced ? targetOp : nd.curOp + (targetOp - nd.curOp) * OPACITY_EASE;
      const x = p.left, y = p.top;
      ctx2.globalAlpha = nd.curOp * grow;

      // critical (3+ data touches): a red pulse glow, on top of the amber
      // duplicate-capability glow if both apply — two independent warnings
      const critical = (nd.data_touches || 0) >= 3;
      if (critical && !reduced) {
        const pulse = 0.15 + 0.3 * (0.5 + 0.5 * Math.sin(t / 900));
        ctx2.save();
        ctx2.shadowColor = RED_A(0.9);
        ctx2.shadowBlur = 18;
        chamferPath(ctx2, x, y, NODE_W, NODE_H, CHAMFER);
        ctx2.strokeStyle = RED_A(pulse);
        ctx2.lineWidth = 1.5;
        ctx2.stroke();
        ctx2.restore();
      } else if (critical) {
        chamferPath(ctx2, x, y, NODE_W, NODE_H, CHAMFER);
        ctx2.strokeStyle = RED_A(0.3);
        ctx2.lineWidth = 1.5;
        ctx2.stroke();
      }

      if (nd.duplicated && !reduced) {
        const pulse = 0.1 + 0.25 * (0.5 + 0.5 * Math.sin(t / 1100));
        ctx2.save();
        ctx2.shadowColor = AMBER(0.9);
        ctx2.shadowBlur = 15;
        chamferPath(ctx2, x, y, NODE_W, NODE_H, CHAMFER);
        ctx2.strokeStyle = AMBER(pulse);
        ctx2.lineWidth = 1.5;
        ctx2.stroke();
        ctx2.restore();
      } else if (nd.duplicated) {
        chamferPath(ctx2, x, y, NODE_W, NODE_H, CHAMFER);
        ctx2.strokeStyle = AMBER(0.25);
        ctx2.lineWidth = 1.5;
        ctx2.stroke();
      }

      const dColor = domainColor(nd.domain);
      chamferPath(ctx2, x, y, NODE_W, NODE_H, CHAMFER);
      ctx2.save();
      ctx2.shadowColor = "rgba(26,26,26,.10)";
      ctx2.shadowBlur = 12;
      ctx2.shadowOffsetY = 3;
      ctx2.fillStyle = "#FFFFFF";
      ctx2.fill();
      ctx2.restore();
      // white card, domain-colored border — bolder + red once focused;
      // critical nodes keep a slightly bolder border even unfocused
      ctx2.lineWidth = active ? 2.8 : critical ? 2.6 : 2.5;
      ctx2.strokeStyle = active ? RED : dColor;
      ctx2.stroke();
      drawBrackets(ctx2, x, y, NODE_W, NODE_H, 12, active ? "rgba(198,40,40,.85)" : "rgba(166,159,152,.6)");

      ctx2.textAlign = "left";
      ctx2.font = "600 14px 'JetBrains Mono', ui-monospace, monospace";
      ctx2.fillStyle = "#1A1A1A";
      const titled = nd.label.replace(/\b\w/g, (c) => c.toUpperCase());
      const lines = wrapLabel(ctx2, titled, NODE_W - 28);
      lines.forEach((ln, i) => ctx2.fillText(ln, x + 14, y + 20 + i * 16));
      // small domain-colored dot + label — the map's "color-coded by domain" cue
      ctx2.fillStyle = dColor;
      ctx2.beginPath(); ctx2.arc(x + 17, y + 51, 3, 0, Math.PI * 2); ctx2.fill();
      ctx2.font = "10.5px 'JetBrains Mono', ui-monospace, monospace";
      ctx2.fillStyle = dColor;
      ctx2.fillText((nd.domain || "unclassified").toUpperCase(), x + 26, y + 55);

      if (nd.duplicated) {
        const pulse = reduced ? 0.3 : 0.1 + 0.25 * (0.5 + 0.5 * Math.sin(t / 1100));
        ctx2.fillStyle = AMBER(0.4 + pulse);
        ctx2.beginPath(); ctx2.arc(x + NODE_W - 12, y + 12, 3.2, 0, Math.PI * 2); ctx2.fill();
      }
      ctx2.globalAlpha = 1;
    };

    // cursor tether: thin lines from the pointer out to the void hub and
    // whichever nodes are nearby, fading with distance — the map visibly
    // "reaches" toward the cursor instead of only reacting on exact hit-test
    const drawCursorTethers = (ctx2, sim, pts, cx, cy) => {
      if (!sim.mouse) return;
      const world = toWorld(sim.mouse.x, sim.mouse.y);
      const maxDist = (sim.R || 200) * 2.2;
      ctx2.lineWidth = 1;
      const hubD = Math.hypot(world.x - cx, world.y - cy);
      const hubOp = Math.pow(clamp01(1 - hubD / maxDist), 1.6) * 0.3;
      if (hubOp > 0.012) {
        ctx2.strokeStyle = `rgba(26,26,26,${hubOp.toFixed(3)})`;
        ctx2.beginPath(); ctx2.moveTo(world.x, world.y); ctx2.lineTo(cx, cy); ctx2.stroke();
      }
      for (const p of pts) {
        const d = Math.hypot(world.x - p.x, world.y - p.y);
        const op = Math.pow(clamp01(1 - d / maxDist), 1.6) * 0.38;
        if (op <= 0.012) continue;
        ctx2.strokeStyle = `rgba(26,26,26,${op.toFixed(3)})`;
        ctx2.beginPath(); ctx2.moveTo(world.x, world.y); ctx2.lineTo(p.x, p.y); ctx2.stroke();
      }
    };

    // easter egg hint: a small ghost drifts in every 5s until the code is
    // found, cycling through a couple of nudges — screen-space, corner-anchored,
    // never over the map itself. Stops for good once the code's been triggered.
    const EGG_HINTS = ["up up down down?", "there's a shortcut here", "try it — up up down down"];
    const drawEggHint = (ctx2, sim, w, h, t) => {
      if (sim.eggFound || reduced) return;
      const cycle = 5000, show = 2200;
      const since = t - sim.mounted;
      if (since < 4000) return; // let the build-sequence finish first
      const phase = since % cycle;
      if (phase > show) return;
      const fadeIn = Math.min(1, phase / 260);
      const fadeOut = Math.min(1, (show - phase) / 500);
      const op = Math.min(fadeIn, fadeOut) * 0.85;
      if (op <= 0.01) return;
      const idx = Math.floor(since / cycle) % EGG_HINTS.length;
      const drift = (1 - fadeIn) * 10;
      const x = w - 22 - drift, y = h - 26;
      ctx2.save();
      ctx2.textAlign = "right";
      ctx2.globalAlpha = op;
      ctx2.font = "13px 'JetBrains Mono', ui-monospace, monospace";
      ctx2.fillText("👻", x, y);
      ctx2.font = "10px 'JetBrains Mono', ui-monospace, monospace";
      ctx2.fillStyle = "rgba(58,53,48,.9)";
      ctx2.fillText(EGG_HINTS[idx], x - 20, y);
      ctx2.restore();
    };

    // easter egg: the short code briefly reconnects everything, just to
    // show what the portfolio would look like if it weren't fragmented
    const drawEasterEgg = (ctx2, sim, pts, cx, cy, t) => {
      if (!sim.eggStart) return;
      const dur = 2400;
      const el = t - sim.eggStart;
      if (el > dur) return;
      const op = el < 300 ? el / 300 : el > dur - 500 ? Math.max(0, (dur - el) / 500) : 1;
      ctx2.save();
      ctx2.strokeStyle = `rgba(42,122,122,${(op * 0.85).toFixed(3)})`;
      ctx2.lineWidth = 2;
      for (const e of sim.edges) {
        const a = pts[e.aIdx], b = pts[e.bIdx];
        ctx2.beginPath(); ctx2.moveTo(a.x, a.y); ctx2.lineTo(b.x, b.y); ctx2.stroke();
      }
      ctx2.fillStyle = `rgba(42,122,122,${op.toFixed(3)})`;
      ctx2.textAlign = "center";
      ctx2.font = "700 16px 'JetBrains Mono', ui-monospace, monospace";
      ctx2.fillText("ALL SYSTEMS CONNECTED", cx, cy - 92);
      ctx2.font = "10px 'JetBrains Mono', ui-monospace, monospace";
      ctx2.fillText("(for the next couple seconds, anyway)", cx, cy - 74);
      ctx2.restore();
    };

    const draw = (t) => {
      const sim = simRef.current;
      if (!sim) return;
      const { w, h } = dims.current;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;

      // the ambient dot-grid stays screen-fixed — a stable instrument
      // backdrop the diagram zooms into, not part of the "world"
      const trackOp = reduced ? 1 : clamp01((t - sim.mounted - sim.nodesDoneAt) / 420);
      if (staticLayer && trackOp > 0) {
        ctx.globalAlpha = trackOp;
        ctx.drawImage(staticLayer, 0, 0, w, h);
        ctx.globalAlpha = 1;
      }

      if (!sim.camera) return;
      const cam = currentCamera(sim, t);

      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);

      drawVoid(ctx, cx, cy, t, sim);

      const pts = sim.nodes.map((nd) => {
        const x = cx + nd.x, y = cy + nd.y;
        return { x, y, left: x - NODE_W / 2, top: y - NODE_H / 2 };
      });

      const hover = sim.hover;
      const activeDomains = !hover ? null
        : hover.kind === "edge" ? new Set([hover.edge.from, hover.edge.to])
        : new Set([hover.domain, ...sim.edges
            .filter((e) => e.from === hover.domain || e.to === hover.domain)
            .map((e) => (e.from === hover.domain ? e.to : e.from))]);
      const activeSelf = hover && hover.kind === "node" ? hover.domain : null;

      drawCursorTethers(ctx, sim, pts, cx, cy);

      for (const e of sim.edges) {
        const a = pts[e.aIdx], b = pts[e.bIdx];
        const isHoveredEdge = hover && hover.kind === "edge" && hover.edge === e;
        const touchesHover = hover && (hover.kind === "edge"
          ? hover.edge === e
          : (e.from === hover.domain || e.to === hover.domain));
        const dimmed = !!hover && !touchesHover;
        drawEdge(ctx, e, a, b, t, isHoveredEdge, dimmed);
      }

      sim.nodes.forEach((nd, i) => {
        const active = activeDomains ? (activeDomains.has(nd.domain) && nd.domain !== activeSelf) : false;
        const dimmed = activeDomains ? !activeDomains.has(nd.domain) : false;
        drawNode(ctx, nd, pts[i], t, sim, active, dimmed);
      });

      drawEasterEgg(ctx, sim, pts, cx, cy, t);

      ctx.restore();

      // screen-space, corner-anchored — drawn outside the world transform
      // so it never scales/pans with the camera
      drawEggHint(ctx, sim, w, h, t);
    };

    // self-heal the resting camera to the true current center/fit, once any
    // in-flight tween (e.g. the release animation) has finished — don't rely
    // solely on resize()/ResizeObserver firing, since a layout shift can
    // resize the canvas without either ever triggering, silently leaving the
    // camera glued to a stale center
    const healCamera = (sim, t) => {
      const cam = sim.camera;
      const tweenDone = !cam || t - cam.start >= cam.dur;
      if (!tweenDone) return;
      const { w, h } = dims.current;
      const cx = w / 2, cy = h / 2, z = sim.baseZoom || DEFAULT_ZOOM;
      if (!cam || cam.toX !== cx || cam.toY !== cy || cam.toZoom !== z) {
        sim.camera = { fromX: cx, fromY: cy, fromZoom: z, toX: cx, toY: cy, toZoom: z, start: 0, dur: 0 };
      }
    };

    let running = true;
    const loop = (t) => {
      if (!running) return;
      const sim = simRef.current;
      if (sim) {
        // freeze physics while something is focused, so the zoomed view
        // stays stable and readable instead of chasing a moving target
        if (!sim.selected) {
          const dt = t - (sim.lastStep || t);
          stepPhysics(sim.nodes, sim.relatedPairs, dt);
          healCamera(sim, t);
        }
        sim.lastStep = t;
      }
      draw(t);
      rafRef.current = requestAnimationFrame(loop);
    };

    const io = new IntersectionObserver(([entry]) => {
      running = entry.isIntersecting && !document.hidden;
      if (running && !reduced) {
        const sim = simRef.current;
        if (sim) sim.lastStep = performance.now();
        cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(loop);
      }
    }, { threshold: 0.01 });
    io.observe(canvas);
    const onVis = () => {
      running = !document.hidden;
      if (running && !reduced) {
        const sim = simRef.current;
        if (sim) sim.lastStep = performance.now();
        cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(loop);
      }
      else cancelAnimationFrame(rafRef.current);
    };
    document.addEventListener("visibilitychange", onVis);

    drawRef.current = draw;

    // paint one frame synchronously so the canvas is never blank before the
    // first rAF tick (also the only paint that happens if rAF is throttled,
    // e.g. a document that mounts hidden)
    draw(performance.now());
    if (!reduced) rafRef.current = requestAnimationFrame(loop);

    if (import.meta.env.DEV) {
      window.__voidDbg = () => {
        const sim = simRef.current;
        return {
          R: sim.R, hover: sim.hover, selected: sim.selected,
          camera: sim.camera, mounted: sim.mounted, baseZoom: sim.baseZoom, dims: dims.current,
          edges: sim.edges.map((e) => ({ from: e.from, to: e.to, severity: e.severity, label: e.label })),
          nodes: sim.nodes.map((n) => ({ domain: n.domain, label: n.label, duplicated: n.duplicated, data_touches: n.data_touches, x: n.x, y: n.y, appearAt: n.appearAt })),
        };
      };
      window.__voidDraw = (t) => draw(t ?? performance.now());
      window.__voidHit = (wx, wy) => hitTestWorld(wx, wy);
      window.__voidClickAt = (mx, my) => onClick({ clientX: mx + canvas.getBoundingClientRect().left, clientY: my + canvas.getBoundingClientRect().top });
      window.__voidTriggerEgg = () => { const sim = simRef.current; if (sim) sim.eggStart = performance.now(); };
      window.__voidCorruptCamera = (dx, dy) => {
        const sim = simRef.current;
        if (!sim || !sim.camera) return;
        const c = sim.camera;
        sim.camera = { ...c, fromX: c.toX + dx, fromY: c.toY + dy, toX: c.toX + dx, toY: c.toY + dy, start: 0, dur: 0 };
      };
      // manual physics stepper for testing under document.hidden (rAF paused there)
      window.__voidStepN = (n) => {
        const sim = simRef.current;
        if (!sim) return;
        for (let i = 0; i < (n || 30); i++) {
          if (!sim.selected) { stepPhysics(sim.nodes, sim.relatedPairs, 16); healCamera(sim, performance.now()); }
        }
        draw(performance.now());
      };
    }

    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", onResizeEvent);
      window.removeEventListener("keydown", onKeydown);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchend", onTouchEnd);
      cancelAnimationFrame(rafRef.current);
    };
  }, [graph, reduced]);

  const summary = `Fragmentation map: ${graph.nodes.length} systems, ${graph.missing_edges.length} missing connections, shared signal bus absent. Click any system or connection for an explanation.`;

  return <canvas ref={canvasRef} className="void-canvas" role="img" aria-label={summary} />;
}
