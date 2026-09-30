#!/usr/bin/env node
// deploy-icon.mjs — 把 ZCode 官方应用图标部署进 OpenDesign 前端的 agent-icons 目录
// profile 型 agent 不带图标（内置 agent 的图标由前端资产表解析，profile 无此机制），
// 本脚本把官方 icon.png 以 <id>.png + <id>.svg（内嵌 PNG 的 SVG 壳）双格式铺到
// 所有已知 web-standalone 副本。OpenDesign 升级后请重跑。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const id = "zcode";
const localAppData = process.env.LOCALAPPDATA;
const appData = process.env.APPDATA;
if (!localAppData || !appData) { console.error("需要 LOCALAPPDATA / APPDATA 环境（仅支持 Windows）"); process.exit(1); }

const officialIcon = join(localAppData, "Programs", "ZCode", "resources", "icon.png");
if (!existsSync(officialIcon)) { console.error("找不到 ZCode 官方图标：" + officialIcon); process.exit(1); }

const candidates = [
  join(localAppData, "Programs", "Open Design", "resources", "open-design-web-standalone", "apps", "web", "public", "agent-icons"),
  ...readdirSync(join(appData, "Open Design", "launcher", "channels", "stable", "namespaces", "release-stable-win", "versions"))
    .map((v) => join(appData, "Open Design", "launcher", "channels", "stable", "namespaces", "release-stable-win", "versions", v, "payload", "resources", "open-design-web-standalone", "apps", "web", "public", "agent-icons")),
];

const b64 = readFileSync(officialIcon).toString("base64");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><image href="data:image/png;base64,${b64}" width="256" height="256"/></svg>`;

let deployed = 0;
for (const dir of candidates) {
  if (!existsSync(dir)) { console.log("skip（不存在）: " + dir); continue; }
  copyFileSync(officialIcon, join(dir, `${id}.png`));
  writeFileSync(join(dir, `${id}.svg`), svg);
  console.log("deployed → " + dir);
  deployed++;
}
console.log(deployed ? `完成：${deployed} 处。重启 OpenDesign 后生效；升级 OpenDesign 后需重跑本脚本。` : "未找到任何 agent-icons 目录。");
