#!/usr/bin/env node
process.env.PI_CODING_AGENT_DEV = "1";
await import("./cli.ts");
