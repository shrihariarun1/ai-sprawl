import { useEffect, useRef, useState } from "react";

/*
  ResultsCanvas — the entire results page. A slow orbit of node cards around
  an empty "void" hub (the missing shared signal bus), red dashed lines for
  connections that should exist but do not, each bleeding a small pool of
  particles that travel halfway across the gap and die there — never reaching
  the other side. That failure, repeated, is the whole pitch.

  Clicking any node or edge focuses it: the orbit freezes, the camera tweens
  in on it, and the parent renders the explanation (App.jsx owns that text —
  this component only reports the selection). Clicking the same thing again,
  or empty canvas, releases focus and the camera eases back out.

  One <canvas>, one rAF loop for the component's life. Hover/click hit-testing
  runs against the same per-frame node/edge positions the draw pass uses, so
  there is only ever one source of truth for "where is everything right now."
*/

const RED = "#e5342a";
const AMBER = (a) => `rgba(180,120,20,${a})`;
const OMEGA = 0.00013;          // rad/frame — a further ~0.7x on top of the last pass
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
// Kept modest on purpose: at high zoom the camera re-centers on the focal
// point and pushes the far side of the orbit ring (and the void hub) outside
// the canvas bounds entirely — reads as the map "cutting out" rather than
// focusing. The graph must stay the hero, so a click emphasizes, never crops.
const NODE_ZOOM = 1.4;
const EDGE_ZOOM = 1.25;

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

