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
git clone <this repo>
cd zcode-opendesign-bridge
node install.mjs
```

The installer (idempotent):

1. copies `zcode-cc.mjs` to `~/.open-design/zcode-cc.mjs`
2. auto-detects your ZCode install: `zcode.cjs` path and the **newest** built-in provider config under `~/.zcode/v2/runtime/provider/`
3. writes the `zcode` agent profile into `~/.open-design/agents.local.json` (OpenDesign's documented user-level extension point; other profiles are preserved)

Then restart OpenDesign (or its daemon) and pick **"ZCode (GLM)"** in the agent switcher.

`node install.mjs --uninstall` removes the profile and shim.

## Troubleshooting

- **Agent shows unavailable** — the profile's `bin` must be a bare command name resolvable on PATH (`node`). Absolute paths fail OpenDesign's PATH-scan probe.
- **"无法定位 provider config" from the child** — the ZCode CLI needs `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` to locate its providers on some installs; the installer sets it. **Re-run the installer after every ZCode upgrade** (the path is version-pinned).
- **Turns route to the wrong provider** — if your environment defines `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (personal/third-party providers), the child may pick it up; remove it from the profile env to pin the built-in Coding Plan.
- **Silent hang diagnosed** — older bridge versions exited ~1s after stdin EOF even mid-turn (orphaning the child). Current version exits only when stdin is closed **and** no turn is in flight.
- **Debugging** — run the bridge by hand and watch heartbeats:
  ```bash
  printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}' \
    | OD_ZCODE_CJS=<path to zcode.cjs> ZCODE_SHIM_DEBUG=1 node ~/.open-design/zcode-cc.mjs
  ```
  You should see `system/init`, `system/status`, then `assistant` + `result` frames.

## Files

- `zcode-cc.mjs` — the bridge (single file, no dependencies)
- `install.mjs` — installer / uninstaller

## License

MIT

## Troubleshooting: "Model creation failed" / fast-failing CLI test

The ZCode CLI keeps a **local lease/backoff file** per provider endpoint
(`~/.zcode/v2/runtime/provider/<arch>/<ver>/endpoint-*/zcode-builtin-refresh.json`).
Repeated failures push `nextEligibleAt` further into the future, after which every
new CLI process skips the built-in provider instantly ("Built-in skipped
(not-due)") — which surfaces here as a ~4s failing test with no useful error.

If the underlying condition is gone but the backoff still masks your test, reset it:

```bash
node reset-provider-backoff.mjs   # zeroes lease/backoff across all versions
```

Note: repeated test-button clicks while the provider is unhealthy keep extending
the backoff — test once, wait, then retest.

## Troubleshooting: headless "Select a model before continuing"

The ZCode CLI's `-p` headless mode needs a default model from the **personal
provider config** (`~/.zcode/v2/provider_config.json`). Hard-won specifics:

- **The desktop app is the only writer it trusts.** Hand-written rules are
  silently ignored unless they match the desktop's exact shape: `personalModelIds`
  and `manualProviderModelRules` must be **arrays** (not objects), and the rule
  must NOT carry an `api` override (baseUrl comes from the template).
- Add the provider via **ZCode desktop → Settings → Models & Providers**
  (BigModel template + your Coding Plan API key). That produces a CLI-readable rule.
- Desktop-written OAuth *credentials* are encrypted with a desktop-process-only
  secret — CLI children cannot use them; the API-key provider rule above is the
  portable path.
- The CLI's own builtin-config fallback path is broken on some installs; the
  profile env therefore sets the `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` /
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` pair explicitly (they must be set together).

## Note: the OD "test CLI" button times out (~45s)

A real ZCode turn takes ~2 minutes (the CLI injects a ~25k-token system prompt
before every headless turn). OpenDesign's test button aborts at ~45 seconds, so
it will report a timeout even though the engine works. Verify with an actual
conversation instead of the test button. See `examples/` for an MCP-driven
project/page creation script you can run from any agent session.
