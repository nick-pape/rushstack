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

## 6d-1 — extract `PhasedCommandRunner` from `PhasedScriptAction`
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
