import { $, reasonLabels, type VSession, type VDelivery, ui, model, session, room } from "./state.js";

export function escapeHtml(value: unknown) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export function toast(message: string, tone: "" | "error" = "") {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", tone === "error");
  el.classList.add("visible");
  clearTimeout((toast as unknown as { timer?: number }).timer);
  (toast as unknown as { timer?: number }).timer = window.setTimeout(() => el.classList.remove("visible"), 3500);
}

export function memberBadge(item: VSession, roomId = ui.roomId) {
  const current = room(roomId);
  return current.mode === "coordinator" && current.coordinator === item.id ? "统筹" : "";
}
export const senderName = (id: string) => (id === "user" ? "你" : session(id)?.name ?? "未知会话");
export const statusFor = (item: VSession) => (item.enabled ? item.execution : "disabled");
export const queueFor = (id: string) =>
  model().deliveries.filter((d) => d.recipient === id && (d.state === "queued" || d.state === "held"));
export const timeLabel = (t: number) =>
  new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
export const initial = (item?: VSession) =>
  !item ? "P" : item.provider === "Codex" ? "C›" : item.provider === "Claude" ? "✳" : item.provider[0]!;
export function modeLabel(mode: string) {
  return (
    { mentions: "仅 @", coordinator: "统筹 · 派发连线", swarm: "Swarm · 无固定连线", manual: "手动唤醒" } as Record<string, string>
  )[mode] ?? mode;
}

/** Seconds until `at`, rendered live by the countdown ticker. */
export function countdownMarkup(at?: number) {
  if (!at) return "";
  return `<span class="countdown" data-countdown="${at}">${countdownText(at)}</span>`;
}
export function countdownText(at: number) {
  const left = Math.ceil((at - Date.now()) / 1000);
  return left > 0 ? `${left}s 后自动恢复` : "即将恢复";
}

/** Why a delivery is waiting, plus when it will move again if that is known. */
export function waitMarkup(d: VDelivery) {
  const label = reasonLabels[d.reason] ?? (d.state === "uncertain" ? "提交结果不明 · 正在回读核对" : "等待投递");
  return `${escapeHtml(label)}${d.detail ? ` · ${escapeHtml(d.detail)}` : ""}${d.reason === "budget" ? ` · ${countdownMarkup(d.nextAttemptAt)}` : ""}`;
}

/** Escaped text with @alias mentions of current members turned into chips. */
export function richText(text: string) {
  const aliases = new Map(model().sessions.map((s) => [s.alias, s]));
  return escapeHtml(text).replace(/(^|[\s(（])@([\w-]+)/g, (whole, lead: string, alias: string) => {
    const target = aliases.get(alias);
    if (!target) return whole;
    return `${lead}<button class="mention-chip" data-inspect-session="${target.id}" style="--agent-color:${target.color}">@${escapeHtml(alias)}</button>`;
  });
}

export function sparkline(values: number[]) {
  const width = 120;
  const height = 22;
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const points = values.map((v, i) => [i * step, height - 2 - (v / max) * (height - 5)] as const);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = points.at(-1)!;
  return `<span class="pulse-wrap"><svg class="pulse-line" viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs><linearGradient id="pulseFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#d9a074" stop-opacity=".28"/><stop offset="1" stop-color="#d9a074" stop-opacity="0"/></linearGradient></defs><path d="${line} L${width},${height} L0,${height} Z" fill="url(#pulseFill)"/><path d="${line}" fill="none" stroke="#c98a5e" stroke-width="1.2" stroke-linejoin="round"/></svg><i class="pulse-tip" style="left:${((lx / width) * 100).toFixed(1)}%;top:${((ly / height) * 100).toFixed(1)}%"></i></span>`;
}

export function formatBytes(size: number) {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KiB`;
}

/** Replace markup only when it changed, so entrance animations play once per real change. */
export function setHtml(el: HTMLElement, html: string) {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}
