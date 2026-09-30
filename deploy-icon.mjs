#!/usr/bin/env node
// deploy-icon.mjs — 让 OpenDesign 显示 ZCode 官方图标
//
// 机制（逆向自 0.24.x 前端）：设置页的 agent 图标按「编译进 chunk 的扩展名映射表
// yh={id:"svg"|"png"}」解析，未登记的 id 一律回退为字母头像；图标文件本身从
// public/agent-icons/<id>.<ext> 按需加载。因此需要两步：
//   1. 把官方 icon.png 铺到各 web-standalone 副本的 agent-icons/（png + 内嵌 svg 壳）
//   2. 给含映射表的 chunk 注入 zcode:"png"
// OpenDesign 升级后前端会被替换，重跑本脚本即可。Windows only。
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const id = "zcode";
const localAppData = process.env.LOCALAPPDATA;
const appData = process.env.APPDATA;
if (!localAppData || !appData) { console.error("需要 LOCALAPPDATA / APPDATA 环境（仅支持 Windows）"); process.exit(1); }

const officialIcon = join(localAppData, "Programs", "ZCode", "resources", "icon.png");
if (!existsSync(officialIcon)) { console.error("找不到 ZCode 官方图标：" + officialIcon); process.exit(1); }

const launcherVersions = join(appData, "Open Design", "launcher", "channels", "stable", "namespaces", "release-stable-win", "versions");
const roots = [
  join(localAppData, "Programs", "Open Design", "resources", "open-design-web-standalone"),
  ...existsSync(launcherVersions) ? readdirSync(launcherVersions).map((v) => join(launcherVersions, v, "payload", "resources", "open-design-web-standalone")) : [],
];

const b64 = readFileSync(officialIcon).toString("base64");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><image href="data:image/png;base64,${b64}" width="256" height="256"/></svg>`;

for (const root of roots) {
  const label = root.includes("launcher") ? root.split(String.fromCharCode(92)).find((s) => /^\d+\.\d+/.test(s)) ?? "launcher" : "app";
  // 1) 图标文件
  const iconDir = join(root, "apps", "web", "public", "agent-icons");
  if (existsSync(iconDir)) {
    copyFileSync(officialIcon, join(iconDir, `${id}.png`));
    writeFileSync(join(iconDir, `${id}.svg`), svg);
    console.log(`icons deployed (${label})`);
  } else {
    console.log(`icons: 无 agent-icons 目录，跳过 (${label})`);
  }
  // 2) chunk 映射表补丁
  const chunkDir = join(root, "apps", "web", ".next", "static", "chunks");
  if (!existsSync(chunkDir)) { console.log(`chunk: 无 chunks 目录，跳过 (${label})`); continue; }
  let patched = false, already = false;
  for (const f of readdirSync(chunkDir)) {
    if (!f.endsWith(".js")) continue;
    const p = join(chunkDir, f);
    const s = readFileSync(p, "utf8");
    if (!s.includes('devin:"png"')) continue; // yh 映射表所在 chunk 的签名
    if (s.includes(`${id}:"png"`)) { already = true; continue; }
    writeFileSync(p, s.replace("let yh={", `let yh={${id}:"png",`));
    patched = true;
  }
  console.log(`chunk map: ${patched ? "已注入" : already ? "已是补丁态" : "未找到映射表 chunk"} (${label})`);
}
console.log("完成。重启 OpenDesign 后生效；升级 OpenDesign 后需重跑。");
