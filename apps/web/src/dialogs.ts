import { PolicyFrontmatterError, parsePolicyDocument } from "@portage/core";
import type { Artifact, ContextSnapshot, ParsedPolicyDocument } from "@portage/core";
import { api, type DiscoveredEndpoint } from "./api.js";
import { $, ui, model, session, room } from "./state.js";
import { providerLabel, hostLabel } from "./model.js";
import { escapeHtml, toast, initial, modeLabel, formatBytes, setHtml, timeLabel, senderName } from "./format.js";
import { act } from "./data.js";

export function showSnapshot(snapshot: ContextSnapshot, title: string, description: string) {
  $("queryTitle").textContent = title;
  $("queryDescription").textContent = description;
  $("queryMeta").innerHTML = [
    ...snapshot.layers.map((l) => `<span class="layer">${escapeHtml(l)}</span>`),
    `<span title="Content hash">${snapshot.hash}</span>`,
    `<span>${formatBytes(snapshot.byteSize)}</span>`,
    ...(snapshot.dropped ?? []).map((l) => `<span class="warn">Dropped for length: ${escapeHtml(l)}</span>`),
    snapshot.overflow ? '<span class="warn">The message alone exceeds the context limit, so it was not sent</span>' : "",
  ].join("");
  $("queryPreview").textContent = snapshot.query;
  const dialog = $("queryDialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const TEXT_EXT =
  /\.(md|markdown|txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|env|xml|html?|css|scss|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|diff|patch|lock|gitignore|dockerfile)$/i;
const TEXT_PREVIEW_BYTES = 512 * 1024;
let filePreviewToken = 0;

function previewKind(a: Artifact) {
  if (a.mime.startsWith("image/") || IMAGE_EXT.test(a.originalName)) return "image";
  if (a.mime === "application/pdf" || /\.pdf$/i.test(a.originalName)) return "pdf";
  if (a.mime.startsWith("text/") || /json|xml|yaml|javascript|typescript/.test(a.mime) || TEXT_EXT.test(a.originalName)) return "text";
  return a.byteSize <= TEXT_PREVIEW_BYTES ? "maybe-text" : "binary";
}

export async function showArtifact(id: string) {
  const a = model().artifacts.find((x) => x.id === id);
  if (!a) return;
  const versions = model()
    .artifacts.filter((x) => x.originalName === a.originalName && x.conversationId === a.conversationId)
    .sort((x, y) => y.version - x.version);
  const by = a.createdBy === "user" ? "You" : senderName(model().sessionByParticipant.get(a.createdBy) ?? a.createdBy);
  $("fileTitle").textContent = a.originalName;
  setHtml(
    $("fileMeta"),
    [`v${a.version}`, formatBytes(a.byteSize), a.mime || "unknown type", `by ${by}`, timeLabel(Date.parse(a.createdAt))]
      .map((x) => `<span>${escapeHtml(x)}</span>`)
      .join(""),
  );
  setHtml(
    $("fileVersions"),
    versions.length > 1
      ? versions
          .map((v) => `<button class="${v.id === a.id ? "selected" : ""}" data-file-version="${v.id}">v${v.version}<small>${timeLabel(Date.parse(v.createdAt))}</small></button>`)
          .join("")
      : "",
  );
  const url = api.artifactUrl(a.id);
  ($("fileOpen") as HTMLAnchorElement).href = url;
  ($("fileDownload") as HTMLAnchorElement).href = url;
  ($("fileDownload") as HTMLAnchorElement).download = a.originalName;
  $("fileCopyPath").dataset.path = a.storageKey;
  const body = $("fileBody");
  const token = ++filePreviewToken;
  const kind = previewKind(a);
  body.className = `file-body ${kind}`;
  const dialog = $("fileDialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();

  if (kind === "image") return setHtml(body, `<img src="${url}" alt="${escapeHtml(a.originalName)}" />`);
  if (kind === "pdf") return setHtml(body, `<iframe src="${url}" title="${escapeHtml(a.originalName)}"></iframe>`);
  if (kind === "binary") return setHtml(body, `<p class="file-note">No inline preview for this type. Open or download it below.</p>`);
  setHtml(body, `<p class="file-note">Loading…</p>`);
  try {
    const text = await api.artifactText(a.id);
    if (token !== filePreviewToken) return;
    if (kind === "maybe-text" && text.includes("\u0000")) {
      body.className = "file-body binary";
      return setHtml(body, `<p class="file-note">This looks like a binary file. Open or download it below.</p>`);
    }
    body.className = "file-body text";
    const shown = text.length > TEXT_PREVIEW_BYTES ? text.slice(0, TEXT_PREVIEW_BYTES) : text;
    const lines = shown.split("\n");
    if (lines.at(-1) === "") lines.pop();
    setHtml(
      body,
      `<pre><code>${lines.map((line) => `<span>${escapeHtml(line) || " "}</span>`).join("")}</code></pre>${
        shown.length < text.length ? `<p class="file-note">Showing the first ${formatBytes(TEXT_PREVIEW_BYTES)}. Open it for the rest.</p>` : ""
      }`,
    );
  } catch (error) {
    if (token !== filePreviewToken) return;
    body.className = "file-body binary";
    setHtml(body, `<p class="file-note warn">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`);
  }
}

export const BUDGET_INPUTS = [
  { id: "roundBudget", key: "maxAutoRounds", label: "Auto rounds", min: 1, max: 100 },
  { id: "messageBudget", key: "agentMessagesPerMinute", label: "AI messages / min", min: 1, max: 1000 },
  { id: "seatBudget", key: "maxConcurrent", label: "Working at once", min: 1, max: 20 },
  { id: "wakeupBudget", key: "maxWakeupsPerTrace", label: "Wake-ups per thread", min: 1, max: 1000 },
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
      ? `Global rules v${model().globalRevision}: sent with every delivery in every room.`
      : `Rules for “${current.name}”, v${current.revision}. The text tells members how to work together; an optional YAML policy header at the top is validated and enforced.`;
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
    if (bad) problems.push(`${input.label} must be a whole number from ${input.min} to ${input.max}`);
  }
  if (!text.trim()) problems.push("The text can't be empty");
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
    if (!ok) problems.push(`wake.coordinator "${parsed.policy.coordinator}" is not a member of this room`);
  }
  publish.disabled = problems.length > 0;
  if (problems.length) {
    out.className = "rules-policy invalid";
    setHtml(out, `<b>Can't publish</b>${problems.map((p) => `<span>${escapeHtml(p)}</span>`).join("")}`);
    return false;
  }
  const effective = Object.entries(parsed?.policy ?? {}).filter(([key]) => key !== "version");
  out.className = `rules-policy ${effective.length ? "active" : ""}`;
  if (ui.ruleScope === "global") {
    setHtml(
      out,
      parsed?.hasFrontmatter
        ? "<b>Note</b><span>Policy headers in global rules are not enforced; only the text is sent to members.</span>"
        : "<b>Text</b><span>Applies from the next delivery.</span>",
    );
    return true;
  }
  setHtml(out, effective.length
    ? `<b>Enforced once published</b>${effective
        .map(([key, value]) => `<span class="policy-chip"><em>${FRONTMATTER_LABELS[key] ?? key}</em>${escapeHtml(key === "wakeMode" ? modeLabel(String(value)) : value)}</span>`)
        .join("")}<small>Values in the policy header win over the fields below</small>`
    : "<b>Text only</b><span>Limits come from the fields below. “Insert policy header” writes them into the document so they are versioned with it.</span>");
  return true;
}

export function insertFrontmatter() {
  const editor = $("rulesEditor") as HTMLTextAreaElement;
  if (/^\s*---\s*\n/.test(editor.value)) return toast("The document already has a policy header");
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
  }, "Published: limits apply now, the text from the next delivery");
}

