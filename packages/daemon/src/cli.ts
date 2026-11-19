#!/usr/bin/env node
import { createRuntime, portageHome, seedDemoRoom } from "./runtime.js";
import { startServer } from "./server.js";

async function main() {
  const [command = "help"] = process.argv.slice(2);

  if (command === "discover") {
    console.log(JSON.stringify(await createRuntime().refreshDiscovery(), null, 2));
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
  portage discover   # native codex/claude sessions + live CLI processes
  portage demo       # three-member room + file-inbox + sqlite
  portage serve      # HTTP API on 127.0.0.1:8787
data: ${portageHome()}`);
}

async function runDemo() {
  const runtime = createRuntime({ hydrate: true });
  await seedDemoRoom(runtime);
  const { bus, persist, paths, inbox } = runtime;

  const sent = await bus.send({
    conversationId: "room_dev",
    senderId: "user",
    target: { kind: "room", id: "room_dev" },
    text: "Please review the adapter contract and come back with changes we can ship.",
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
        adapter: inbox.id,
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
