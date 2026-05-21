# 6d — in-process `rush daemon` (working branch)

Branch: `nickpape/rush-daemon-phased-runner` (off `main`). Companion to the MCP build-host work on
`nickpape/mcp-build-host-tools` (see that branch's `rush-ipc-mcp-findings.md` §11/§12 for the full
design + why 6d must live in rush-lib).

## Baseline (validated before any changes)
- `rush build --only @microsoft/rush-lib` → green (cached).
- `libraries/rush-lib` Jest suite (`heft test`) → **627 passed, 0 failed (~25s)**. This is the
  refactor's safety net. NOTE: it barely covers the interactive watch loop — the real watch guardrail
  is a manual `rush start` regression.

## Why 6d lives in rush-lib (proven, not assumed)
A spike confirmed there is **no external in-process path** to the install managers: rush-lib ships as a
webpack bundle (internals aren't standalone-requirable), and rush-sdk/`RushInternals.loadModule` can't
load `logic/installManager/doBasicInstallAsync` from the repo's published Rush. So in-process
install/update/check must be a same-bundle call inside rush-lib — exactly how `InstallAction` already
calls `doBasicInstallAsync`.

## 6d-1 — extract `PhasedCommandRunner` from `PhasedScriptAction` ✅ DONE (validated)

Done in commit `4121bc9a96`. `PhasedScriptAction` 1196 → ~480 lines; engine moved to
`PhasedCommandRunner.ts`. Validated: rush-lib `heft test` 627/0 (== baseline); local `rush build` and
`rush start --watch` (initial build, watch loop, detected-change rebuild build+test) behave
identically. NOTE for the eventual PR: `@microsoft/rush-lib` is published, so it needs a `rush change`
changelog entry (skipped here — interactive).

### Original plan (kept for reference)
`PhasedScriptAction.ts` (1196 lines) → split into the **CLI action** (keeps the ~20 CommandLineParameter
fields + `runAsync` parameter parsing, build-cache/cobuild config, project selection, plugin
application, and the build of `ICreateOperationsContext`/`executionManagerOptions`) and a reusable
**`PhasedCommandRunner`** that owns the run engine.

Methods to move into the runner (they call each other, so move as a unit):
- `_runInitialPhasesAsync` (646) · `_runWatchPhasesAsync` (824) · `_registerWatchModeInterface` (725) ·
  `_executeOperationsAsync` (970) · `_doBeforeTask` (1172) · `_doAfterTask` (1186).

State the runner needs (constructor options): `hooks` (PhasedCommandHooks), `rushConfiguration`,
`terminal`, `sessionAbortController`, `watchPhases`, `watchDebounceMs`, `ipcEnabled` (resolved from
`--no-ipc`), and the initial `changedProjectsOnly`. Mutable run state moves into the runner:
`_executionAbortController` (set in initial/watch runs; read by the 'a' abort key) and
`_changedProjectsOnly` (toggled by the 'c' key; read when building the watch execute context).

Public surface to expose for the daemon: `runInitialPhasesAsync()`, `runWatchLoopAsync()`, and
`quiesceAsync()`/`resumeAsync()` (pause ProjectWatcher + cancel in-flight ops + run the `shutdownAsync`
hook) **without releasing the 'rush' lock**. `PhasedScriptAction` becomes a thin wrapper that builds the
runner and delegates; a new `rush daemon` action (6d-2) constructs the runner directly.

Guardrail for the no-op refactor: `heft test` stays 627/0 AND `rush build` / `rush start --watch`
behave identically (manual regression — the unit tests don't cover the watch path).

## After 6d-1
- 6d-2: add the `rush daemon` action (holds the lock, hosts the watch via the runner, rush-serve attached).
- 6d-3: control channel + in-process `install`/`update`/`check`/`add` via the managers, with
  `quiesce`/`resume` around them (no lock release). Validate the repeated-install-in-one-process risk.
- 6d-4: point the MCP at `rush daemon`.

## 6d-2 / 6d-3 — the daemon action + in-process commands (sharpened, code-grounded)

Findings from tracing the wiring (so the next build is turnkey):
- Phased commands are constructed in `cli/RushCommandLineParser.ts` (~line 489, `new PhasedScriptAction({...})`)
  from `commandLineConfiguration` entries; built-ins (`build`/`rebuild`) come from `DEFAULT_BUILD_COMMAND_JSON`
  in `api/CommandLineConfiguration.ts` (a bulk command translated to phased). A `daemon` built-in would be
  added the same way — but a bare always-watch `daemon` command is just `rush start` and adds nothing.
- The value is **in-process mutating commands under the one held lock**. `check` is read-only
  (safe-for-simultaneous) so it doesn't exercise the lock benefit; the compelling demo is in-process
  `install`/`update` *while watching*.

Design:
1. `RushDaemonAction extends PhasedScriptAction` (or PhasedScriptAction stores the runner on a
   `protected` field). The action needs a handle to the live `PhasedCommandRunner` to control it.
2. Add to `PhasedCommandRunner`: keep a reference to the active `ProjectWatcher`; add
   `quiesceAsync()` (pause the watcher, abort the in-flight execution via `_executionAbortController`,
   run the `shutdownAsync` hook to stop IPC workers) and `resumeAsync()` (resume the watcher). The
   watch loop blocks in `projectWatcher.waitForChangeAsync()`, so quiesce must interrupt that wait;
   `ProjectWatcher.pause()` already exists — confirm it unblocks the wait, else add an interrupt.
3. A control channel (unix domain socket at `common/temp/rushmcp-daemon.sock`, JSON-line protocol:
   `{command:'install'|'update'|'check'|'add'|'status', args}`). The daemon: on a mutating request →
   `quiesceAsync()` → `doBasicInstallAsync` / `PackageJsonUpdater.doRushUpdateAsync` /
   `VersionMismatchFinder.rushCheck` IN-PROCESS (no re-lock; the daemon already holds the 'rush' lock) →
   `resumeAsync()` → reply with the result. Serialize requests (a queue) so concurrent agents don't
   collide.
4. Register the action (built-in default command or via command-line config).
5. MCP (6d-4): point `BuildHostDaemon` at `rush daemon` and route mutating commands to the socket.

Validation gate (each step): rush-lib `heft test` 627/0 + local-rush regression
(`rush build`, `rush start --watch`, and — for 6d-3 — `rush daemon` + socket: in-process install while
watching, verify the watch resumes and the lock was never released). NOTE: `@microsoft/rush-lib` is
published → a real PR needs a `rush change` entry.
