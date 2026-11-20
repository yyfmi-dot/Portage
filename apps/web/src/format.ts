import { $, reasonLabels, type VSession, type VDelivery, ui, model, session, room } from "./state.js";

export function escapeHtml(value: unknown) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

let toastTimer = 0;
export function toast(message: string, tone: "" | "error" = "", action?: { label: string; run: () => void }) {
  const el = $("toast");
  const hide = () => el.classList.remove("visible", "actionable");
  el.textContent = message;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      hide();
      action.run();
    });
    el.append(button);
  }
  el.classList.toggle("error", tone === "error");
  el.classList.toggle("actionable", Boolean(action));
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hide, action ? 7000 : 3500);
}

export function memberBadge(item: VSession, roomId = ui.roomId) {
  const current = room(roomId);
  return current.mode === "coordinator" && current.coordinator === item.id ? "Lead" : "";
}
export const senderName = (id: string) =>
  id === "user" ? "You" : session(id)?.name ?? model().archived.find((x) => x.id === id)?.name ?? "Unknown session";
export const statusFor = (item: VSession) => (item.enabled ? item.execution : "disabled");
export const queueFor = (id: string) =>
  model().deliveries.filter((d) => d.recipient === id && (d.state === "queued" || d.state === "held"));
export const timeLabel = (t: number) =>
  new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
export function sinceLabel(t: number) {
  const minutes = Math.round((Date.now() - t) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
export const initial = (item?: VSession) =>
  !item ? "P" : item.provider === "Codex" ? "C›" : item.provider === "Claude" ? "✳" : item.provider[0]!;
/** "1 member", "3 members"; pass the plural when it is not just word + "s". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function modeLabel(mode: string) {
  return (
    { mentions: "@ mentions only", coordinator: "Coordinator · the lead dispatches first", swarm: "Open floor · whoever is @-mentioned replies", manual: "Manual · logged, nobody is woken" } as Record<string, string>
  )[mode] ?? mode;
}

/** Seconds until `at`, rendered live by the countdown ticker. */
export function countdownMarkup(at?: number) {
  if (!at) return "";
  return `<span class="countdown" data-countdown="${at}">${countdownText(at)}</span>`;
}
export function countdownText(at: number) {
  const left = Math.ceil((at - Date.now()) / 1000);
  return left > 0 ? `continues in ${left}s` : "continuing now";
}

/** Why a delivery is waiting, plus when it will move again if that is known. */
export function waitMarkup(d: VDelivery) {
  // Prefer the adapter's concrete detail (e.g. writer lock) over the generic reason label.
  const label = d.detail?.trim()
    ? d.detail.trim()
    : (reasonLabels[d.reason] ?? (d.state === "uncertain" ? "Not sure it landed yet; checking its own record" : "Waiting to deliver"));
  return `${escapeHtml(label)}${d.reason === "budget" ? ` · ${countdownMarkup(d.nextAttemptAt)}` : ""}`;
}

/** Escaped text with @alias mentions of current members turned into chips. */
export function richText(text: string) {
  const aliases = new Map(model().sessions.map((s) => [s.alias, s]));
  // works on escaped text: only inline code and [label](target) links, the two things agents write most
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, target: string) =>
      /^https?:\/\//.test(target)
        ? `<a href="${target}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : `<span class="md-link" title="${target}">${label}</span>`,
    )
    .replace(/(^|[\s(（])@([\w-]+)/g, (whole, lead: string, alias: string) => {
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
