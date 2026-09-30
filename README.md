# zcode-opendesign-bridge

Use **ZCode** (GLM coding plan) as a local design engine inside **[OpenDesign](https://github.com/nexu-io/open-design)** — via a claude-wire protocol bridge.

OpenDesign drives 16+ coding-agent CLIs, but ZCode is not among them: its `app-server` speaks the ZCode protocol (not Codex JSON-RPC, not ACP), and its headless `zcode -p` prints one final JSON object instead of a stream. This repo adds the missing adapter as a **local agent profile + a small stdio bridge** — no fork of either app required.

```
OpenDesign daemon
   │  spawn (claude-stream-json wire: -p --input-format stream-json ... )
   ▼
~/.open-design/zcode-cc.mjs        ← this bridge (long-lived, reads user turns on stdin)
   │  spawn per turn
   ▼
node zcode.cjs -p <prompt> --json --cwd <project>   [--attach img] [--resume <sid>]
   │  GLM via ZCode Coding Plan (built-in provider)
   ▼
assistant + result frames (claude-stream-json) → OpenDesign UI
```

## What works

- Text turns, multi-turn (each turn resumes the same ZCode session via `--resume`, so context survives within one OpenDesign conversation)
- Image attachments: base64 images in the user message are written to temp files and passed via `--attach`
- Long prompts: OpenDesign's design briefs (tens of KB) are written to a temp file and attached, keeping argv inside Windows' command-line limit
- Clean error frames: child failures (provider outages, rate limits) surface as `result{is_error:true}` instead of silent hangs
- Headless-friendly: emits `--version` for OpenDesign's availability probe

## Limitations (v1)

- No live token streaming — events are emitted when the turn completes (ZCode's `-p --json` returns a single JSON object)
- `--model` is ignored; turns use the CLI default model of your Coding Plan. The profile therefore advertises only `GLM-5.3` (a list with unswitchable entries would mislead)
- OpenDesign's media MCP is not injected into the ZCode child process
- If OpenDesign spawns a fresh bridge process (new conversation), ZCode context starts over

## Install

Requirements: OpenDesign desktop app, ZCode desktop install (logged in to your Coding Plan), Node.js ≥ 18 on PATH. Windows is tested; the bridge itself is plain Node and should port to macOS/Linux.

```bash
git clone https://github.com/paceyw/zcode-opendesign-bridge
cd zcode-opendesign-bridge
node install.mjs        # idempotent; --uninstall removes everything
node deploy-icon.mjs    # optional: put the official ZCode icon into OpenDesign's UI
```

The installer:

1. copies `zcode-cc.mjs` to `~/.open-design/zcode-cc.mjs`
2. auto-detects your ZCode install: `zcode.cjs` path and the **newest release** built-in provider config under `~/.zcode/v2/runtime/provider/`
3. writes the `zcode` agent profile into `~/.open-design/agents.local.json` (OpenDesign's documented user-level extension point; other profiles are preserved)

Then restart OpenDesign (or its daemon) and pick **"ZCode CLI"** in the agent switcher. Re-run both scripts after upgrading OpenDesign or ZCode (paths are version-pinned).

## Files

- `zcode-cc.mjs` — the bridge (single file, no dependencies)
- `install.mjs` — installer / uninstaller
- `deploy-icon.mjs` — puts the official ZCode app icon into OpenDesign's `agent-icons` (profile-based agents carry no icon of their own)
- `reset-provider-backoff.mjs` — clears the CLI's local provider lease/backoff state
- `examples/` — MCP-driven project + page creation from any agent session

## Troubleshooting

**Runs fail in < 6 s with `Model creation failed (traceId: …)` right after a ZCode upgrade** — ZCode ≥ 22.20.0 (CLI 0.16.9) resets `~/.zcode/v2/provider_config.json` to an empty skeleton on upgrade, dropping the personal Coding Plan provider rule that headless `-p` turns depend on (OAuth login is unusable by CLI children). The same release's "add provider" dialog can fail with 「创建供应商失败：个人供应商配置格式无效」, blocking the UI path to re-create it. Recovery: restore the rule by hand with the CLI-verified shape below (arrays, no `api` override), then `node reset-provider-backoff.mjs`. Full write-up: the "Provider / Coding Plan setup" section of [`docs/zcode-agent.md`](https://github.com/nexu-io/open-design/blob/main/docs/zcode-agent.md) in the OpenDesign docs PR #8525.

**Agent shows unavailable** — the profile's `bin` must be a bare command name resolvable on PATH (`node`). Absolute paths fail OpenDesign's PATH-scan probe.

**"无法定位 provider config" from the child** — the ZCode CLI needs `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` to locate its providers on some installs; the installer sets it (as an env pair with `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` — they must be set together). Re-run the installer after every ZCode upgrade.

**Headless "Select a model before continuing"** — the `-p` mode needs a default model from the personal provider config (`~/.zcode/v2/provider_config.json`). Hard-won specifics:

- **The desktop app is the only writer it trusts.** Hand-written rules are silently ignored unless they match the desktop's exact shape: `personalModelIds` and `manualProviderModelRules` must be **arrays** (not objects), and the rule must NOT carry an `api` override (baseUrl comes from the template).
- Add the provider via **ZCode desktop → Settings → Models & Providers** (BigModel template + your Coding Plan API key). That produces a CLI-readable rule.
- Desktop-written OAuth *credentials* are encrypted with a desktop-process-only secret — CLI children cannot use them; the API-key provider rule above is the portable path.

**Fast-failing CLI test (~4s, no useful error)** — the CLI keeps a local lease/backoff file per provider endpoint (`~/.zcode/v2/runtime/provider/<arch>/<ver>/endpoint-*/zcode-builtin-refresh.json`). Repeated failures push `nextEligibleAt` into the future, after which every new process skips the provider instantly. Reset with `node reset-provider-backoff.mjs`, and don't spam the test button while the provider is unhealthy — each failure extends the backoff.

**The OD "test CLI" button times out (~45s)** — a real ZCode turn takes up to ~2 minutes (the CLI injects a ~25k-token system prompt before every headless turn), while the button aborts at ~45 seconds. With a warm prompt cache a minimal turn can pass in ~15s, but don't treat the button as ground truth — verify with an actual conversation.

**Silent hang (older versions)** — early bridges exited ~1s after stdin EOF even mid-turn, orphaning the child. Current version exits only when stdin is closed **and** no turn is in flight.

**Debugging** — run the bridge by hand and watch heartbeats:

```bash
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}' \
  | OD_ZCODE_CJS=<path to zcode.cjs> ZCODE_SHIM_DEBUG=1 node ~/.open-design/zcode-cc.mjs
```

You should see `system/init`, `system/status`, then `assistant` + `result` frames.

## License

MIT

## Performance: headless turns were ~100s → now ~37s

The CLI serially connects every plugin's MCP server at startup (~60 servers ≈
47-60s) and **blocks the turn until they all settle**. The bridge now toggles
the `plugins.enabled` settings key off for the child's startup window and
restores the original file afterwards (race-guarded; self-heals on next start).
Design runs don't lose anything — plugin MCPs aren't available to headless
children anyway. If you'd rather keep plugins loaded for CLI runs, delete the
`disablePluginsTemporarily` call in `zcode-cc.mjs`.
