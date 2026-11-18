import { PolicyFrontmatterError, parsePolicyDocument } from "@portage/core";
import type { ContextSnapshot, ParsedPolicyDocument } from "@portage/core";
import { api, type DiscoveredEndpoint } from "./api.js";
import { $, ui, model, session, room } from "./state.js";
import { providerLabel, hostLabel } from "./model.js";
import { escapeHtml, toast, initial, modeLabel, formatBytes, setHtml, timeLabel } from "./format.js";
import { act } from "./data.js";

export function showSnapshot(snapshot: ContextSnapshot, title: string, description: string) {
  $("queryTitle").textContent = title;
  $("queryDescription").textContent = description;
  $("queryMeta").innerHTML = [
    ...snapshot.layers.map((l) => `<span class="layer">${escapeHtml(l)}</span>`),
    `<span>${snapshot.hash}</span>`,
    `<span>${formatBytes(snapshot.byteSize)}</span>`,
    ...(snapshot.dropped ?? []).map((l) => `<span class="warn">超限省略 ${escapeHtml(l)}</span>`),
    snapshot.overflow ? '<span class="warn">原始消息本身超出上下文上限，未投递</span>' : "",
  ].join("");
  $("queryPreview").textContent = snapshot.query;
  const dialog = $("queryDialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
}

export const BUDGET_INPUTS = [
  { id: "roundBudget", key: "maxAutoRounds", label: "自动轮次", min: 1, max: 100 },
  { id: "messageBudget", key: "agentMessagesPerMinute", label: "每分钟 agent 消息", min: 1, max: 1000 },
  { id: "seatBudget", key: "maxConcurrent", label: "活跃席位", min: 1, max: 20 },
  { id: "wakeupBudget", key: "maxWakeupsPerTrace", label: "单链路唤醒", min: 1, max: 1000 },
] as const;

export const FRONTMATTER_LABELS: Record<string, string> = {
  wakeMode: "wake.mode",
  coordinator: "wake.coordinator",
  batchWindowMs: "wake.batch_window_ms",
  maxConcurrent: "wake.max_concurrent",
  agentMessagesPerMinute: "budget.agent_messages_per_minute",
  maxWakeupsPerTrace: "budget.max_wakeups_per_trace",
  maxAutoRounds: "budget.max_auto_rounds",
  maxContextBytes: "budget.max_context_bytes",
};

export function showRules(scope: "room" | "global") {
  ui.ruleScope = scope;
  const current = room();
  ($("rulesEditor") as HTMLTextAreaElement).value = scope === "global" ? model().globalDocument : current.document;
  const values: Record<string, number> = {
    roundBudget: current.roundBudget,
    messageBudget: current.messageBudget,
    seatBudget: current.maxConcurrent,
    wakeupBudget: current.maxWakeups,
  };
  for (const input of BUDGET_INPUTS) {
    const el = $(input.id) as HTMLInputElement;
    el.value = String(values[input.id]);
    el.disabled = scope === "global";
  }
  $("insertFrontmatter").hidden = scope === "global";
  $("rulesDescription").textContent =
    scope === "global"
      ? `PORTAGE.md v${model().globalRevision} · 每次原生 query 带入这份最高层约定。`
      : `${current.name} · collaboration.md v${current.revision} · 正文是约束与指导；开头的 YAML 策略头由服务端校验后执行。`;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-scope]"))
    button.classList.toggle("selected", button.dataset.scope === scope);
  validateRules();
  const dialog = $("rulesDialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
}

/**
 * Validate the draft with the same parser the server uses, so a bad policy header is caught while
 * typing — and show exactly what will take effect.
 */
export function validateRules(): boolean {
  const text = ($("rulesEditor") as HTMLTextAreaElement).value;
  const out = $("rulesPolicy");
  const publish = $("publishRules") as HTMLButtonElement;
  const problems: string[] = [];
  for (const input of BUDGET_INPUTS) {
    const el = $(input.id) as HTMLInputElement;
    const n = Number(el.value);
    const bad = !el.disabled && (!Number.isInteger(n) || n < input.min || n > input.max);
    el.classList.toggle("invalid", bad);
    if (bad) problems.push(`${input.label} 需为 ${input.min}–${input.max} 的整数`);
  }
  if (!text.trim()) problems.push("正文不能为空");
  let parsed: ParsedPolicyDocument | undefined;
  try {
    parsed = parsePolicyDocument(text);
  } catch (error) {
    if (error instanceof PolicyFrontmatterError) problems.push(...error.problems);
    else problems.push(String(error));
  }
  if (parsed?.policy.coordinator && ui.ruleScope === "room") {
    const ref = parsed.policy.coordinator.replace(/^@/, "");
    const ok = room().members.some((id) => {
      const s = session(id)!;
      return s.alias === ref || s.id === ref || s.participantId === ref;
    });
    if (!ok) problems.push(`wake.coordinator "${parsed.policy.coordinator}" 不是房间当前成员`);
  }
  publish.disabled = problems.length > 0;
  if (problems.length) {
    out.className = "rules-policy invalid";
    setHtml(out, `<b>无法发布</b>${problems.map((p) => `<span>${escapeHtml(p)}</span>`).join("")}`);
    return false;
  }
  const effective = Object.entries(parsed?.policy ?? {}).filter(([key]) => key !== "version");
  out.className = `rules-policy ${effective.length ? "active" : ""}`;
  if (ui.ruleScope === "global") {
    setHtml(
      out,
      parsed?.hasFrontmatter
        ? "<b>提示</b><span>全局文档的策略头不会执行，只有正文进入 query。</span>"
        : "<b>约束与指导</b><span>正文在下一次 query 编译时生效。</span>",
    );
    return true;
  }
  setHtml(out, effective.length
    ? `<b>策略头将执行</b>${effective
        .map(([key, value]) => `<span class="policy-chip"><em>${FRONTMATTER_LABELS[key] ?? key}</em>${escapeHtml(key === "wakeMode" ? modeLabel(String(value)) : value)}</span>`)
        .join("")}<small>策略头中的值优先于下方输入框</small>`
    : "<b>仅正文</b><span>没有策略头：预算以下方输入为准。点「插入策略头」可把当前策略写进文档、随版本保存。</span>");
  return true;
}

export function insertFrontmatter() {
  const editor = $("rulesEditor") as HTMLTextAreaElement;
  if (/^\s*---\s*\n/.test(editor.value)) return toast("文档已有策略头");
  const current = room();
  const lead = current.coordinator ? session(current.coordinator) : undefined;
  const value = (id: string) => ($(id) as HTMLInputElement).value;
  const header = [
    "---",
    "version: 1",
    "wake:",
    `  mode: ${current.mode}`,
    lead && current.mode === "coordinator" ? `  coordinator: ${lead.alias}` : "",
    `  max_concurrent: ${value("seatBudget")}`,
    "budget:",
    `  agent_messages_per_minute: ${value("messageBudget")}`,
    `  max_wakeups_per_trace: ${value("wakeupBudget")}`,
    `  max_auto_rounds: ${value("roundBudget")}`,
    "---",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  editor.value = `${header}\n\n${editor.value.trimStart()}`;
  editor.focus();
  editor.setSelectionRange(0, header.length);
  validateRules();
}

export async function publishRules() {
  if (!validateRules()) return;
  const text = ($("rulesEditor") as HTMLTextAreaElement).value.trim();
  const budget = (id: string) => Number(($(id) as HTMLInputElement).value);
  await act(async () => {
    if (ui.ruleScope === "global") await api.publishGlobalPolicy(text);
    else
      await api.publishRoomPolicy(ui.roomId, {
        markdown: text,
        maxAutoRounds: budget("roundBudget"),
        agentMessagesPerMinute: budget("messageBudget"),
        maxConcurrent: budget("seatBudget"),
        maxWakeupsPerTrace: budget("wakeupBudget"),
      });
    ($("rulesDialog") as HTMLDialogElement).close();
  }, "已发布 · 策略头与预算立即生效，正文下一次 query 应用");
}

export function renderMemberOptions() {
  $("memberOptions").innerHTML = model()
    .sessions.map((item) => {
      const joined = room().members.includes(item.id);
      return `<div class="member-option"><span class="avatar ${item.provider === "Claude" ? "claude" : ""}">${initial(item)}</span><span class="member-info"><b>${escapeHtml(item.name)}</b><small>${item.provider} / ${item.host} · ${escapeHtml(item.nativeIdentity)}</small></span><button data-add-session="${item.id}" ${joined ? "disabled" : ""}>${joined ? "已加入" : "加入"}</button></div>`;
    })
    .join("");
}

export async function showDiscover() {
  const dialog = $("discoverDialog") as HTMLDialogElement;
  $("discoverOptions").innerHTML = '<p class="dialog-description">正在扫描本机进程…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const { endpoints } = await api.discover();
    renderDiscover(endpoints);
  } catch (error) {
    $("discoverOptions").innerHTML = `<p class="dialog-description">${escapeHtml(error instanceof Error ? error.message : error)}</p>`;
  }
}

function endpointFacts(e: DiscoveredEndpoint) {
  return [
    e.adapterId ? "原生回合，可自动唤醒" : "文件收件箱，经 MCP 读取",
    e.attached ? "正被交互式进程占用" : "",
    e.workdir ? e.workdir.split("/").slice(-2).join("/") : "",
    e.updatedAt ? `活跃于 ${timeLabel(Date.parse(e.updatedAt))}` : "",
  ].filter(Boolean);
}

export function renderDiscover(endpoints: DiscoveredEndpoint[]) {
  $("discoverOptions").innerHTML = endpoints.length
    ? endpoints
        .map(
          (e) =>
            `<div class="member-option"><span class="avatar ${e.provider === "claude" ? "claude" : ""}">${providerLabel(e.provider)[0]}</span><span class="member-info"><b>${escapeHtml(e.displayName)}</b><small>${providerLabel(e.provider)} / ${hostLabel(e.host)} · ${escapeHtml(endpointFacts(e).join(" · "))}</small><small class="mono">${escapeHtml(e.nativeSessionId)}</small></span><button data-register='${escapeHtml(JSON.stringify(e))}' ${e.registered ? "disabled" : ""}>${e.registered ? "已登记" : "登记"}</button></div>`,
        )
        .join("")
    : '<p class="dialog-description">没有发现 Codex / Claude 会话。在本机用 CLI 开始一段会话后再次打开。</p>';
}

export function showNameDialog(title: string, label: string, initialValue: string, description: string, callback: (value: string) => Promise<void> | void) {
  ui.nameAction = callback;
  $("nameDialogTitle").textContent = title;
  $("nameLabel").textContent = label;
  ($("nameInput") as HTMLInputElement).value = initialValue;
  ($("nameInput") as HTMLInputElement).maxLength = title.includes("修订") ? 4000 : 50;
  $("nameDescription").textContent = description;
  ($("nameDialog") as HTMLDialogElement).showModal();
  $("nameInput").focus();
}
