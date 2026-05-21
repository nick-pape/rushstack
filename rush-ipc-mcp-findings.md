# rush-ipc-mcp — findings & design log

A living document for the effort to expose a running Rush build/watch host to agents via MCP.
Update this as work proceeds (append to the Validation log; revise sections in place).

Owner: nickpape · Started 2026-05-21

---

## 1. Goal & motivation

Let agents observe and control a Rush build **without running `rush` directly**, because direct
invocation is: (A) token-wasteful, (B) breaks with parallel agents (they fight the repo lock),
(C) not visible, (D) impossible without giving the agent a shell.

Originally conceived as a standalone `rush-ipc-mcp`; refined to a feature **inside the existing
`@rushstack/mcp-server`** (first-class tools, not the disliked plugin framework — also the
upstream-friendly / "makes Pete happy" path).

## 2. Architecture decisions

- **Topology = wrap rush-serve.** The long-lived build host is `rush start` running
  `@rushstack/rush-serve-plugin`, which already exposes an HTTP/2 + WebSocket server. The MCP is a
  thin Layer-2 client that connects to that WebSocket and re-exposes it as MCP tools. Each agent gets
  its own short-lived stdio MCP process; all share one `rush start`.
- **Code location = extend `apps/rush-mcp-server`** with first-class tools (cohesive `buildHost/`
  subfolder, easy to relocate). Not a new Rush package; not an MCP plugin.
- **v1 scope = observe + control watch + logs + run rush cmds.**

## 3. How Rush's "IPC" actually works (two layers)

Rush's built-in "IPC" is **not** a daemon you connect to. It's parent→child worker lifecycle within
one `rush <cmd> --watch` process (the host).

- **Layer 1 — host ↔ worker** (Node `child_process` fork IPC, stdio includes `'ipc'`):
  protocol in `libraries/operation-graph/src/protocol.types.ts`. Host→worker: run/cancel/exit/sync.
  Worker→host: sync/requestRun/after-execute. Worker side = `WatchLoop.runIPCAsync()`
  (`libraries/operation-graph/src/WatchLoop.ts`); host side = `IPCOperationRunner` +
  `IPCOperationRunnerPlugin` (`libraries/rush-lib/src/logic/operations/`). Keeps per-`project#phase`
  build tools warm across rebuilds. Gated by experiment `useIPCScriptsInWatchMode` + `--no-ipc`;
  fires only for projects with `<phase>:ipc` / `<phase>:incremental:ipc` scripts. Carries
  `OperationStatus`, not logs (logs flow over stdout/stderr).
- **Layer 2 — host ↔ observer** (WebSocket): `rush-plugins/rush-serve-plugin` taps host hooks
  (createOperations / beforeExecuteOperations / onOperationStatusChanged / afterExecuteOperations)
  and rebroadcasts. **This is the observability + control plane our MCP consumes.**

Watch control today (TTY only) lives in `PhasedScriptAction._registerWatchModeInterface`: keys
`q` quit, `a` abort, `w` pause/resume, `i` invalidate-all, `c` changed-only, `b` build-once,
`x` reset child procs. Not programmatic. Per-project granularity = invalidate, not subscribe.

Logs/state on disk: `<project>/.rush/operations/<phase>/*.log` (+ `.error.log`, jsonl);
timing/cobuild in `.rush/temp/operation/<phase>/state.json`.

rush-lib's public API is model/config-centric; the CLI **actions** (install/build managers) are NOT
exported. External tools load via `@rushstack/rush-sdk` (supports deep imports
`@rushstack/rush-sdk/lib/...`).

## 4. rush-serve WebSocket protocol (Layer-2, what we consume)

Source of truth: `rush-plugins/rush-serve-plugin/src/api.types.ts` (types-only entrypoint
`@rushstack/rush-serve-plugin/api`). We keep a local mirror at
`apps/rush-mcp-server/src/buildHost/protocol.types.ts` to avoid a runtime dep — keep them in sync.

- **Server→client events:** `sync` (full ops + sessionInfo + overall status, on connect/request),
  `before-execute` (ops at pass start), `status-change` (batched per-op deltas, debounced via
  setImmediate), `after-execute` (ops + overall status).
- **Client→server commands:** `sync`, `invalidate {operationNames}`, `abort-execution`,
  `set-enabled-states {name → never|changed|affected|default}`.
