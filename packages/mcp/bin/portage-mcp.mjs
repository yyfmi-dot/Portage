#!/usr/bin/env node
// Launcher that works from any working directory: a CLI spawns MCP servers wherever it happens to be,
// so TypeScript support is registered from this file's own location instead of relying on `--import tsx` + cwd.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
