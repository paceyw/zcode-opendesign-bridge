#!/usr/bin/env node
/**
 * install.mjs — 把 ZCode 注册为 OpenDesign 的本地设计引擎（claude-wire 桥接）
 *
 * 做三件事（幂等，可重复运行）：
 *   1. 复制 zcode-cc.mjs 到 ~/.open-design/zcode-cc.mjs
 *   2. 自动探测本机 ZCode 安装（zcode.cjs 路径、builtin provider 配置的最新版本）
 *   3. 生成/合并 ~/.open-design/agents.local.json 中的 "zcode" profile
 *
 * 用法：
 *   node install.mjs [--zcode-cjs <path>] [--uninstall]
 *
 * 装完重启 OpenDesign（或其 daemon）后，Agent 切换器里出现 "ZCode CLI"。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OD_DIR = join(homedir(), ".open-design");
const SHIM_DST = join(OD_DIR, "zcode-cc.mjs");
const PROFILE_FILE = join(OD_DIR, "agents.local.json");
const PROFILE_ID = "zcode";

const args = process.argv.slice(2);
if (args.includes("--uninstall")) {
  let profiles = [];
  if (existsSync(PROFILE_FILE)) {
    try {
      const j = JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
      profiles = Array.isArray(j) ? j : Array.isArray(j.agents) ? j.agents : [];
    } catch {
      profiles = [];
    }
  }
  const rest = profiles.filter((p) => p && p.id !== PROFILE_ID);
  if (rest.length) writeFileSync(PROFILE_FILE, JSON.stringify(rest, null, 2) + "\n");
  else if (existsSync(PROFILE_FILE)) rmSync(PROFILE_FILE);
  if (existsSync(SHIM_DST)) rmSync(SHIM_DST);
  console.log(`removed '${PROFILE_ID}' profile${rest.length ? " (kept other profiles)" : " and " + PROFILE_FILE}`);
  process.exit(0);
}

// --- 1. 定位 zcode.cjs ------------------------------------------------------
const argCjs = args.indexOf("--zcode-cjs") >= 0 ? args[args.indexOf("--zcode-cjs") + 1] : null;
const candidates = [
  argCjs,
  process.env.ZCODE_CJS_CLI,
  join(process.env.LOCALAPPDATA || "", "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
  join(process.env.ProgramFiles || "C:\\Program Files", "ZCode", "resources", "glm", "zcode.cjs"),
].filter(Boolean);
const zcodeCjs = candidates.find((p) => existsSync(p));
if (!zcodeCjs) {
  console.error("找不到 zcode.cjs。请用 --zcode-cjs <路径> 指定。尝试过：\n  " + candidates.join("\n  "));
  process.exit(1);
}
const installDir = dirname(dirname(dirname(zcodeCjs))); // .../resources/glm -> 安装根目录

// --- 2. 选最新的正式版 builtin provider 配置（ZCode 升级后路径会变）----------
// 目录结构 .../<arch>/<version>/endpoint-<hash>/zcode-builtin.json。
// 按 semver 取最高正式版；dev/预发布与 mtime 都不可信（测试运行会刷新 0.0.0-dev）。
function latestReleaseProviderConfig() {
  const root = join(homedir(), ".zcode", "v2", "runtime", "provider");
  if (!existsSync(root)) return null;
  const semver = (s) => {
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)$/);
    return m ? [+m[1], +m[2], +m[3]] : null; // 非正式版必须返回 null（空数组是真值，会绕过 !v 过滤）
  };
  let best = null; // { path, v:[major,minor,patch] }
  for (const arch of readdirSync(root)) {
    const archDir = join(root, arch);
    if (!statSync(archDir).isDirectory()) continue;
    for (const ver of readdirSync(archDir)) {
      const v = semver(ver);
      if (!v) continue; // 跳过 0.0.0-dev 等
      const verDir = join(archDir, ver);
      for (const ep of readdirSync(verDir)) {
        const p = join(verDir, ep, "zcode-builtin.json");
        if (!existsSync(p)) continue;
        if (!best || v[0] * 1e6 + v[1] * 1e3 + v[2] > best.v[0] * 1e6 + best.v[1] * 1e3 + best.v[2]) best = { path: p, v };
      }
    }
  }
  return best && best.path;
}
const builtinProvider = latestReleaseProviderConfig();
if (!builtinProvider) {
  console.error("找不到 ~/.zcode/v2/runtime/provider/**/zcode-builtin.json（ZCode 未登录或未初始化？）");
  process.exit(1);
}

// --- 3. 写入 shim 与 profile ------------------------------------------------
mkdirSync(OD_DIR, { recursive: true });
copyFileSync(join(here, "zcode-cc.mjs"), SHIM_DST);

const profile = {
  id: PROFILE_ID,
  name: "ZCode CLI",
  baseAgent: "claude",
  bin: "node", // 必须是 PATH 上可解析的裸命令名；daemon 的探测对绝对路径 bin 不成立
  args: [SHIM_DST],
  // 可用性探测：args 只进 buildArgs（回合），不进版本探测；不设 versionArgs 时
  // daemon 只会跑 `node --version`，桥坏了也显示"可用"。指向桥脚本让探测真实校验链路。
  versionArgs: [SHIM_DST, "--version"],
  // 模型列表：只列真实可用的（zcode CLI 无 --model 参数，切换不生效，故只放默认款）
  models: ["GLM-5.3"],
  defaultModel: "GLM-5.3",
  env: {
    OD_ZCODE_CJS: zcodeCjs,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(homedir(), ".zcode", "v2", "provider_config.json"),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinProvider,
    ZCODE_WINDOWS_APP_INSTALL_DIR: installDir,
    ZCODE_ENV: "production",
    ZCODE_RUNTIME_ENV: "production",
    ZCODE_BASE_URL: "https://zcode.z.ai",
    ZAI_BUSINESS_BASE_URL: "https://api.z.ai",
    ZAI_OAUTH_ORIGIN: "https://chat.z.ai",
  },
};

let profiles = [];
if (existsSync(PROFILE_FILE)) {
  try {
    const j = JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
    profiles = Array.isArray(j) ? j : Array.isArray(j.agents) ? j.agents : [];
  } catch {
    profiles = []; // 损坏文件：备份后重建
    copyFileSync(PROFILE_FILE, PROFILE_FILE + ".bak");
  }
}
const merged = [...profiles.filter((p) => p && p.id !== PROFILE_ID), profile];
writeFileSync(PROFILE_FILE, JSON.stringify(merged, null, 2) + "\n");

console.log("已写入：");
console.log("  " + SHIM_DST);
console.log("  " + PROFILE_FILE + `（profile "${PROFILE_ID}"）`);
console.log("\n探测结果：");
console.log("  zcode.cjs        = " + zcodeCjs);
console.log("  builtin provider = " + builtinProvider);
console.log("\n下一步：重启 OpenDesign（退出再打开，或重启其 daemon），");
console.log('然后在 Agent 切换器里选择 "ZCode CLI"。');
console.log("可选：node deploy-icon.mjs 铺官方图标。");console.log("注意：ZCode 升级后请重跑本安装脚本（provider 配置路径随版本变化）。");