- **`IOperationInfo`:** name, dependencies[], packageName, phaseName, enabled, silent, noop, status
  (PascalCase), logFileURLs {text,error,jsonl} (serve-relative), startTime, endTime
  (**not wall-clock — only completed ops yield a meaningful duration**).
- Transport: HTTP/2 secure server with a self-signed debug cert (`CertificateManager`); ephemeral
  port unless a `portParameterLongName` is configured. Logs served as static files at `logServePath`.
- **Lives inside `rush start`; dies with it.** Not a cross-invocation daemon — persistence is still
  ours to add (later phase).

## 5. Locking model & the install/build coordination problem

Decisive constraint, confirmed in code: repo-wide lock `'rush'` in `commonTempFolder`, acquired
non-blocking (`LockFile.tryAcquire`) in `BaseConfiglessRushAction.onExecuteAsync()`
(`libraries/rush-lib/src/cli/actions/BaseRushAction.ts` ~line 68). Held for the **whole command**
(released on process exit). On contention: prints "Another Rush command is already running" and
`process.exit(1)` — instant, doesn't queue. Skipped by `safeForSimultaneousRushProcesses=true`:
**check, change, deploy, list, scan** (read-only, runnable alongside a watch).

Therefore:
- Read-only commands → shell out anytime, even during a watch.
- Mutating commands (install/update/add/remove) are blocked by the lock AND inherently stop-the-world
  (they rewrite node_modules under a running build).

**Key seam:** the lock is at the **action** layer, not the **manager** layer. Reusable, CLI-decoupled
entry points exist: install/update → `InstallManagerFactory.getInstallManagerAsync()` →
`installManager.doInstallAsync()`; add/remove → `PackageJsonUpdater.doRushUpdateAsync()`; check →
`VersionMismatchFinder.rushCheck()` (static, already lock-free). A daemon that holds the lock once can
call these directly in-process without re-acquiring.

**Two paths for "run other rush commands":**
- **Path 1 (stopgap, current direction):** wrap `rush start`; shell out read-only cmds; for install do
  a coarse stop-watch → install → relaunch (loses warm workers).
- **Path 2 (the `rush daemon` refactor):** a first-class long-lived process that owns the lock once,
  hosts the watch (operation-graph + ProjectWatcher + rush-serve WS), and runs install/update/check/add
  in-process via the manager classes, serializing internally. Aligns with the existing "long-lived
  operation graph" TODOs in `PhasedScriptAction` / `IPCOperationRunnerPlugin`; upstream-worthy.

## 6. Phasing plan

- **Phase 0** — live target + protocol spike. *(done implicitly while validating Phase 1)*
- **Phase 1** — read-only MCP: observe + logs. ✅ **done, committed, validated live**
- **Phase 2** — control the watch (rebuild / set-watch-state / abort). ✅ **done, validated live**
- **Phase 3** — read-only rush commands (check/list) via shell-out. ✅ **done, validated via shim**
- **Phase 4** — spawn-or-connect (stop requiring a pre-started watch). ✅ **done, validated via shim**
- **Phase 5** — mutating rush commands (the Path-1 stop-the-world dance). ✅ **done, validated via shim**
- **Phase 6 / Path 2 (chosen)** — `rush daemon`: a persistent supervisor owns one shared watch; see §11.
  - 6a — daemon foundation (supervisor + discovery + graceful shutdown). ✅ **done, validated standalone**
  - 6b — wire the MCP client to start-or-connect to the daemon (+ shutdown tool). ✅ **done, validated**
  - 6c — auto-restart supervision. ✅ **done, validated**. (Daemon-*mediated* mutating via a control
    socket: intentionally NOT built — see note below; the current "stop the daemon, run, lazy restart"
    is correct and composes with supervision, and proper mediation belongs in 6d.)
  - 6d — upstream `rush daemon` in rush-lib with in-process managers (no child `rush start`).

**Why mutating kills the whole daemon (not just its watch):** with supervision, if a client killed only
the watch to free the lock, the daemon would immediately restart the watch and fight the in-flight
`install` for the lock. Killing the daemon removes the supervisor cleanly so nothing races the install;
a fresh daemon starts lazily afterward. Daemon-*mediated* install (daemon pauses supervision → runs →
resumes) needs a control channel and is the right shape for 6d, not a bespoke socket now.

## 7. Implementation status

Branch `nickpape/mcp-build-host-tools`, pushed to the fork as **in-fork PR #20**
(`nick-pape/rushstack` main ← branch). Phases 1–3 committed (commit hashes were rewritten to the
noreply email during the first push — see Validation log).

