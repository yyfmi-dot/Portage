import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FileInboxAdapter,
  discoverCliProcesses,
  processesToEndpoints,
} from "@portage/adapters";
import type { DiscoveredEndpoint, Message, Session } from "@portage/core";
import { MemoryBus } from "@portage/core";
import { SqliteSnapshotStore } from "@portage/core/node";

/** Resolved at call time so tests can set PORTAGE_HOME before createRuntime. */
export function portageHome() {
  return process.env.PORTAGE_HOME ?? join(homedir(), ".portage");
}

export type DaemonRuntime = {
  bus: MemoryBus;
  adapter: FileInboxAdapter;
  persist: () => void;
  refreshDiscovery: () => Promise<DiscoveredEndpoint[]>;
  paths: { home: string; db: string; inbox: string; artifacts: string };
};

const DEFAULT_GLOBAL_POLICY = `# PORTAGE.md

- 各 session 保留原生身份与正在进行的工作，Portage 只负责传递。
- 需要他人处理时明确 @ 对方，并说明期望产出。
- 回复附上来源与产物引用；结果不确定时如实标注。`;

export function createRuntime(options: { hydrate?: boolean } = {}): DaemonRuntime {
  const home = portageHome();
  const paths = {
    home,
    db: join(home, "portage.db"),
    inbox: join(home, "inbox"),
    artifacts: join(home, "artifacts"),
  };
  for (const dir of [paths.home, paths.inbox, paths.artifacts]) mkdirSync(dir, { recursive: true });

  const adapter = new FileInboxAdapter(paths.inbox);
  const inject = async ({
    session,
    message,
    compiledQuery,
  }: {
    session: Session;
    message: Message;
    compiledQuery: string;
  }) => {
    const result = await adapter.inject(
      session,
      {
        id: "local-file",
        deviceId: "local",
        kind: "terminal",
        host: "terminal",
        adapterId: adapter.id,
        capabilities: adapter.capabilities,
      },
      message,
      compiledQuery,
    );
    if (!result.ok) return result;
    return {
      ok: true as const,
      nativeMessageId: result.nativeMessageId,
      adapterId: adapter.id,
      proof: result.proof,
    };
  };

  let bus = new MemoryBus({ inject });
  if (options.hydrate) {
    try {
      const store = new SqliteSnapshotStore(paths.db);
      bus = store.load(new MemoryBus({ inject }));
      store.close();
    } catch {
      bus = new MemoryBus({ inject });
    }
  }

  const persist = () => {
    const store = new SqliteSnapshotStore(paths.db);
    store.save(bus);
    store.close();
  };

  const refreshDiscovery = async () => processesToEndpoints(await discoverCliProcesses());

  return { bus, adapter, persist, refreshDiscovery, paths };
}

/** Seed / repair a three-member room with codex + claude sources (real discovery preferred). */
export async function seedDualProviderRoom(runtime: DaemonRuntime) {
  const { bus, adapter, refreshDiscovery } = runtime;
  const endpoints = await refreshDiscovery();
  const codex =
    endpoints.find((e) => e.provider === "codex") ??
    fallbackEndpoint("codex", "demo-codex", adapter.capabilities);
  const claude =
    endpoints.find((e) => e.provider === "claude") ??
    fallbackEndpoint("claude", "demo-claude", adapter.capabilities);

  if (!bus.getPolicyDocument("global", "PORTAGE")) {
    bus.publishPolicy({
      scope: "global",
      id: "PORTAGE",
      markdown: DEFAULT_GLOBAL_POLICY,
      updatedBy: "system",
    });
  }

  if (!bus.conversations.has("room_dev")) {
    bus.registerSession({
      session: {
        id: "s_lead",
        provider: codex.provider,
        harness: "cli",
        host: "terminal",
        nativeIdentity: codex.nativeSessionId,
        displayName: "统筹会话",
        alias: "lead",
        communicationEnabled: true,
      },
      participantId: "p_lead",
    });
    bus.registerSession({
      session: {
        id: "s_builder",
        provider: claude.provider,
        harness: "cli",
        host: "vscode_cli",
        nativeIdentity: `${claude.nativeSessionId}-builder`,
        displayName: "适配器实现",
        alias: "builder",
        communicationEnabled: true,
      },
      participantId: "p_builder",
      runtime: { execution: "running" },
    });
    bus.registerSession({
      session: {
        id: "s_reviewer",
        provider: claude.provider,
        harness: "cli",
        host: "terminal",
        nativeIdentity: `${claude.nativeSessionId}-reviewer`,
        displayName: "代码审查",
        alias: "reviewer",
        communicationEnabled: true,
      },
      participantId: "p_reviewer",
    });

    bus.createRoom({
      id: "room_dev",
      title: "Portage 开发室",
      createdBy: "user",
      wakeMode: "coordinator",
      coordinatorParticipantId: "p_lead",
    });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_reviewer" });
    return;
  }

  // Hydrated workspace: rebind pid-scoped identities whose process is gone to a live endpoint.
  const live = new Set(endpoints.map((e) => e.nativeSessionId));
  for (const session of bus.sessions.values()) {
    if (!session.nativeIdentity.startsWith("pid-") || live.has(session.nativeIdentity)) continue;
    const replacement = endpoints.find(
      (e) =>
        e.provider === session.provider &&
        ![...bus.sessions.values()].some((s) => s.nativeIdentity === e.nativeSessionId),
    );
    if (replacement) session.nativeIdentity = replacement.nativeSessionId;
  }
}

/** Full workspace projection for the UI. Context snapshots carry the exact compiled query. */
export function snapshotForUi(bus: MemoryBus) {
  const conversations = [...bus.conversations.values()];
  return {
    workspaceId: bus.workspaceId,
    conversations: conversations.map((c) => ({
      ...c,
      policy: bus.policies.get(c.id),
      state: bus.roomState.get(c.id),
      document: c.policyDocumentId ? bus.getPolicyDocument("room", c.policyDocumentId) ?? null : null,
    })),
    globalDocument: bus.getPolicyDocument("global", "PORTAGE") ?? null,
    sessions: [...bus.sessions.values()],
    participants: [...bus.participants.values()],
    memberships: bus.memberships,
    messages: bus.messages,
    deliveries: bus.deliveries,
    receipts: bus.receipts,
    runtimes: Object.fromEntries(bus.runtime),
    contextSnapshots: Object.fromEntries(bus.contextSnapshots),
    artifacts: [...bus.artifacts.values()],
    events: bus.events.slice(-400),
    lastEventSeq: bus.events.at(-1)?.seq ?? 0,
  };
}

function fallbackEndpoint(
  provider: string,
  nativeSessionId: string,
  capabilities: DiscoveredEndpoint["capabilities"],
): DiscoveredEndpoint {
  return {
    suggestedSessionKey: `${provider}:demo`,
    provider,
    harness: "cli",
    host: "terminal",
    nativeSessionId,
    displayName: `${provider} demo`,
    capabilities,
  };
}
