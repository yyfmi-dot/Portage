#!/usr/bin/env node
import { discoverCliProcesses, processesToEndpoints } from "@portage/adapters";
import { createRuntime, portageHome, seedDualProviderRoom } from "./runtime.js";
import { startServer } from "./server.js";

async function main() {
  const [command = "help"] = process.argv.slice(2);

  if (command === "discover") {
    const processes = await discoverCliProcesses();
    const endpoints = processesToEndpoints(processes);
    console.log(JSON.stringify({ processes, endpoints }, null, 2));
    return;
  }

  if (command === "demo") {
    await runDemo();
    return;
  }

  if (command === "serve") {
    const port = Number(process.env.PORTAGE_PORT ?? 8787);
    const { port: bound } = await startServer(port);
    console.log(`Portage daemon listening on http://127.0.0.1:${bound}`);
    console.log(`data: ${portageHome()}`);
    return;
  }

  console.log(`Portage daemon
  portage discover   # list local codex/claude CLI candidates
  portage demo       # three-member room + file-inbox + sqlite
  portage serve      # HTTP API on 127.0.0.1:8787
data: ${portageHome()}`);
}

async function runDemo() {
  const runtime = createRuntime();
  await seedDualProviderRoom(runtime);
  const { bus, persist, paths, adapter } = runtime;

  const sent = await bus.send({
    conversationId: "room_dev",
    senderId: "user",
    target: { kind: "room", id: "room_dev" },
    text: "请核对适配器契约，给出可实施修改意见。",
    idempotencyKey: `demo_${Date.now()}`,
    source: "user",
  });
  persist();

  console.log(
    JSON.stringify(
      {
        room: "room_dev",
        providers: [...bus.sessions.values()].map((s) => ({
          id: s.id,
          provider: s.provider,
          name: s.displayName,
        })),
        messageId: sent.message.id,
        deliveries: sent.deliveries.map((d) => ({
          to: d.recipientSessionId,
          state: d.state,
          hash: d.compiledContextHash,
        })),
        receipts: await bus.getReceipts(sent.deliveries[0]!.id),
        sqlite: paths.db,
        inbox: paths.inbox,
        adapter: adapter.id,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