export default function ResultsCanvas({ graph, onHoverChange, onSelectChange }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const simRef = useRef(null);
  const dims = useRef({ w: 0, h: 0, dpr: 1 });
  const [reduced] = useState(prefersReducedMotion);
  const onHoverChangeRef = useRef(onHoverChange);
  const onSelectChangeRef = useRef(onSelectChange);
  onHoverChangeRef.current = onHoverChange;
  onSelectChangeRef.current = onSelectChange;

  // ── build the simulation from the graph, once per diagnostic ──
  useEffect(() => {
    const n = graph.nodes.length;
    const nodes = graph.nodes.map((g, i) => ({
      ...g,
      angle0: (i / n) * Math.PI * 2,
      appearAt: i * 215,
      curOp: 1,
    }));
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

    simRef.current = {
      nodes, edges, nodesDoneAt, trackDoneAt, voidDoneAt,
      ringAngle: 0, mounted: performance.now(),
      mouse: null, hover: null, selected: null, camera: null,
      eggFound,
    };
  }, [graph]);

  // ── canvas setup: resize, rAF loop, mouse/click, pause off-screen ──
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let staticLayer = null; // offscreen: dot grid + orbit track, screen-space, never panned/zoomed

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
          const a = Math.max(0, 0.16 * (1 - d * 1.05));
          if (a <= 0.002) continue;
          octx.fillStyle = `rgba(150,150,190,${a.toFixed(3)})`;
          octx.beginPath(); octx.arc(x, y, 0.7, 0, Math.PI * 2); octx.fill();
        }
      }

      const sim = simRef.current;
      if (sim) {
        const R = orbitRadius(sim.nodes.length, w, h);
        sim.R = R;
        // the ring's world-space size is set purely to avoid card overlap;
        // whether that ring is bigger than the visible canvas is a separate
        // question, answered by zooming out rather than shrinking the ring
        // (which is what used to cause the taller 2-line cards to overlap
        // on short viewports) — camera zoom compensates for viewport fit.
        const ringSpan = 2 * R + NODE_W + 60;
        const fit = Math.min(w, h) / ringSpan;
        sim.baseZoom = Math.min(DEFAULT_ZOOM, Math.max(0.35, fit));
        const circ = 2 * Math.PI * R;
        const dotCount = Math.max(24, Math.round(circ / 3));
        octx.fillStyle = "rgba(40,40,60,.4)";
        for (let i = 0; i < dotCount; i++) {
          const a = (i / dotCount) * Math.PI * 2;
          octx.beginPath();
          octx.arc(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 1, 0, Math.PI * 2);
          octx.fill();
        }
      }
      staticLayer = off;
    };

    const orbitRadius = (n, w, h) => {
      // boxes are axis-aligned, not rotated to face outward, so at some
      // angles a neighbor's height eats into the gap as much as its width
      // would — budget for both, not just NODE_W, or tall 2-line labels
      // start overlapping the next card over on higher node counts.
      const arc = NODE_W + NODE_H + 30;
      return Math.max(170, (arc * n) / (2 * Math.PI));
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
      if (sim && !sim.camera) {
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

    // ── camera: eased pan/zoom tween, frozen orbit while focused ──
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
      if (!sim) return { cx: 0, cy: 0, R: 0, pts: [] };
      const { w, h } = dims.current;
      const cx = w / 2, cy = h / 2;
      const R = sim.R || 200;
      const pts = sim.nodes.map((nd) => {
        const a = nd.angle0 + sim.ringAngle;
        const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
        return { x, y, left: x - NODE_W / 2, top: y - NODE_H / 2 };
      });
      return { cx, cy, R, pts };
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
          ctx2.strokeStyle = `rgba(229,52,42,${a.toFixed(3)})`;
          ctx2.lineWidth = 1;
          ctx2.beginPath(); ctx2.arc(cx, cy, r, 0, Math.PI * 2); ctx2.stroke();
        }
      } else {
        ctx2.strokeStyle = "rgba(229,52,42,.14)";
        ctx2.lineWidth = 1;
        ctx2.beginPath(); ctx2.arc(cx, cy, innerR + 20, 0, Math.PI * 2); ctx2.stroke();
      }

      ctx2.fillStyle = "#04020a";
      ctx2.beginPath(); ctx2.arc(cx, cy, innerR, 0, Math.PI * 2); ctx2.fill();
      ctx2.setLineDash([3, 4]);
      ctx2.strokeStyle = "rgba(229,52,42,.3)";
      ctx2.lineWidth = 1;
      ctx2.beginPath(); ctx2.arc(cx, cy, innerR, 0, Math.PI * 2); ctx2.stroke();
      ctx2.setLineDash([]);

      if (born > 0.6) {
        ctx2.fillStyle = "rgba(224,90,80,.9)";
        ctx2.font = "9px 'IBM Plex Mono', ui-monospace, monospace";
        ctx2.textAlign = "center";
        ctx2.fillText("NO SHARED", cx, cy - 4);
        ctx2.fillText("SIGNAL BUS", cx, cy + 9);
      }
    };

    // ── one missing edge: dashed reveal, gap wash, particle pool ──
    const drawEdge = (ctx2, e, a, b, t, active, dimmed) => {
      const since = t - simRef.current.mounted;
      const localT = reduced ? 1 : since - e.startAt;
      if (!reduced && localT < 0) return;

      const targetOp = dimmed ? 0.28 : active ? 1 : 0.5;
      e.curOp = e.curOp == null || reduced ? targetOp : e.curOp + (targetOp - e.curOp) * OPACITY_EASE;

      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      let frac; // 0..1 fraction of the src->dst path currently drawn
      if (reduced) frac = 1;
      else if (localT < e.toMid) frac = 0.5 * easeOutCubic(clamp01(localT / e.toMid));
      else if (localT < e.toMid + e.pause) frac = 0.5;
      else frac = 0.5 + 0.5 * easeOutCubic(clamp01((localT - e.toMid - e.pause) / e.midToEnd));

      const ex = lerp(a.x, b.x, frac), ey = lerp(a.y, b.y, frac);
      const width = active ? 2.2 : 1.3;
      // default/dimmed lines read as white (calm, informational — "this
      // connection is missing"); red is reserved for the one you're
      // actually focused on right now, same as the active node border
      const lineRGB = active ? "229,52,42" : "255,255,255";

      // gap wash: transparent at both ends, brightest at the true midpoint
      const grad = ctx2.createLinearGradient(a.x, a.y, b.x, b.y);
      const washPeak = (active ? 0.28 : 0.08) * (e.curOp / (active ? 1 : dimmed ? 0.28 : 0.5));
      grad.addColorStop(0, `rgba(${lineRGB},0)`);
      grad.addColorStop(0.5, `rgba(${lineRGB},${clamp01(washPeak).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${lineRGB},0)`);
      ctx2.strokeStyle = grad;
      ctx2.lineWidth = 15;
      ctx2.beginPath(); ctx2.moveTo(a.x, a.y); ctx2.lineTo(ex, ey); ctx2.stroke();

      ctx2.strokeStyle = `rgba(${lineRGB},${e.curOp.toFixed(3)})`;
      ctx2.lineWidth = width;
      ctx2.setLineDash([4, 5]);
      ctx2.beginPath(); ctx2.moveTo(a.x, a.y); ctx2.lineTo(ex, ey); ctx2.stroke();
      ctx2.setLineDash([]);

      const doneForParticles = reduced || since >= e.doneAt;
      if (doneForParticles && !reduced) {
        updateAndDrawParticles(ctx2, e, a, mx, my, active, dimmed, since);
      }

      if (doneForParticles) {
        const labelOp = dimmed ? 0.4 : active ? 1 : 0.8;
        ctx2.font = "9.5px 'IBM Plex Mono', ui-monospace, monospace";
        const text = e.label;
        const tw = ctx2.measureText(text).width;
        ctx2.fillStyle = "#000";
        ctx2.fillRect(mx - tw / 2 - 7, my - 10, tw + 14, 18);
        ctx2.fillStyle = active ? "#ff5c50" : `rgba(255,255,255,${labelOp.toFixed(3)})`;
        ctx2.textAlign = "center";
        ctx2.fillText(text, mx, my + 4);
      }
    };

    const updateAndDrawParticles = (ctx2, e, a, mx, my, active, dimmed, since) => {
      const cycle = PARTICLE_TRAVEL + PARTICLE_REST;
      const rBase = (active ? 3.8 : 2.3);
      const op = dimmed ? 0.28 : active ? 1 : 0.55;
      const rgb = active ? "229,52,42" : "255,255,255";
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

      chamferPath(ctx2, x, y, NODE_W, NODE_H, CHAMFER);
      ctx2.fillStyle = "#000";
      ctx2.fill();
      ctx2.lineWidth = active ? 1.6 : 1;
      ctx2.strokeStyle = active ? RED : "rgba(40,40,60,.8)";
      ctx2.stroke();
      drawBrackets(ctx2, x, y, NODE_W, NODE_H, 12, active ? "rgba(229,52,42,.85)" : "rgba(70,70,95,.9)");

      ctx2.textAlign = "left";
      ctx2.font = "600 14px 'IBM Plex Mono', ui-monospace, monospace";
      ctx2.fillStyle = active ? "#ffcccc" : "#c8c8d0";
      const titled = nd.label.replace(/\b\w/g, (c) => c.toUpperCase());
      const lines = wrapLabel(ctx2, titled, NODE_W - 28);
      lines.forEach((ln, i) => ctx2.fillText(ln, x + 14, y + 20 + i * 16));
      ctx2.font = "10.5px 'IBM Plex Mono', ui-monospace, monospace";
      ctx2.fillStyle = "rgba(95,95,118,.9)";
      ctx2.fillText((nd.domain || "unclassified").toUpperCase(), x + 14, y + 55);

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
        ctx2.strokeStyle = `rgba(255,255,255,${hubOp.toFixed(3)})`;
        ctx2.beginPath(); ctx2.moveTo(world.x, world.y); ctx2.lineTo(cx, cy); ctx2.stroke();
      }
      for (const p of pts) {
        const d = Math.hypot(world.x - p.x, world.y - p.y);
        const op = Math.pow(clamp01(1 - d / maxDist), 1.6) * 0.38;
        if (op <= 0.012) continue;
        ctx2.strokeStyle = `rgba(255,255,255,${op.toFixed(3)})`;
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
      ctx2.font = "13px 'IBM Plex Mono', ui-monospace, monospace";
      ctx2.fillText("👻", x, y);
      ctx2.font = "10px 'IBM Plex Mono', ui-monospace, monospace";
      ctx2.fillStyle = "rgba(200,200,215,.9)";
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
      ctx2.strokeStyle = `rgba(90,230,140,${(op * 0.85).toFixed(3)})`;
      ctx2.lineWidth = 2;
      for (const e of sim.edges) {
        const a = pts[e.aIdx], b = pts[e.bIdx];
        ctx2.beginPath(); ctx2.moveTo(a.x, a.y); ctx2.lineTo(b.x, b.y); ctx2.stroke();
      }
      ctx2.fillStyle = `rgba(90,230,140,${op.toFixed(3)})`;
      ctx2.textAlign = "center";
      ctx2.font = "700 16px 'IBM Plex Mono', ui-monospace, monospace";
      ctx2.fillText("ALL SYSTEMS CONNECTED", cx, cy - 92);
      ctx2.font = "10px 'IBM Plex Mono', ui-monospace, monospace";
      ctx2.fillText("(for the next couple seconds, anyway)", cx, cy - 74);
      ctx2.restore();
    };

    const draw = (t) => {
      const sim = simRef.current;
      if (!sim) return;
      const { w, h } = dims.current;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;

      // the ambient grid + orbit track stay screen-fixed — a stable
      // instrument backdrop the diagram zooms into, not part of the "world"
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

      const R = sim.R || 200;
      const pts = sim.nodes.map((nd) => {
        const a = nd.angle0 + sim.ringAngle;
        const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
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

    let running = true;
    const loop = (t) => {
      if (!running) return;
      const sim = simRef.current;
      // freeze the orbit while something is focused, so the zoomed view
      // stays stable and readable instead of chasing a moving target
      if (sim && !sim.selected) sim.ringAngle += OMEGA * 16.6;
      draw(t);
      rafRef.current = requestAnimationFrame(loop);
    };

    const io = new IntersectionObserver(([entry]) => {
      running = entry.isIntersecting && !document.hidden;
      if (running && !reduced) { cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(loop); }
    }, { threshold: 0.01 });
    io.observe(canvas);
    const onVis = () => {
      running = !document.hidden;
      if (running && !reduced) { cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(loop); }
      else cancelAnimationFrame(rafRef.current);
    };
    document.addEventListener("visibilitychange", onVis);

    // paint one frame synchronously so the canvas is never blank before the
    // first rAF tick (also the only paint that happens if rAF is throttled,
    // e.g. a document that mounts hidden)
    draw(performance.now());
    if (!reduced) rafRef.current = requestAnimationFrame(loop);

    if (import.meta.env.DEV) {
      window.__voidDbg = () => {
        const sim = simRef.current;
        return {
          R: sim.R, ringAngle: sim.ringAngle, hover: sim.hover, selected: sim.selected,
          camera: sim.camera, mounted: sim.mounted,
          edges: sim.edges.map((e) => ({ from: e.from, to: e.to, severity: e.severity, label: e.label })),
          nodes: sim.nodes.map((n) => ({ domain: n.domain, label: n.label, duplicated: n.duplicated, appearAt: n.appearAt })),
        };
      };
      window.__voidDraw = (t) => draw(t ?? performance.now());
      window.__voidHit = (wx, wy) => hitTestWorld(wx, wy);
      window.__voidClickAt = (mx, my) => onClick({ clientX: mx + canvas.getBoundingClientRect().left, clientY: my + canvas.getBoundingClientRect().top });
      window.__voidTriggerEgg = () => { const sim = simRef.current; if (sim) sim.eggStart = performance.now(); };
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
