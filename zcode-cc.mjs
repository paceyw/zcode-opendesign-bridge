#!/usr/bin/env node
/**
 * zcode-cc.mjs — OpenDesign ↔ ZCode 桥接垫片
 *
 * OpenDesign 的 claude 适配器按 claude-code 线协议 spawn 本进程：
 *   argv:  -p --input-format stream-json --output-format stream-json --verbose ...（全部忽略）
 *   stdin: JSONL user 消息 {"type":"user","message":{"content":[{"type":"text"|"image",...}]}}
 *   stdout: 期望 claude-stream-json 事件（system/init、assistant、result）
 *
 * 本垫片把每条 user 消息翻译成一次 `zcode -p <text> --mode yolo --json` 无头运行：
 *   - 文本块拼接为 prompt；图片块(base64)落临时文件后经 --attach 传入
 *   - 首回合后的回合用 --resume <zcode sessionId> 保持上下文（进程内状态）
 *   - zcode 的最终 JSON 转成 assistant + result 两帧（解析器以 message.stop_reason /
 *     result 帧为回合边界，字段名须与 OpenDesign claude-stream.ts 对齐）
 *
 * 局限（v1）：无增量流式（事件在回合结束一次性发出）；--model 忽略（用 ZCode 当前默认模型）。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// —— 插件快速通道 ——
// CLI 无头运行每次串行连接 ~60 个插件 MCP server（约 47-60 秒），回合被完全阻塞。
// 设置 settings 键 plugins.enabled=false 可跳过全部插件加载，单轮耗时 98s → 37s。
// 桌面版与 CLI 共享该配置：仅在子进程启动窗口内临时禁用，随后恢复原文件；
// 若期间文件被他人改动则不覆盖（防竞态）。垫片启动时先自愈残留的禁用态。
const CLI_CONFIG = join(homedir(), ".zcode", "cli", "config.json");
function readCliConfigText() { try { return readFileSync(CLI_CONFIG, "utf8"); } catch { return null; } }
function ensurePluginsRestored() {
  try {
    const j = JSON.parse(readCliConfigText() || "{}");
    if (j.plugins && j.plugins.__odBridgeSwap) {
      delete j.plugins.__odBridgeSwap;
      delete j.plugins.enabled; // 恢复默认（原配置未显式写该键）
      writeFileSync(CLI_CONFIG, JSON.stringify(j, null, 2));
    }
  } catch {}
}
function disablePluginsTemporarily() {
  ensurePluginsRestored();
  const orig = readCliConfigText();
  if (!orig) return () => {};
  let swapped;
  try { swapped = JSON.parse(orig); } catch { return () => {}; }
  swapped.plugins = { ...swapped.plugins, enabled: false, __odBridgeSwap: true };
  const swappedText = JSON.stringify(swapped, null, 2);
  try { writeFileSync(CLI_CONFIG, swappedText); } catch { return () => {}; }
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      const cur = readCliConfigText();
      if (cur === swappedText) writeFileSync(CLI_CONFIG, orig); // 仍是我们的版本 → 字节级还原
      else ensurePluginsRestored();                              // 被他人改过 → 只摘标记
    } catch {}
  };
  return restore;
}

const ZCODE_CJS = process.env.OD_ZCODE_CJS;
if (!ZCODE_CJS) {
  console.error("zcode-cc: missing OD_ZCODE_CJS env (path to zcode.cjs). Run install.mjs or set it in the agent profile env.");
  process.exit(1);
}
const MODEL_LABEL = process.env.ZCODE_MODEL_LABEL || "GLM-5.3";

const odSessionId = randomUUID();
let zcodeSessionId = null; // 首回合后填充，后续 --resume

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** 从 claude stream-json 的 user 帧里提取 prompt 文本与 base64 图片。 */
function extractUserInput(content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const texts = [];
  const images = [];
  for (const b of blocks) {
    if (b && b.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b && b.type === "image") {
      const src = b.source && typeof b.source === "object" ? b.source : null;
      if (src && src.type === "base64" && typeof src.data === "string") {
        images.push({ mediaType: src.media_type || "image/png", data: src.data });
      }
    }
  }
  return { text: texts.join("\n\n"), images };
}

