// 一次性驱动：OpenDesign MCP → create_project + create_artifact
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APPDATA = process.env.APPDATA;
const OD_EN = join(APPDATA, "Open Design", "en", "041c6bf10a0aff44", "Open Design.exe");
const OD_PAYLOAD = join(APPDATA, "Open Design", "launcher", "channels", "stable", "namespaces", "release-stable-win", "versions", "0.24.0", "payload", "resources", "app", "prebundled", "daemon", "daemon-cli.mjs");
const HTML = readFileSync(process.argv[2], "utf8");

const child = spawn(OD_EN, [OD_PAYLOAD, "mcp", "--daemon-url", "http://127.0.0.1:7456"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OD_DATA_DIR: join(APPDATA, "Open Design", "namespaces", "release-stable-win", "data") },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); }
    } catch {}
  }
});
child.stderr.on("data", (c) => process.stderr.write("[mcp] " + c));

function call(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "zcode-session", version: "1.0" } });
console.log("init:", init.result.serverInfo.name, init.result.serverInfo.version);
notify("notifications/initialized", {});

const proj = await call("tools/call", { name: "create_project", arguments: { name: "ZCode-MCP-联动测试" } });
const projText = proj.result.content.map((c) => c.text || "").join("");
console.log("create_project:", projText.slice(0, 300));

const art = await call("tools/call", {
  name: "create_artifact",
  arguments: { project: "ZCode-MCP-联动测试", name: "zcode-demo/index.html", content: HTML, encoding: "utf8" },
});
const artText = art.result.content.map((c) => c.text || "").join("");
console.log("create_artifact:", artText.slice(0, 400));

child.stdin.end();
setTimeout(() => process.exit(0), 1500);
