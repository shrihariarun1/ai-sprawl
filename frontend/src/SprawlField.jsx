import { useEffect, useRef, useState, useCallback } from "react";

/*
  SprawlField — the signature interaction for the AI Sprawl Map hero.

  State machine (driven by props.phase):
    chaos   : nodes drift + repel loosely, orphans pulse amber, faint dashed
              "no shared context" lines flicker between nearby nodes.
    mapped  : nodes travel — staggered, eased — into clustered islands that
              DO NOT connect to each other. Singleton domains stay amber.
              Exactly one red edge is earned inside a single island, after the
              settle, held. The empty gaps between islands are the pitch.

  Physics is dependency-free and O(n^2); n stays small (< ~40). One rAF loop for
  the component's life; phase is read from a ref so switching never restarts it.
  Off-screen and hidden tabs pause. prefers-reduced-motion renders a static
  scattered (chaos) / clustered (mapped) frame with no rAF.
*/

const C = {
  node: "#3A322A",       // dark ink settled node — visible on the warm paper field
  orphan: "#C97C3D",     // warning amber — disconnected / singleton island
  connect: "#2A7A7A",    // success teal — earned only on a real connection
  edgeRGB: "58,53,48",
};
const PHRASE = "no shared context";

// ambient shooting stars — purely decorative, phase-independent, so the
// paper-colored field doesn't read as empty between node interactions
const STAR_RGB = ["58,53,48", "58,53,48", "58,53,48", "198,40,40", "201,124,61"];

const AMBIENT = [
  ["fraud detection model", "fraud"],
  ["KYC document parser", "identity"],
  ["customer support chatbot", "support"],
  ["invoice OCR", "documents"],
  ["churn predictor", "marketing"],
  ["analytics copilot", "analytics"],
];

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

