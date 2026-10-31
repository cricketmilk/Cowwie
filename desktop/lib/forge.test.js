// Integration test for lib/forge.js against a running Forge backend.
// Run from the shell directory: node lib/forge.test.js
"use strict";

const { askForge, abort, ensureForge } = require("./forge.js");

async function collect(prompt, workspace) {
  const events = [];
  const signal = new AbortController().signal;
  for await (const ev of askForge({ prompt, workspace, signal })) {
    events.push(ev);
  }
  return events;
}

async function run() {
  console.log("lib/forge.js integration tests");
  console.log("===============================");

  await ensureForge();
  console.log("✓ ensureForge()");

  let events = await collect("Read the file C:/Forge/server.js and tell me only the first non-comment line of code.", "C:/Forge");
  if (!events.some((e) => e.type === "tool_end" && e.name === "read_file")) {
    throw new Error("read_file tool did not complete");
  }
  console.log("✓ askForge read_file");

  events = await collect("Run the command 'echo shell-forge-ok' using the run tool.", "C:/Forge");
  const runEnd = events.find((e) => e.type === "tool_end" && e.name === "run");
  if (!runEnd || !runEnd.result.content.includes("shell-forge-ok")) {
    throw new Error("run tool did not return expected output");
  }
  console.log("✓ askForge run");

  console.log("\nAll lib/forge.js integration tests passed.");
}

run().catch((e) => {
  console.error("\nTest failed:", e.message);
  process.exit(1);
});