**Tools (all in `@rushstack/mcp-server`, sharing one lazy `RushServeClient`):**
- `rush_build_status` — compact: host id, overall status, status counts, only non-green ops; `project`
  filter + `includeAll`.
- `rush_build_logs` — per-project/phase log, `tailLines` (default 200) + `errorsOnly`; disambiguates
  multiple phases; "no errors" when stderr log absent.
- `rush_rebuild` — invalidate a project's operations (force rebuild).
- `rush_set_watch_state` — set enabled state (never|changed|affected|default) per project/phase.
- `rush_abort_build` — abort the current execution pass.
- `rush_run_command` — run an allowed Rush command via shell-out (allowlist enforced in BOTH the
  schema and the handler; uses `CommandRunner.runRushCommandCaptureAsync`, output regardless of exit
  code). Read-only (`check`, `list`) run directly. **Mutating** (`install`, `update`, `add`, `remove`)
  need the repo lock: if we started the watch, it is stopped first (restarts lazily on next build
  query); if a watch we did NOT start is connected, the command is refused.

**File inventory:**
- `apps/rush-mcp-server/src/buildHost/protocol.types.ts` — local mirror of rush-serve `/api` (events + commands).
- `apps/rush-mcp-server/src/buildHost/RushServeClient.ts` — lazy wss client, in-memory snapshot,
  `findOperations`, `sendCommandAsync`, https log fetch (`undefined` on 404), and **spawn-or-connect**:
  tries the configured URL, and if unreachable + autostart, spawns the start command, scrapes the
  ephemeral port from its stdout, and connects. The host is terminated via `SubprocessTerminator`
  (whole-tree kill) on dispose and on process exit/SIGINT/SIGTERM. TLS via `rejectUnauthorized:false`
  (TODO: trust the debug CA).
  Env config (all **`RUSHMCP_`**-prefixed — NOT `RUSH_`, see gotcha below):
  `RUSHMCP_BUILD_STATUS_WS_URL` (default `wss://localhost:8443/`), `RUSHMCP_BUILD_AUTOSTART`
  (default on), `RUSHMCP_BUILD_START_COMMAND` (default `rush start`), `RUSHMCP_BUILD_START_TIMEOUT_MS`.
- `apps/rush-mcp-server/src/tools/build-status.tool.ts`, `build-logs.tool.ts`, `build-rebuild.tool.ts`,
  `build-watch-state.tool.ts`, `build-abort.tool.ts`.
- Wired in `src/server.ts` + `src/tools/index.ts`. Added deps `ws ~8.20.0` + `@types/ws 8.5.5`.

## 8. Validation log & gotchas (chronological)

- **Build:** fresh checkout → first build needs the toolchain via `rush build --to @rushstack/mcp-server`
  (~2 min); thereafter `rush build --only @rushstack/mcp-server` (~11 s).
- **Compile gotcha:** `ClientRequest` is exported from `node:http`, not `node:https`.
- **Phase 1 live (against real `rush start` + rush-serve):** status (compact/includeAll/filter),
  multi-phase log disambiguation, and HTTPS log tail all worked.
- **Log gotcha (fixed):** `.error.log` only exists when there's stderr → `errorsOnly` 404'd on clean
  builds. `fetchLogTextAsync` now returns `undefined` on 404; the logs tool reports "no errors."