export function renderMemberOptions() {
  $("memberOptions").innerHTML = model()
    .sessions.map((item) => {
      const joined = room().members.includes(item.id);
      return `<div class="member-option"><span class="avatar ${item.provider === "Claude" ? "claude" : ""}">${initial(item)}</span><span class="member-info"><b>${escapeHtml(item.name)}</b><small title="${escapeHtml(item.nativeIdentity)}">${item.provider} · ${item.host}</small></span><button data-add-session="${item.id}" ${joined ? "disabled" : ""}>${joined ? "Added" : "Add"}</button></div>`;
    })
    .join("");
}

export async function showDiscover() {
  const dialog = $("discoverDialog") as HTMLDialogElement;
  $("discoverOptions").innerHTML = '<p class="dialog-description">Looking for sessions on this computer…</p>';
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
    e.adapterId ? "can be woken automatically" : "receives through an inbox",
    e.attached ? "open in a window" : "",
    e.workdir ? e.workdir.split("/").slice(-2).join("/") : "",
    e.updatedAt ? `active ${timeLabel(Date.parse(e.updatedAt))}` : "",
  ].filter(Boolean);
}

export function renderDiscover(endpoints: DiscoveredEndpoint[]) {
  $("discoverOptions").innerHTML = endpoints.length
    ? endpoints
        .map(
          (e) =>
            `<div class="member-option"><span class="avatar ${e.provider === "claude" ? "claude" : ""}">${providerLabel(e.provider)[0]}</span><span class="member-info"><b>${escapeHtml(e.displayName)}</b><small title="${escapeHtml(e.nativeSessionId)}">${providerLabel(e.provider)} · ${hostLabel(e.host)} · ${escapeHtml(endpointFacts(e).join(" · "))}</small></span><button data-register='${escapeHtml(JSON.stringify(e))}' ${e.registered ? "disabled" : ""}>${e.registered ? "Added" : "Add"}</button></div>`,
        )
        .join("")
    : '<div class="dialog-empty"><span class="mascot" aria-hidden="true"><i class="agent-head"></i><i class="agent-body"></i></span><b>No sessions found yet</b><p>Start one in a terminal and it shows up here.</p><ol><li>Open a terminal and run <code>codex</code> or <code>claude</code></li><li>Say anything, so it leaves a session record</li><li>Come back and click ＋ next to “Sessions” on the left</li></ol></div>';
}

export function showNameDialog(title: string, label: string, initialValue: string, description: string, callback: (value: string) => Promise<void> | void, maxLength = 50) {
  ui.nameAction = callback;
  $("nameDialogTitle").textContent = title;
  $("nameLabel").textContent = label;
  ($("nameInput") as HTMLInputElement).value = initialValue;
  ($("nameInput") as HTMLInputElement).maxLength = maxLength;
  $("nameDescription").textContent = description;
  ($("nameDialog") as HTMLDialogElement).showModal();
  $("nameInput").focus();
}
