import { $, motionPreference, stationPosition, graphPositions, userGraphPosition, PACKET_MS, ui, model, room, speechEnd } from "./state.js";
import { renderOffice } from "./office.js";
import { renderGraph } from "./flow.js";

export function curve(from: [number, number], to: [number, number]) {
  return [(from[0] + to[0]) / 2 + 12, (from[1] + to[1]) / 2 - 20] as [number, number];
}

export function pointOn(from: [number, number], ctrl: [number, number], to: [number, number], t: number) {
  const u = 1 - t;
  return [u * u * from[0] + 2 * u * t * ctrl[0] + t * t * to[0], u * u * from[1] + 2 * u * t * ctrl[1] + t * t * to[1]] as [number, number];
}

export function drawCanvas(canvas: HTMLCanvasElement, kind: "room" | "flow", now: number) {
  if (canvas.closest("[hidden]") || !ui.model) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d")!;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  const current = room();
  const positions = new Map<string, [number, number]>();
  positions.set("user", kind === "flow" ? [(rect.width * userGraphPosition[0]) / 100, (rect.height * userGraphPosition[1]) / 100] : [rect.width * 0.5, rect.height - 14]);
  current.members.forEach((id, index) => {
    const percent = kind === "flow" ? graphPositions[index % graphPositions.length]! : stationPosition(index, current.members.length);
    positions.set(id, [(rect.width * percent[0]) / 100, (rect.height * percent[1]) / 100 + (kind === "room" ? 35 : 0)]);
  });
  const edges = new Map<string, { from: string; to: string; kind: "dispatch" | "explicit" | "inferred" }>();
  if (kind === "room" && current.mode === "coordinator" && current.coordinator) {
    for (const memberId of current.members) {
      if (memberId !== current.coordinator) edges.set(`d-${memberId}`, { from: current.coordinator, to: memberId, kind: "dispatch" });
    }
  } else if (kind === "flow") {
    const scoped = model().messages.filter((m) => m.conversationId === current.id && (ui.traceFilter === "all" || m.traceId === ui.traceFilter));
    const byId = new Map(scoped.map((m) => [m.id, m]));
    for (const message of scoped) {
      for (const recipient of message.recipients) edges.set(`${message.sender}-${recipient}`, { from: message.sender, to: recipient, kind: "explicit" });
    }
    // A reply to a causal parent that produced no delivery back is a relation we infer, not one the Bus carried.
    for (const message of scoped) {
      const parent = message.parentId ? byId.get(message.parentId) : undefined;
      if (!parent || parent.sender === message.sender) continue;
      const key = `${message.sender}-${parent.sender}`;
      if (!edges.has(key)) edges.set(key, { from: message.sender, to: parent.sender, kind: "inferred" });
    }
  }
  // Open floor / mentions / manual: no fixed member links in the room, only packets in transit
  context.lineWidth = 1.2;
  for (const edge of edges.values()) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const ctrl = curve(from, to);
    context.strokeStyle =
      edge.kind === "dispatch" ? "#d9a07470" : edge.kind === "explicit" ? (kind === "flow" ? "#5f9c7faa" : "#77927d65") : "#c8b79a70";
    context.lineWidth = edge.kind === "explicit" && kind === "flow" ? 1.4 : 1.2;
    context.setLineDash(edge.kind === "inferred" ? [3, 5] : edge.kind === "dispatch" ? [7, 6] : []);
    // dispatch lines flow from the coordinator outward
    context.lineDashOffset = edge.kind === "dispatch" && !ui.animationPaused ? -now / 45 : 0;
    context.beginPath();
    context.moveTo(...from);
    context.quadraticCurveTo(...ctrl, ...to);
    context.stroke();
    context.setLineDash([]);
    context.lineDashOffset = 0;
    const [x, y] = pointOn(from, ctrl, to, 0.72);
    const [bx, by] = pointOn(from, ctrl, to, 0.68);
    const angle = Math.atan2(y - by, x - bx);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x - 5 * Math.cos(angle - 0.5), y - 5 * Math.sin(angle - 0.5));
    context.moveTo(x, y);
    context.lineTo(x - 5 * Math.cos(angle + 0.5), y - 5 * Math.sin(angle + 0.5));
    context.stroke();
  }
  if (ui.animationPaused) return;
  for (const packet of ui.packets.filter((p) => p.roomId === current.id)) {
    const from = positions.get(packet.from);
    const to = positions.get(packet.to);
    if (!from || !to) continue;
    const ctrl = curve(from, to);
    const raw = Math.min(1, (now - packet.startedAt) / PACKET_MS);
    const progress = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
    const color = packet.artifact ? "#c98a4e" : "#dfa178";
    // comet trail
    const trail = 14;
    for (let i = trail; i >= 1; i -= 1) {
      const t = Math.max(0, progress - i * 0.012);
      const [x, y] = pointOn(from, ctrl, to, t);
      context.globalAlpha = 0.42 * (1 - i / (trail + 1)) ** 1.6;
      context.fillStyle = color;
      context.beginPath();
      context.arc(x, y, 2.6 * (1 - i / (trail + 2)), 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    const [x, y] = pointOn(from, ctrl, to, progress);
    const [bx, by] = pointOn(from, ctrl, to, Math.max(0, progress - 0.01));
    drawEnvelope(context, x, y, Math.atan2(y - by, x - bx), packet.artifact, kind === "flow" ? 16 : 10);
    if (raw > 0.82) {
      const ring = (raw - 0.82) / 0.18;
      for (const [offset, alpha] of [[0, 0.55], [9, 0.3]] as const) {
        context.strokeStyle = `rgba(216, 160, 116, ${alpha * (1 - ring)})`;
        context.lineWidth = 1.4;
        context.beginPath();
        context.arc(to[0], to[1], 8 + offset + ring * 22, 0, Math.PI * 2);
        context.stroke();
      }
    }
  }
}

/** A small letter riding the path; artifacts carry a folded corner. */
export function drawEnvelope(context: CanvasRenderingContext2D, x: number, y: number, angle: number, artifact: boolean, glow: number) {
  const w = artifact ? 13 : 11;
  const h = artifact ? 9 : 7.5;
  context.save();
  context.translate(x, y);
  context.rotate(angle * 0.35);
  context.shadowColor = "#e0a066";
  context.shadowBlur = glow;
  context.fillStyle = artifact ? "#f3d7b5" : "#fff6ea";
  context.strokeStyle = artifact ? "#b97a45" : "#d58e5a";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(-w / 2, -h / 2, w, h, 1.6);
  context.fill();
  context.shadowBlur = 0;
  context.stroke();
  context.beginPath();
  context.moveTo(-w / 2 + 0.8, -h / 2 + 0.8);
  context.lineTo(0, h * 0.12);
  context.lineTo(w / 2 - 0.8, -h / 2 + 0.8);
  context.stroke();
  if (artifact) {
    context.fillStyle = "#b97a45";
    context.fillRect(w / 2 - 3.5, h / 2 - 3.5, 2.5, 2.5);
  }
  context.restore();
}

let frame = 0;
let lastFrame = 0;
let officeStateKey = "";

/** Something on the canvases is moving: a delivery in flight, or the coordinator's flowing dispatch lines. */
function moving(now: number) {
  if (ui.animationPaused || !ui.model) return false;
  if (ui.packets.some((p) => now - p.startedAt < PACKET_MS)) return true;
  const current = room();
  return ui.view === "room" && ui.selection.kind === "room" && current.mode === "coordinator" && Boolean(current.coordinator) && current.members.length > 1;
}

/** Timed office states (receiving, just read, speech bubbles) that still need to expire on screen. */
function officeTimers(now: number) {
  return [...ui.receiving, ...ui.read, ...ui.speaking.entries()]
    .filter(([, v]) => (typeof v === "number" ? v : speechEnd(v)) > now)
    .map(([id, v]) => (typeof v === "number" || now >= v.startAt ? id : `${id}~waiting`))
    .join(",");
}

function draw(now: number) {
  ui.packets = ui.packets.filter((p) => now - p.startedAt < PACKET_MS);
  drawCanvas($("roomCanvas") as HTMLCanvasElement, "room", now);
  drawCanvas($("flowCanvas") as HTMLCanvasElement, "flow", now);
  const key = officeTimers(now);
  if (ui.model && key !== officeStateKey) {
    officeStateKey = key;
    renderOffice();
  }
}

function tick(now: number) {
  frame = 0;
  if (document.hidden) return;
  if (now - lastFrame > 30) {
    draw(now);
    lastFrame = now;
  }
  if (moving(now) || officeStateKey) frame = requestAnimationFrame(tick);
}

/**
 * Draw the canvases now and keep animating only while something moves; an idle room costs no frames.
 * Call whenever what the canvases show may have changed.
 */
export function wakeCanvas() {
  if (frame || document.hidden) return;
  lastFrame = 0;
  frame = requestAnimationFrame(tick);
}

export function bindCanvas() {
  document.addEventListener("visibilitychange", wakeCanvas);
  window.addEventListener("resize", wakeCanvas);
  motionPreference.addEventListener("change", () => {
    ui.animationPaused = motionPreference.matches;
    renderGraph();
    wakeCanvas();
  });
  wakeCanvas();
}