function runZcodeTurn(prompt, imagePaths) {
  return new Promise((resolve) => {
    // Windows CreateProcess 命令行长度上限：长 prompt 落临时文件走 --attach 附件注入，
    // argv 只留短指令（OpenDesign 的设计任务含完整系统提示词，动辄几十 KB，直接进
    // -p 参数会 spawn ENAMETOOLONG——生产路径实测踩中）。
    let promptArg = prompt;
    let promptFile = null;
    if (prompt.length > 1500) {
      promptFile = join(tmpdir(), `od-zcode-prompt-${Date.now()}.md`);
      writeFileSync(promptFile, prompt);
      promptArg = "阅读附件文件中的完整任务内容，并严格按其要求执行。";
    }
    const args = [ZCODE_CJS, "-p", promptArg, "--json", "--cwd", process.cwd()];
    if (promptFile) args.push("--attach", promptFile);
    for (const p of imagePaths) args.push("--attach", p);
    if (zcodeSessionId) args.push("--resume", zcodeSessionId);

    // 实证结论：完整继承宿主环境（含 ZCODE_* 定位变量）是这台机器上唯一稳定
    // 可用的配置——CLI 自身的 fallback 探测路径在本安装上不成立（resources/glm/
    // provider 不存在）。不要清洗环境；仅确保本垫片使用的 OD_ZCODE_CJS 不在
    // ZCODE_* 命名空间内，避免与 CLI 的内部变量冲突。
    // 子进程启动窗口内禁用插件加载（省 ~60s 串行 MCP 连接），6 秒后恢复原配置。
    const restorePlugins = disablePluginsTemporarily();
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    setTimeout(restorePlugins, 6000).unref?.();
    const dbg = process.env.ZCODE_SHIM_DEBUG === "1";
    if (dbg) console.error(`[shim] spawn: ${args.join(" ").slice(0, 300)}`);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c;
      if (dbg) console.error(`[shim] stdout +${c.length}b`);
    });
    child.stderr.on("data", (c) => {
      err += c;
      if (dbg) console.error(`[shim] stderr: ${String(c).slice(0, 400)}`);
    });
    child.on("spawn", () => dbg && console.error(`[shim] child spawned pid=${child.pid}`));
    if (dbg) {
      const hb = setInterval(() => {
        console.error(`[shim] hb pid=${child.pid} killed=${child.killed} exitCode=${child.exitCode} out=${out.length}b err=${err.length}b`);
        if (child.exitCode !== null) clearInterval(hb);
      }, 15000);
      child.on("close", () => clearInterval(hb));
    }
    child.on("error", (e) => resolve({ ok: false, errors: [String(e && e.message ? e.message : e)] }));
    child.on("close", (code) => {
      restorePlugins();
      if (promptFile) rmSync(promptFile, { force: true });
      let payload = null;
      const s = out.indexOf("{");
      const e = out.lastIndexOf("}");
      if (s >= 0 && e > s) {
        try {
          payload = JSON.parse(out.slice(s, e + 1));
        } catch {
          /* fallthrough */
        }
      }
      if (payload && typeof payload.response === "string" && code === 0) {
        resolve({ ok: true, payload });
      } else {
        const errors = [];
        if (code !== 0) errors.push(`zcode exited with code ${code}`);
        if (err.trim()) errors.push(err.trim().slice(0, 2000));
        if (!payload) errors.push("could not parse zcode JSON output");
        else if (typeof payload.response !== "string") errors.push("zcode output missing response field");
        resolve({ ok: false, errors: errors.length ? errors : ["unknown zcode failure"] });
      }
    });
  });
}

async function handleUserMessage(frame) {
  busyCount++;
  try {
    await handleUserMessageInner(frame);
  } finally {
    busyCount--;
    maybeExit();
  }
}

async function handleUserMessageInner(frame) {
  const started = Date.now();
  const { text, images } = extractUserInput(frame.message && frame.message.content);
  if (!text.trim() && !images.length) return;

  let tmpDir = null;
  const imagePaths = [];
  if (images.length) {
    tmpDir = mkdtempSync(join(tmpdir(), "od-zcode-img-"));
    images.forEach((img, i) => {
      const ext = String(img.mediaType).split("/")[1] || "png";
      const p = join(tmpDir, `img${i}.${ext}`);
      writeFileSync(p, Buffer.from(img.data, "base64"));
      imagePaths.push(p);
    });
  }

  emit({ type: "system", subtype: "status", status: "working" });

  const r = await runZcodeTurn(text || "(见附件图片)", imagePaths);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });

  const usage = r.ok && r.payload.usage ? r.payload.usage : null;
  const usageFrame = usage
    ? { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0 }
    : { input_tokens: 0, output_tokens: 0 };

  if (r.ok) {
    zcodeSessionId = r.payload.sessionId || zcodeSessionId;
    emit({
      type: "assistant",
      message: {
        id: r.payload.turnId || randomUUID(),
        role: "assistant",
        model: MODEL_LABEL,
        content: [{ type: "text", text: r.payload.response }],
        stop_reason: "end_turn",
        usage: usageFrame,
      },
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: r.payload.response,
      session_id: odSessionId,
      usage: usageFrame,
      duration_ms: Date.now() - started,
      total_cost_usd: 0,
      stop_reason: "end_turn",
    });
  } else {
    emit({
      type: "result",
      subtype: "error",
      is_error: true,
      result: r.errors.join("; "),
      errors: r.errors,
      session_id: odSessionId,
      usage: usageFrame,
      duration_ms: Date.now() - started,
      total_cost_usd: 0,
      stop_reason: "error",
    });
  }
}

// daemon 可用性探测会以 <bin> --version 调用本进程
ensurePluginsRestored(); // 上次异常退出可能留下禁用态，先自愈
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("zcode-cc shim 1.0.0 (claude-wire -> zcode -p)\n");
  process.exit(0);
}

emit({ type: "system", subtype: "init", session_id: odSessionId, model: MODEL_LABEL, tools: [] });

let buf = "";
let stdinClosed = false;
let busyCount = 0;
function maybeExit() {
  if (stdinClosed && busyCount === 0) process.exit(0);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let frame = null;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame && frame.type === "user") {
      handleUserMessage(frame).catch((e) =>
        emit({
          type: "result",
          subtype: "error",
          is_error: true,
          result: `shim failure: ${e && e.message ? e.message : String(e)}`,
          session_id: odSessionId,
          usage: { input_tokens: 0, output_tokens: 0 },
          duration_ms: 0,
          total_cost_usd: 0,
          stop_reason: "error",
        })
      );
    }
  }
});
process.stdin.on("end", () => {
  // stdin EOF ≠ 立即退出：进行中的回合必须跑完（此前版本 1 秒后强杀自身，
  // 回合中途变孤儿进程，表现为"无输出挂起"）。
  stdinClosed = true;
  maybeExit();
});