- **Lock observed live:** `rush build` refused while the watch held the lock ("Another Rush command is
  already running"). Workaround for compiling during a watch: run the project's local
  `apps/rush-mcp-server/node_modules/.bin/heft build` (bypasses the orchestrator lock).
- **Phase 2 live:** `rush_rebuild` fired while the watch was idle produced
  `Watch Status: Projects were invalidated: @rushstack/tree-pattern (build) (Invalidated via WebSocket)`
  → fresh build cycle. set-watch-state and abort accepted.
- **rush-serve behavior #1 (cold watch):** `invalidate` / `set-enabled-states` are **no-ops until the
  first watch iteration runs**, because rush-serve captures `context.invalidateOperation` in its
  createOperations tap and `PhasedScriptAction` only supplies it in the watch loop (~line 928), not the
  initial build. Design implication: MCP may want to surface "watch not warmed yet" or nudge an initial
  iteration so control tools work immediately.
- **rush-serve behavior #2 (coalescing):** an `invalidate` sent while a build is in-flight folds into
  the running build (no separate cycle).
- **Phase 3 live (via shim):** `rush` isn't on PATH in the sandbox; tested with a `rush` shim that
  delegates to `common/scripts/install-run-rush.js`. `rush list` / `rush check` return real output
  (exit 0). **Defense-in-depth finding:** enforce the allowlist *in the handler*, not only via the zod
  schema — calling `executeAsync` directly bypasses schema validation (a direct call accidentally ran
  `rush install`, which bailed at the git-email policy before changing anything).
- **PR/push gotchas:** GitHub blocked the push (private email) → rewrote the commits to
  `5674316+nick-pape@users.noreply.github.com` via `git filter-branch` (`rebase --exec --reset-author`
  did NOT take — rebase re-exports the original author env). `gh pr create` failed under SAML because it
  reads the upstream parent (microsoft/rushstack); created the PR via
  `gh api repos/nick-pape/rushstack/pulls` instead. Commit with inline
  `-c user.email='5674316+nick-pape@users.noreply.github.com' -c user.name='Nick Pape'`.
- **Phase 4 live (via shim):** with the configured port free, the client auto-started
  `rush start`, scraped its ephemeral port from stdout, connected, and returned status (~1.4s when cached).
- **MAJOR gotcha — reserved `RUSH_` prefix:** the spawned `rush` inherits the parent env, and Rush
  **errors out on any unrecognized `RUSH_`-prefixed variable** ("not recognized by this version of
  Rush" → exit 1). Our config vars were originally `RUSH_BUILD_*`; renamed to `RUSHMCP_*`, and the
  spawn also strips `RUSHMCP_*` from the child env. (Don't squat on Rush's namespace — also an
  upstream-review concern.)
- **Reaping (hardened):** the client now terminates the spawned host with `SubprocessTerminator`
  (`@rushstack/node-core-library`): spawn with `RECOMMENDED_OPTIONS` (detached on POSIX),
  `killProcessTreeOnExit` to reap on our exit/SIGINT/SIGTERM, and `killProcessTree` (SIGKILL of the
  group on POSIX, `TaskKill /T` on Windows) on dispose. Verified: after dispose, no orphaned
  `rush start` remains and the repo lock is released — even through the `install-run` shim tree.
  (Caveat: if our process is `kill -9`'d, nothing can run cleanup; that's inherent.)
  Stray-process cleanup during testing, BY PID (do NOT `pkill -f` patterns that also match your own
  shell — that kills the build): `for p in $(ps -eo pid,args | grep 'rush start' | grep -v grep |
  awk '{print $1}'); do kill -9 $p; done` and `rm -f common/temp/rush#*.lock`.
- **Phase 5 live (via shim):** `rush_run_command` read-only `list` ran directly (exit 0); a mutating
  `install` while our watch was running stopped the watch (freeing the lock), ran `rush install`
  (exit 0), and left no orphan — `isHostSpawnedByUs` went true→false. The external-watch refusal branch
  (`isConnected && !isHostSpawnedByUs`) is trivial logic and was not stood up as a separate e2e.
  Note: `rush install` needs `--bypass-policy` in this repo (git-email policy); real users won't.
- **Phase 6a live (daemon foundation, via shim):** ran `node lib-commonjs/daemon/start.js <repo>`; it
  spawned the watch, scraped the port, printed `Build host ready at wss://localhost:33309/` and wrote
  `common/temp/rushmcp-build-host.json` {webSocketUrl, daemonPid, startedAt}. A raw WS client connected
  to the discovered URL and got `[sync] ops=4 status=Success`. `SIGTERM` to the daemon → discovery
  cleared, watch tree reaped (no orphans) — graceful shutdown confirmed.
- **Phase 6b live (client wired to daemon, via shim):** client A (a node process) cold-started the
  daemon and exited; the daemon **persisted** (same pid alive, 1 daemon process). Client B (a separate
  process) **reused the same daemon** via the discovery file — same pid + URL, still 1 daemon. A
  mutating `install` stopped the shared daemon (freed the lock, ran at exit 0, no orphan; restarts
  lazily). `rush_shutdown_host` stopped the daemon (dead, discovery cleared). Client model changed:
  the client no longer owns the watch (the daemon does); `disposeAsync` is a no-op so the shared host
  survives MCP exits; mutating commands stop the daemon (any client can) rather than refusing.
- **Phase 6c live (supervision, via shim):** with the daemon serving at port 45731, killed its watch
  process group to simulate a crash. The daemon logged `Watch exited; restarting...` and came back at a
  NEW port (34529), same daemon pid, discovery file updated. A client then connected to the restarted
  watch via discovery (`POST-RESTART: Overall status: Success`). `SIGTERM` → clean shutdown, no orphans.
  Crash-loop guard: gives up after `MAX_CONSECUTIVE_FAILURES` fast failures.

## 9. Running the live test harness (repro)

Wired into THIS repo for validation (kept uncommitted — it's a harness, not the feature):
1. `common/autoinstallers/plugins/package.json` ← add `@rushstack/rush-serve-plugin@5.175.1`.
2. `common/config/rush/rush-plugins.json` ← register the plugin (autoinstaller `plugins`).
3. `common/config/rush-plugins/rush-serve-plugin.json` ← `{ phasedCommands:["start"],
   buildStatusWebSocketPath:"/", logServePath:"/log" }`.
4. `rush update --bypass-policy` (full update harvests the plugin manifest — `update-autoinstaller`
   alone gives "Manifest not found"; `--bypass-policy` skips this repo's git-email policy).
5. `rush start --only @rushstack/tree-pattern` (small prebuilt project). It prints
   `Content is being served from: https://localhost:<PORT>/`.
6. Point the client at it: `RUSHMCP_BUILD_STATUS_WS_URL=wss://localhost:<PORT>/` and call the built tools
   in `apps/rush-mcp-server/lib-commonjs/...`.
- Git identity: the env sets `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` to the private address, which
  **overrides `-c user.email`**. GitHub blocks pushing the private email, so commit with the env vars
  overridden, e.g. prefix with
  `GIT_AUTHOR_EMAIL=5674316+nick-pape@users.noreply.github.com GIT_COMMITTER_EMAIL=5674316+nick-pape@users.noreply.github.com`.
  Pre-commit hook runs `rush prettier`.

## 10. Open questions / next steps

- Cold-watch handling (behavior #1) — surface state or auto-warm?
- Phase 6 (multi-agent sharing): a discovery file so a second MCP can find a watch the first one
  spawned (rush-serve uses an ephemeral port with no discovery today); likely add
  port + wsPath + logServePath + repoId + pid, upstream-able. Race-safe spawn (LockFile).
- TLS hardening: trust the debug CA instead of `rejectUnauthorized:false`.
- Whether to commit the rush-serve test harness or document it as setup.

## 11. `rush daemon` (Path 2) design

Chosen over the "MCP spawns a persistent watch" hack: a dedicated supervisor process owns the shared
watch, so its lifecycle is independent of any one MCP client.

**Topology (current increment).** A long-lived `BuildHostDaemon` process (singleton via a
`rushmcp-daemon` LockFile) supervises one `rush start` + rush-serve watch (reused as the watch
engine), discovers its ephemeral port, and advertises it in `common/temp/rushmcp-build-host.json`.
MCP clients read that file and connect to the watch's WebSocket directly (reusing Phases 1–2). The
watch is reaped when the *daemon* exits (SubprocessTerminator), not when a client exits → it survives
and is shared across agents.

**Lifecycle.** Client need-a-host flow becomes: configured URL → discovery file → else start the
daemon (detached, un-reaped, persistent) and wait for discovery. Mutating commands: a client stops
the daemon (it knows `daemonPid`) to free the lock, runs the command, and the daemon restarts lazily
on the next build query. The daemon is stopped explicitly (a `rush_shutdown_host` tool) — it is NOT
reaped on client exit.

**Files:** `src/daemon/discoveryFile.ts` (read/write/validate; staleness = daemon pid dead),
`src/daemon/BuildHostDaemon.ts` (supervisor), `src/daemon/start.ts` (entrypoint).

**Increments:** 6a foundation ✅ · 6b client start-or-connect + shutdown tool · 6c daemon-mediated &
queued mutating commands + auto-restart supervision · 6d the real upstream `rush daemon` in rush-lib
that holds the repo lock once and runs install/update/check via the manager classes **in-process**
(no child `rush start`), per the action-vs-manager lock seam in §5.

**Known tensions:** with a shared watch, mutating commands are inherently stop-the-world for all
attached agents (one of them stops the daemon); 6c should queue/coordinate these. Persistence means
the daemon must be shut down explicitly or by staleness — orphan management moves into the daemon.