export default function SprawlField({
  initiatives = [],
  categoryOf,            // (label) => string | null  (domain key)
  phase = "chaos",       // "chaos" | "mapped"
  className,
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const nodesRef = useRef([]);
  const starsRef = useRef([]);
  const nextStarAt = useRef(0);
  const dims = useRef({ w: 0, h: 0, dpr: 1 });
  const phaseRef = useRef(phase);
  const phaseStart = useRef(0);
  const mountAt = useRef(0);
  const clusterK = useRef(4);
  const [reduced] = useState(prefersReducedMotion);

  const spawn = useCallback((label, category, ambient = false) => {
    const { w, h } = dims.current;
    const edge = Math.random();
    let x, y;
    if (edge < 0.25) { x = 0; y = Math.random() * h; }
    else if (edge < 0.5) { x = w; y = Math.random() * h; }
    else if (edge < 0.75) { x = Math.random() * w; y = 0; }
    else { x = Math.random() * w; y = h; }
    return {
      label, category, ambient,
      x, y,
      hx: w / 2 + (Math.random() - 0.5) * w * 0.72,   // chaos home
      hy: h / 2 + (Math.random() - 0.5) * h * 0.66,
      tx: x, ty: y,
      vx: 0, vy: 0,
      r: 2.6 + Math.random() * 2.2,
      jx: (Math.random() - 0.5) * 10,
      jy: (Math.random() - 0.5) * 10,
      pulse: Math.random() * Math.PI * 2,
      appearDelay: 0,
      k: 0, ki: 0, ksize: 1, delay: 0,
    };
  }, []);

  const seedAmbient = useCallback(() => {
    return AMBIENT.map(([label, cat], i) => {
      const n = spawn(label, cat, true);
      n.appearDelay = i * 90;
      return n;
    });
  }, [spawn]);

  // group nodes into islands by domain; stable indices, delays for stagger
  const assignClusters = useCallback(() => {
    const nodes = nodesRef.current;
    const keyOf = (n) => (n.category != null ? String(n.category) : "h" + (hash(n.label) % 97));
    const keys = [...new Set(nodes.map(keyOf))].sort();
    const k = Math.max(2, Math.min(keys.length, 6));
    const counts = {};
    for (const n of nodes) {
      n.k = keys.indexOf(keyOf(n)) % k;
      n.ki = counts[n.k] || 0;
      counts[n.k] = n.ki + 1;
    }
    for (const n of nodes) n.ksize = counts[n.k];
    for (const n of nodes) n.delay = n.k * 130 + n.ki * 55;
    clusterK.current = k;
  }, []);

  // ── sync typed initiatives with the node set ─────────────
  useEffect(() => {
    const labels = initiatives.map((s) => (s || "").trim()).filter(Boolean);
    if (labels.length === 0) {
      if (!nodesRef.current.some((n) => n.ambient) || nodesRef.current.length === 0) {
        nodesRef.current = seedAmbient();
      }
      return;
    }
    nodesRef.current = nodesRef.current.filter((n) => !n.ambient);
    const existing = new Set(nodesRef.current.map((n) => n.label));
    const now = performance.now();
    labels.forEach((label) => {
      if (!existing.has(label)) {
        const n = spawn(label, categoryOf ? categoryOf(label) : null);
        n.pop = now;
        nodesRef.current.push(n);
      }
    });
    const wanted = new Set(labels);
    nodesRef.current = nodesRef.current.filter((n) => wanted.has(n.label));
  }, [initiatives, categoryOf, spawn, seedAmbient]);

  // ── react to phase changes without restarting the loop ───
  useEffect(() => {
    phaseRef.current = phase;
    if (phase === "mapped") { assignClusters(); phaseStart.current = performance.now(); }
    if (reduced) renderRef.current && renderRef.current();
  }, [phase, assignClusters, reduced]);

  const renderRef = useRef(null);

  // ── main setup: one loop for the component's life ────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    mountAt.current = performance.now();
    nextStarAt.current = mountAt.current + 1800 + Math.random() * 1500;

    // reseat a node against real dims: fresh chaos home + an off-screen entry
    const reseat = (n, w, h) => {
      n.hx = w / 2 + (Math.random() - 0.5) * w * 0.72;
      n.hy = h / 2 + (Math.random() - 0.5) * h * 0.66;
      const edge = Math.random();
      if (edge < 0.25) { n.x = 0; n.y = Math.random() * h; }
      else if (edge < 0.5) { n.x = w; n.y = Math.random() * h; }
      else if (edge < 0.75) { n.x = Math.random() * w; n.y = 0; }
      else { n.x = Math.random() * w; n.y = h; }
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const prev = dims.current;
      dims.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const firstReal = !prev.w || !prev.h;
      if (firstReal) {
        for (const n of nodesRef.current) reseat(n, rect.width, rect.height);
        mountAt.current = performance.now();          // stagger the reveal from now
      } else {
        const sx = rect.width / prev.w, sy = rect.height / prev.h;
        for (const n of nodesRef.current) { n.hx *= sx; n.hy *= sy; n.x *= sx; n.y *= sy; }
      }
    };

    if (nodesRef.current.length === 0) nodesRef.current = seedAmbient();
    resize();
    window.addEventListener("resize", resize);
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);

    // shooting star: a gradient line trailing a bright head, crossing the
    // field diagonally and gone before it feels like a repeating loop
    const spawnStar = (t) => {
      const { w, h } = dims.current;
      const dir = Math.random() < 0.5 ? -1 : 1;
      const angle = (25 + Math.random() * 20) * (Math.PI / 180);
      const vx = Math.cos(angle) * dir, vy = Math.sin(angle);
      const x0 = dir > 0 ? -40 + Math.random() * w * 0.25 : w * 0.75 + Math.random() * (w * 0.25 + 40);
      const y0 = -30 - Math.random() * 60;
      const speed = 0.62 + Math.random() * 0.3; // px/ms
      starsRef.current.push({
        x0, y0, vx, vy, speed,
        len: 90 + Math.random() * 90,
        born: t, life: 900 + Math.random() * 500,
        rgb: STAR_RGB[Math.floor(Math.random() * STAR_RGB.length)],
      });
      nextStarAt.current = t + 3400 + Math.random() * 4200;
    };
    const updateStars = (t) => {
      if (t >= nextStarAt.current && starsRef.current.length < 2) spawnStar(t);
      starsRef.current = starsRef.current.filter((s) => t - s.born < s.life);
    };
    const drawStars = (ctx2, t) => {
      for (const s of starsRef.current) {
        const age = t - s.born;
        const op = age < 120 ? age / 120 : age > s.life - 260 ? Math.max(0, (s.life - age) / 260) : 1;
        if (op <= 0.01) continue;
        const hx = s.x0 + s.vx * s.speed * age, hy = s.y0 + s.vy * s.speed * age;
        const tx = hx - s.vx * s.len, ty = hy - s.vy * s.len;
        const grad = ctx2.createLinearGradient(tx, ty, hx, hy);
        grad.addColorStop(0, `rgba(${s.rgb},0)`);
        grad.addColorStop(1, `rgba(${s.rgb},${(0.75 * op).toFixed(3)})`);
        ctx2.strokeStyle = grad;
        ctx2.lineWidth = 1.1;
        ctx2.beginPath(); ctx2.moveTo(tx, ty); ctx2.lineTo(hx, hy); ctx2.stroke();
        ctx2.fillStyle = `rgba(${s.rgb},${op.toFixed(3)})`;
        ctx2.beginPath(); ctx2.arc(hx, hy, 1.4, 0, Math.PI * 2); ctx2.fill();
      }
    };

    const centersK = (k) => {
      const { w, h } = dims.current;
      const cols = Math.ceil(Math.sqrt(k));
      const rows = Math.ceil(k / cols);
      const out = [];
      for (let c = 0; c < k; c++) {
        const cx = ((c % cols) + 0.5) / cols;
        const cy = (Math.floor(c / cols) + 0.5) / rows;
        out.push({ x: (0.16 + cx * 0.68) * w, y: (0.2 + cy * 0.6) * h });
      }
      return out;
    };

    const integrate = (t) => {
      const { w, h } = dims.current;
      const nodes = nodesRef.current;
      const mapped = phaseRef.current === "mapped";
      const centers = mapped ? centersK(clusterK.current) : null;
      const elapsed = t - phaseStart.current;

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (mapped) {
          const active = elapsed > n.delay;
          const ctr = centers[n.k];
          const ang = (n.ki / Math.max(1, n.ksize)) * Math.PI * 2;
          const rad = n.ksize === 1 ? 0 : Math.min(64, 22 + n.ksize * 4);
          n.tx = ctr.x + Math.cos(ang) * rad + n.jx;
          n.ty = ctr.y + Math.sin(ang) * rad + n.jy;
          const pull = active ? 0.09 : 0.008;
          n.vx += (n.tx - n.x) * pull;
          n.vy += (n.ty - n.y) * pull;
        } else {
          for (let j = i + 1; j < nodes.length; j++) {
            const m = nodes[j];
            let dx = n.x - m.x, dy = n.y - m.y;
            let d2 = dx * dx + dy * dy || 1;
            if (d2 < 8200) {
              const f = 42 / d2;
              const d = Math.sqrt(d2);
              dx /= d; dy /= d;
              n.vx += dx * f; n.vy += dy * f;
              m.vx -= dx * f; m.vy -= dy * f;
            }
          }
          n.tx = n.hx + Math.cos(t / 2600 + n.pulse) * 18;
          n.ty = n.hy + Math.sin(t / 2600 + n.pulse) * 18;
          n.vx += (n.tx - n.x) * 0.010;
          n.vy += (n.ty - n.y) * 0.010;
        }
        n.vx *= 0.86; n.vy *= 0.86;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(6, Math.min(w - 6, n.x));
        n.y = Math.max(6, Math.min(h - 6, n.y));
      }
      if (!reduced) updateStars(t);
    };

    const draw = (t) => {
      const { w, h } = dims.current;
      const nodes = nodesRef.current;
      const mapped = phaseRef.current === "mapped";
      const elapsed = t - phaseStart.current;
      ctx.clearRect(0, 0, w, h);
      if (!reduced) drawStars(ctx, t);

      if (!mapped) {
        // faint "no shared context" edges; flicker a couple of phrase labels
        ctx.lineWidth = 0.6;
        ctx.setLineDash([3, 6]);
        let phrases = 0;
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const n = nodes[i], m = nodes[j];
            const dx = n.x - m.x, dy = n.y - m.y;
            const d = Math.hypot(dx, dy);
            if (d < 150) {
              const fl = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t / 900 + (i + j));
              ctx.strokeStyle = `rgba(${C.edgeRGB},${((1 - d / 150) * 0.5 * (0.5 + fl * 0.5)).toFixed(3)})`;
              ctx.beginPath();
              ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y); ctx.stroke();
              if (phrases < 2 && d > 78 && d < 118 && (i * 7 + j) % 5 === 0) {
                phrases++;
                const a = reduced ? 0.16 : 0.06 + 0.1 * Math.abs(Math.sin(t / 1300 + i));
                ctx.setLineDash([]);
                ctx.fillStyle = `rgba(${C.edgeRGB},${a.toFixed(3)})`;
                ctx.font = "9px 'JetBrains Mono', ui-monospace, monospace";
                ctx.textAlign = "center";
                ctx.fillText(PHRASE, (n.x + m.x) / 2, (n.y + m.y) / 2 - 4);
                ctx.setLineDash([3, 6]);
              }
            }
          }
        }
        ctx.setLineDash([]);
      } else {
        const centers = centersK(clusterK.current);
        // within-island edges: local context exists
        ctx.setLineDash([2, 4]);
        ctx.lineWidth = 0.7;
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const n = nodes[i], m = nodes[j];
            if (n.k !== m.k) continue;
            const d = Math.hypot(n.x - m.x, n.y - m.y);
            if (d < 120) {
              ctx.strokeStyle = `rgba(${C.edgeRGB},${((1 - d / 120) * 0.28).toFixed(3)})`;
              ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y); ctx.stroke();
            }
          }
        }
        // severed bridges: dashed stubs reach from each island toward the next,
        // then stop — the connection that does not exist.
        const bridgeA = clamp01((elapsed - 900) / 700);
        if (bridgeA > 0 && centers.length > 1) {
          ctx.setLineDash([4, 7]);
          ctx.lineWidth = 0.8;
          for (let a = 0; a < centers.length; a++) {
            for (let b = a + 1; b < centers.length; b++) {
              const A = centers[a], B = centers[b];
              const dx = B.x - A.x, dy = B.y - A.y;
              const len = Math.hypot(dx, dy) || 1;
              if (len > 520) continue;
              const ux = dx / len, uy = dy / len;
              ctx.strokeStyle = `rgba(${C.edgeRGB},${(0.14 * bridgeA).toFixed(3)})`;
              ctx.beginPath();
              ctx.moveTo(A.x + ux * 46, A.y + uy * 46);
              ctx.lineTo(A.x + ux * (len * 0.34), A.y + uy * (len * 0.34));
              ctx.stroke();
              ctx.beginPath();
              ctx.moveTo(B.x - ux * 46, B.y - uy * 46);
              ctx.lineTo(B.x - ux * (len * 0.34), B.y - uy * (len * 0.34));
              ctx.stroke();
            }
          }
        }
        ctx.setLineDash([]);

        // the single earned connection — inside the largest multi-node island
        const earnedA = clamp01((elapsed - 1600) / 700);
        if (earnedA > 0) {
          let best = -1, bestSize = 1;
          const sizes = {};
          for (const n of nodes) sizes[n.k] = (sizes[n.k] || 0) + 1;
          for (const kk in sizes) if (sizes[kk] > bestSize) { bestSize = sizes[kk]; best = +kk; }
          if (best >= 0) {
            const isl = nodes.filter((n) => n.k === best).slice(0, 2);
            if (isl.length === 2) {
              ctx.save();
              ctx.strokeStyle = `rgba(42,122,122,${(0.9 * earnedA).toFixed(3)})`;
              ctx.lineWidth = 1.4;
              ctx.shadowColor = "rgba(42,122,122,0.6)";
              ctx.shadowBlur = 10 * earnedA;
              ctx.beginPath();
              ctx.moveTo(isl[0].x, isl[0].y); ctx.lineTo(isl[1].x, isl[1].y); ctx.stroke();
              ctx.restore();
            }
          }
        }
      }

      // nodes
      const now = t - mountAt.current;
      for (const n of nodes) {
        const intro = reduced ? 1 : easeOutCubic(clamp01((now - n.appearDelay) / 520));
        const pop = n.pop ? easeOutCubic(clamp01((t - n.pop) / 360)) : 1;
        const grow = Math.min(intro, pop);
        if (grow <= 0) continue;
        const orphan = mapped ? n.ksize === 1 : true;
        const pulse = orphan && !reduced ? 0.55 + 0.45 * Math.sin(t / 520 + n.pulse) : 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * grow, 0, Math.PI * 2);
        ctx.fillStyle = orphan ? C.orphan : C.node;
        ctx.globalAlpha = (orphan ? 0.5 + pulse * 0.45 : 0.92) * grow;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const renderOnce = () => {
      const nodes = nodesRef.current;
      const mapped = phaseRef.current === "mapped";
      if (mapped) {
        const centers = centersK(clusterK.current);
        for (const n of nodes) {
          const ctr = centers[n.k];
          const ang = (n.ki / Math.max(1, n.ksize)) * Math.PI * 2;
          const rad = n.ksize === 1 ? 0 : Math.min(64, 22 + n.ksize * 4);
          n.x = ctr.x + Math.cos(ang) * rad + n.jx;
          n.y = ctr.y + Math.sin(ang) * rad + n.jy;
        }
        phaseStart.current = performance.now() - 3000; // show settled state
      } else {
        for (const n of nodes) { n.x = n.hx; n.y = n.hy; }
      }
      draw(performance.now());
    };
    renderRef.current = renderOnce;

    let running = true;
    const loop = () => {
      if (!running) return;
      const t = performance.now();
      integrate(t);
      draw(t);
      rafRef.current = requestAnimationFrame(loop);
    };

    const io = new IntersectionObserver(([e]) => {
      running = e.isIntersecting && !document.hidden;
      if (running && !reduced) { cancelAnimationFrame(rafRef.current); loop(); }
    }, { threshold: 0.01 });
    io.observe(canvas);

    const onVis = () => {
      running = !document.hidden;
      if (running && !reduced) { cancelAnimationFrame(rafRef.current); loop(); }
      else cancelAnimationFrame(rafRef.current);
    };
    document.addEventListener("visibilitychange", onVis);

    // never leave the canvas blank before rAF: reduced-motion gets the full
    // static frame; everyone else gets one paint then the entrance animation
    // (nodes stream in from the edges and settle into the drift).
    if (reduced) renderOnce();
    else { draw(performance.now()); loop(); }

    if (import.meta.env.DEV && typeof window !== "undefined") {
      window.__sprawlDbg = () => ({
        phase: phaseRef.current,
        dims: { ...dims.current },
        k: clusterK.current,
        nodes: nodesRef.current.map((n) => ({
          label: n.label, x: Math.round(n.x), y: Math.round(n.y),
          k: n.k, ki: n.ki, ksize: n.ksize, ambient: !!n.ambient,
        })),
      });
      window.__sprawlSnap = (ph) => {
        const keep = phaseRef.current;
        phaseRef.current = ph;
        if (ph === "mapped") assignClusters();
        renderOnce();
        phaseRef.current = keep;
      };
      window.__starSpawn = () => { spawnStar(performance.now()); draw(performance.now()); return starsRef.current.length; };
      window.__starDbg = () => starsRef.current.map((s) => ({ ...s }));
      window.__fieldDraw = (t) => draw(t ?? performance.now());
    }

    return () => {
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, seedAmbient]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height: "100%", display: "block" }}
      aria-hidden="true"
    />
  );
}
