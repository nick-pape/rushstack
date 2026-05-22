// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { AlreadyReportedError } from '@rushstack/node-core-library';
import { type ITerminal, Colorize } from '@rushstack/terminal';

import type { RushConfiguration } from '../../api/RushConfiguration';
import type {
  PhasedCommandHooks,
  ICreateOperationsContext,
  IExecuteOperationsContext
} from '../../pluginFramework/PhasedCommandHooks';
import { Stopwatch, StopwatchState } from '../../utilities/Stopwatch';
import {
  type IOperationExecutionManagerOptions,
  OperationExecutionManager
} from '../../logic/operations/OperationExecutionManager';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import type { IPhase } from '../../api/CommandLineConfiguration';
import type { Operation } from '../../logic/operations/Operation';
import type { OperationExecutionRecord } from '../../logic/operations/OperationExecutionRecord';
import { ProjectChangeAnalyzer } from '../../logic/ProjectChangeAnalyzer';
import { OperationStatus } from '../../logic/operations/OperationStatus';
import type {
  IExecutionResult,
  IOperationExecutionResult
} from '../../logic/operations/IOperationExecutionResult';
import type { ITelemetryData, ITelemetryOperationResult } from '../../logic/Telemetry';
import type { IInputsSnapshot, GetInputsSnapshotAsyncFn } from '../../logic/incremental/InputsSnapshot';
import type { ProjectWatcher } from '../../logic/ProjectWatcher';
import { Selection } from '../../logic/Selection';
import { measureAsyncFn, measureFn } from '../../utilities/performance';

const PERF_PREFIX: 'rush:phasedScriptAction' = 'rush:phasedScriptAction';

export interface IInitialRunPhasesOptions {
  executionManagerOptions: Omit<
    IOperationExecutionManagerOptions,
    'beforeExecuteOperations' | 'inputsSnapshot'
  >;
  initialCreateOperationsContext: ICreateOperationsContext;
  stopwatch: Stopwatch;
  terminal: ITerminal;
}

export interface IRunPhasesOptions extends IInitialRunPhasesOptions {
  getInputsSnapshotAsync: GetInputsSnapshotAsyncFn | undefined;
  initialSnapshot: IInputsSnapshot | undefined;
  executionManagerOptions: IOperationExecutionManagerOptions;
}

interface IExecuteOperationsOptions {
  executeOperationsContext: IExecuteOperationsContext;
  executionManagerOptions: IOperationExecutionManagerOptions;
  ignoreHooks: boolean;
  operations: Set<Operation>;
  stopwatch: Stopwatch;
  terminal: ITerminal;
}

interface IPhasedCommandTelemetry {
  [key: string]: string | number | boolean;
  isInitial: boolean;
  isWatch: boolean;

  countAll: number;
  countSuccess: number;
  countSuccessWithWarnings: number;
  countFailure: number;
  countBlocked: number;
  countFromCache: number;
  countSkipped: number;
  countNoOp: number;
}

/**
 * Options for the {@link PhasedCommandRunner}. The CLI action resolves all of these from its parsed
 * parameters and injects the CLI-specific glue (telemetry logging, telemetry extra-data, and the
 * post-task event-hook handler) as callbacks, so the runner itself is reusable outside the one-shot
 * CLI invocation lifecycle (e.g. by a long-lived `rush daemon`).
 */
export interface IPhasedCommandRunnerOptions {
  actionName: string;
  hooks: PhasedCommandHooks;
  rushConfiguration: RushConfiguration;
  terminal: ITerminal;
  isDebug: boolean;
  sessionAbortController: AbortController;
  watchPhases: ReadonlySet<IPhase>;
  watchDebounceMs: number;
  /** Whether the IPC feature is enabled (i.e. `--no-ipc` was not passed). */
  ipcEnabled: boolean;
  /** The initial value of changed-projects-only mode (toggleable at runtime in watch mode). */
  changedProjectsOnly: boolean;
  /**
   * The name under which to report changed-projects-only mode in telemetry, or `undefined` if the
   * parameter is not defined for this command.
   */
  changedProjectsOnlyParameterName: string | undefined;
  /** Returns the base extra-data map for telemetry (selection + parameter values). */
  getTelemetryExtraData: () => Record<string, string | number | boolean>;
  /** Logs (and flushes) a telemetry entry, or `undefined` if telemetry is disabled. */
  logTelemetry: ((entry: ITelemetryData) => void) | undefined;
  /** Invoked after an execution pass completes (unless hooks are ignored), e.g. to run event hooks. */
  onAfterExecuteTask: () => void;
}

/**
 * Runs the operation graph for a phased command: the initial execution pass and, optionally, the
 * watch-mode loop. Extracted from `PhasedScriptAction` so that the same engine can be hosted by a
 * long-lived process (the `rush daemon`) in addition to a one-shot CLI invocation.
 */
export class PhasedCommandRunner {
  private readonly _actionName: string;
  private readonly _hooks: PhasedCommandHooks;
  private readonly _rushConfiguration: RushConfiguration;
  private readonly _terminal: ITerminal;
  private readonly _isDebug: boolean;
  private readonly _sessionAbortController: AbortController;
  private readonly _watchPhases: ReadonlySet<IPhase>;
  private readonly _watchDebounceMs: number;
  private readonly _ipcEnabled: boolean;
  private readonly _changedProjectsOnlyParameterName: string | undefined;
  private readonly _getTelemetryExtraData: () => Record<string, string | number | boolean>;
  private readonly _logTelemetry: ((entry: ITelemetryData) => void) | undefined;
  private readonly _onAfterExecuteTask: () => void;

  private _changedProjectsOnly: boolean;
  private _executionAbortController: AbortController | undefined;
  private _activeProjectWatcher: ProjectWatcher | undefined;
  private _executingPromise: Promise<void> | undefined;

  public constructor(options: IPhasedCommandRunnerOptions) {
    this._actionName = options.actionName;
    this._hooks = options.hooks;
    this._rushConfiguration = options.rushConfiguration;
    this._terminal = options.terminal;
    this._isDebug = options.isDebug;
    this._sessionAbortController = options.sessionAbortController;
    this._watchPhases = options.watchPhases;
    this._watchDebounceMs = options.watchDebounceMs;
    this._ipcEnabled = options.ipcEnabled;
    this._changedProjectsOnlyParameterName = options.changedProjectsOnlyParameterName;
    this._getTelemetryExtraData = options.getTelemetryExtraData;
    this._logTelemetry = options.logTelemetry;
    this._onAfterExecuteTask = options.onAfterExecuteTask;

    this._changedProjectsOnly = options.changedProjectsOnly;
    this._executionAbortController = undefined;
    this._activeProjectWatcher = undefined;
    this._executingPromise = undefined;

    this._sessionAbortController.signal.addEventListener(
      'abort',
      () => {
        this._executionAbortController?.abort();
      },
      { once: true }
    );
  }

  public async runInitialPhasesAsync(options: IInitialRunPhasesOptions): Promise<IRunPhasesOptions> {
    const {
      initialCreateOperationsContext,
      executionManagerOptions: partialExecutionManagerOptions,
      stopwatch,
      terminal
    } = options;

    const { projectConfigurations } = initialCreateOperationsContext;
    const { projectSelection } = initialCreateOperationsContext;

    const operations: Set<Operation> = await measureAsyncFn(`${PERF_PREFIX}:createOperations`, () =>
      this._hooks.createOperations.promise(new Set(), initialCreateOperationsContext)
    );

    const [getInputsSnapshotAsync, initialSnapshot] = await measureAsyncFn(
      `${PERF_PREFIX}:analyzeRepoState`,
      async () => {
        terminal.write('Analyzing repo state... ');
        const repoStateStopwatch: Stopwatch = new Stopwatch();
        repoStateStopwatch.start();

        const analyzer: ProjectChangeAnalyzer = new ProjectChangeAnalyzer(this._rushConfiguration);
        const innerGetInputsSnapshotAsync: GetInputsSnapshotAsyncFn | undefined =
          await analyzer._tryGetSnapshotProviderAsync(
            projectConfigurations,
            terminal,
            // We need to include all dependencies, otherwise build cache id calculation will be incorrect
            Selection.expandAllDependencies(projectSelection)
          );
        const innerInitialSnapshot: IInputsSnapshot | undefined = innerGetInputsSnapshotAsync
          ? await innerGetInputsSnapshotAsync()
          : undefined;

        repoStateStopwatch.stop();
        terminal.writeLine(`DONE (${repoStateStopwatch.toString()})`);
        terminal.writeLine();
        return [innerGetInputsSnapshotAsync, innerInitialSnapshot];
      }
    );

    const abortController: AbortController = (this._executionAbortController = new AbortController());
    const initialExecuteOperationsContext: IExecuteOperationsContext = {
      ...initialCreateOperationsContext,
      inputsSnapshot: initialSnapshot,
      abortController
    };

    const executionManagerOptions: IOperationExecutionManagerOptions = {
      ...partialExecutionManagerOptions,
      inputsSnapshot: initialSnapshot,
      beforeExecuteOperationsAsync: async (records: Map<Operation, OperationExecutionRecord>) => {
        await measureAsyncFn(`${PERF_PREFIX}:beforeExecuteOperations`, () =>
          this._hooks.beforeExecuteOperations.promise(records, initialExecuteOperationsContext)
        );
      }
    };

    const initialOptions: IExecuteOperationsOptions = {
      executeOperationsContext: initialExecuteOperationsContext,
      ignoreHooks: false,
      operations,
      stopwatch,
      executionManagerOptions,
      terminal
    };

    await measureAsyncFn(`${PERF_PREFIX}:executeOperations`, () =>
      this._executeOperationsAsync(initialOptions)
    );

    return {
      ...options,
      executionManagerOptions,
      getInputsSnapshotAsync,
      initialSnapshot
    };
  }

  private _registerWatchModeInterface(projectWatcher: ProjectWatcher): void {
    const buildOnceKey: 'b' = 'b';
    const changedProjectsOnlyKey: 'c' = 'c';
    const invalidateKey: 'i' = 'i';
    const quitKey: 'q' = 'q';
    const abortKey: 'a' = 'a';
    const toggleWatcherKey: 'w' = 'w';
    const shutdownProcessesKey: 'x' = 'x';

    const terminal: ITerminal = this._terminal;

    projectWatcher.setPromptGenerator((isPaused: boolean) => {
      const promptLines: string[] = [
        `  Press <${quitKey}> to gracefully exit.`,
        `  Press <${abortKey}> to abort queued operations. Any that have started will finish.`,
        `  Press <${toggleWatcherKey}> to ${isPaused ? 'resume' : 'pause'}.`,
        `  Press <${invalidateKey}> to invalidate all projects.`,
        `  Press <${changedProjectsOnlyKey}> to ${
          this._changedProjectsOnly ? 'disable' : 'enable'
        } changed-projects-only mode (${this._changedProjectsOnly ? 'ENABLED' : 'DISABLED'}).`
      ];
      if (isPaused) {
        promptLines.push(`  Press <${buildOnceKey}> to build once.`);
      }
      if (this._ipcEnabled) {
        promptLines.push(`  Press <${shutdownProcessesKey}> to reset child processes.`);
      }
      return promptLines;
    });

    const onKeyPress = (key: string): void => {
      switch (key) {
        case quitKey:
          terminal.writeLine(`Exiting watch mode and aborting any scheduled work...`);
          process.stdin.setRawMode(false);
          process.stdin.off('data', onKeyPress);
          process.stdin.unref();
          this._sessionAbortController.abort();
          break;
        case abortKey:
          terminal.writeLine(`Aborting current iteration...`);
          this._executionAbortController?.abort();
          break;
        case toggleWatcherKey:
          if (projectWatcher.isPaused) {
            projectWatcher.resume();
          } else {
            projectWatcher.pause();
          }
          break;
        case buildOnceKey:
          if (projectWatcher.isPaused) {
            projectWatcher.clearStatus();
            terminal.writeLine(`Building once...`);
            projectWatcher.resume();
            projectWatcher.pause();
          }
          break;
        case invalidateKey:
          projectWatcher.clearStatus();
          terminal.writeLine(`Invalidating all operations...`);
          projectWatcher.invalidateAll('manual trigger');
          if (!projectWatcher.isPaused) {
            projectWatcher.resume();
          }
          break;
        case changedProjectsOnlyKey:
          this._changedProjectsOnly = !this._changedProjectsOnly;
          projectWatcher.rerenderStatus();
          break;
        case shutdownProcessesKey:
          projectWatcher.clearStatus();
          terminal.writeLine(`Shutting down long-lived child processes...`);
          // TODO: Inject this promise into the execution queue somewhere so that it gets waited on between runs
          void this._hooks.shutdownAsync.promise();
          break;
        case '':
          process.stdin.setRawMode(false);
          process.stdin.off('data', onKeyPress);
          process.stdin.unref();
          this._sessionAbortController.abort();
          process.kill(process.pid, 'SIGINT');
          break;
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onKeyPress);
  }

  /**
   * Runs the command in watch mode. Fundamentally is a simple loop:
   * 1) Wait for a change to one or more projects in the selection
   * 2) Invoke the command on the changed projects, and, if applicable, impacted projects
   *    Uses the same algorithm as --impacted-by
   * 3) Goto (1)
   */
  public async runWatchPhasesAsync(options: IRunPhasesOptions): Promise<void> {
    const {
      getInputsSnapshotAsync,
      initialSnapshot,
      initialCreateOperationsContext,
      executionManagerOptions,
      stopwatch,
      terminal
    } = options;

    const phaseOriginal: Set<IPhase> = new Set(this._watchPhases);
    const phaseSelection: Set<IPhase> = new Set(this._watchPhases);

    const { projectSelection: projectsToWatch } = initialCreateOperationsContext;

    if (!getInputsSnapshotAsync || !initialSnapshot) {
      terminal.writeErrorLine(
        `Cannot watch for changes if the Rush repo is not in a Git repository, exiting.`
      );
      throw new AlreadyReportedError();
    }

    // Use async import so that we don't pay the cost for sync builds
    const { ProjectWatcher } = await import(
      /* webpackChunkName: 'ProjectWatcher' */
      '../../logic/ProjectWatcher'
    );

    const sessionAbortController: AbortController = this._sessionAbortController;
    const abortSignal: AbortSignal = sessionAbortController.signal;

    const projectWatcher: typeof ProjectWatcher.prototype = new ProjectWatcher({
      getInputsSnapshotAsync,
      initialSnapshot,
      debounceMs: this._watchDebounceMs,
      rushConfiguration: this._rushConfiguration,
      projectsToWatch,
      abortSignal,
      terminal
    });
    this._activeProjectWatcher = projectWatcher;

    // Ensure process.stdin allows interactivity before using TTY-only APIs
    if (process.stdin.isTTY) {
      this._registerWatchModeInterface(projectWatcher);
    }

    const onWaitingForChanges = (): void => {
      // Allow plugins to display their own messages when waiting for changes.
      this._hooks.waitingForChanges.call();

      // Report so that the developer can always see that it is in watch mode as the latest console line.
      terminal.writeLine(
        `Watching for changes to ${projectsToWatch.size} ${
          projectsToWatch.size === 1 ? 'project' : 'projects'
        }. Press Ctrl+C to exit.`
      );
    };

    function invalidateOperation(operation: Operation, reason: string): void {
      const { associatedProject } = operation;
      // Since ProjectWatcher only tracks entire projects, widen the operation to its project
      // Revisit when migrating to @rushstack/operation-graph and we have a long-lived operation graph
      projectWatcher.invalidateProject(associatedProject, `${operation.name!} (${reason})`);
    }

    // Loop until Ctrl+C
    while (!abortSignal.aborted) {
      // On the initial invocation, this promise will return immediately with the full set of projects
      const { changedProjects, inputsSnapshot: state } = await measureAsyncFn(
        `${PERF_PREFIX}:waitForChanges`,
        () => projectWatcher.waitForChangeAsync(onWaitingForChanges)
      );

      if (abortSignal.aborted) {
        return;
      }

      if (stopwatch.state === StopwatchState.Stopped) {
        // Clear and reset the stopwatch so that we only report time from a single execution at a time
        stopwatch.reset();
        stopwatch.start();
      }

      terminal.writeLine(
        `Detected changes in ${changedProjects.size} project${changedProjects.size === 1 ? '' : 's'}:`
      );
      const names: string[] = [...changedProjects].map((x: RushConfigurationProject) => x.packageName).sort();
      for (const name of names) {
        terminal.writeLine(`    ${Colorize.cyan(name)}`);
      }

      const initialAbortController: AbortController = (this._executionAbortController =
        new AbortController());

      // Account for consumer relationships
      const executeOperationsContext: IExecuteOperationsContext = {
        ...initialCreateOperationsContext,
        abortController: initialAbortController,
        changedProjectsOnly: !!this._changedProjectsOnly,
        isInitial: false,
        inputsSnapshot: state,
        projectsInUnknownState: changedProjects,
        phaseOriginal,
        phaseSelection,
        invalidateOperation
      };

      const operations: Set<Operation> = await measureAsyncFn(`${PERF_PREFIX}:createOperations`, () =>
        this._hooks.createOperations.promise(new Set(), executeOperationsContext)
      );

      const executeOptions: IExecuteOperationsOptions = {
        executeOperationsContext,
        // For now, don't run pre-build or post-build in watch mode
        ignoreHooks: true,
        operations,
        stopwatch,
        executionManagerOptions: {
          ...executionManagerOptions,
          inputsSnapshot: state,
          beforeExecuteOperationsAsync: async (records: Map<Operation, OperationExecutionRecord>) => {
            await measureAsyncFn(`${PERF_PREFIX}:beforeExecuteOperations`, () =>
              this._hooks.beforeExecuteOperations.promise(records, executeOperationsContext)
            );
          }
        },
        terminal
      };

      const iterationPromise: Promise<void> = measureAsyncFn(`${PERF_PREFIX}:executeOperations`, () =>
        this._executeOperationsAsync(executeOptions)
      );
      this._executingPromise = iterationPromise;
      try {
        // Delegate to the underlying command, for only the projects that need reprocessing
        await iterationPromise;
      } catch (err) {
        // In watch mode, we want to rebuild even if the original build failed.
        if (!(err instanceof AlreadyReportedError)) {
          throw err;
        }
      } finally {
        this._executingPromise = undefined;
      }
    }

    this._activeProjectWatcher = undefined;
  }

  /**
   * Runs `fn` exclusively against the watch: pauses the watcher, aborts and awaits any in-flight
   * execution, stops long-lived child build processes (the `shutdownAsync` hook), runs `fn` (e.g. an
   * in-process install) while the repository lock is still held, then resumes the watch. Safe to call
   * when no watch is active (`fn` simply runs).
   */
  public async runExclusiveAsync(fn: () => Promise<void>): Promise<void> {
    const watcher: ProjectWatcher | undefined = this._activeProjectWatcher;
    watcher?.pause();
    // Stop any in-flight build before mutating node_modules, and wait for it to fully unwind.
    this._executionAbortController?.abort();
    if (this._executingPromise) {
      try {
        await this._executingPromise;
      } catch {
        // The in-flight execution was aborted; ignore.
      }
    }
    // Child build processes may hold stale module resolutions once node_modules changes.
    await this._hooks.shutdownAsync.promise();
    try {
      await fn();
    } finally {
      watcher?.resume();
    }
  }

  /**
   * Runs a set of operations and reports the results.
   */
  private async _executeOperationsAsync(options: IExecuteOperationsOptions): Promise<void> {
    const {
      executeOperationsContext,
      executionManagerOptions,
      ignoreHooks,
      operations,
      stopwatch,
      terminal
    } = options;

    const executionManager: OperationExecutionManager = new OperationExecutionManager(
      operations,
      executionManagerOptions
    );

    const { isInitial, isWatch, abortController, invalidateOperation } = executeOperationsContext;

    let success: boolean = false;
    let result: IExecutionResult | undefined;

    try {
      const definiteResult: IExecutionResult = await measureAsyncFn(
        `${PERF_PREFIX}:executeOperationsInner`,
        () => executionManager.executeAsync(abortController)
      );
      success = definiteResult.status === OperationStatus.Success;
      result = definiteResult;

      await measureAsyncFn(`${PERF_PREFIX}:afterExecuteOperations`, () =>
        this._hooks.afterExecuteOperations.promise(definiteResult, executeOperationsContext)
      );

      stopwatch.stop();

      const message: string = `rush ${this._actionName} (${stopwatch.toString()})`;
      if (result.status === OperationStatus.Success) {
        terminal.writeLine(Colorize.green(message));
      } else {
        terminal.writeLine(message);
      }
    } catch (error) {
      success = false;
      stopwatch.stop();

      if (error instanceof AlreadyReportedError) {
        terminal.writeLine(`rush ${this._actionName} (${stopwatch.toString()})`);
      } else {
        if (error && (error as Error).message) {
          if (this._isDebug) {
            terminal.writeErrorLine('Error: ' + (error as Error).stack);
          } else {
            terminal.writeErrorLine('Error: ' + (error as Error).message);
          }
        }

        terminal.writeErrorLine(Colorize.red(`rush ${this._actionName} - Errors! (${stopwatch.toString()})`));
      }
    }

    this._executionAbortController = undefined;

    if (invalidateOperation) {
      const operationResults: ReadonlyMap<Operation, IOperationExecutionResult> | undefined =
        result?.operationResults;
      if (operationResults) {
        for (const [operation, { status }] of operationResults) {
          if (status === OperationStatus.Aborted) {
            invalidateOperation(operation, 'aborted');
          }
        }
      }
    }

    if (!ignoreHooks) {
      measureFn(`${PERF_PREFIX}:doAfterTask`, () => this._onAfterExecuteTask());
    }

    if (this._logTelemetry) {
      const logTelemetry: (entry: ITelemetryData) => void = this._logTelemetry;
      const logEntry: ITelemetryData = measureFn(`${PERF_PREFIX}:prepareTelemetry`, () => {
        const jsonOperationResults: Record<string, ITelemetryOperationResult> = {};

        const extraData: IPhasedCommandTelemetry = {
          // Fields preserved across the command invocation
          ...this._getTelemetryExtraData(),
          isWatch,
          // Fields specific to the current operation set
          isInitial,

          countAll: 0,
          countSuccess: 0,
          countSuccessWithWarnings: 0,
          countFailure: 0,
          countBlocked: 0,
          countFromCache: 0,
          countSkipped: 0,
          countNoOp: 0
        };

        if (this._changedProjectsOnlyParameterName) {
          // Overwrite this value since we allow changing it at runtime.
          extraData[this._changedProjectsOnlyParameterName] = this._changedProjectsOnly;
        }

        if (result) {
          const { operationResults } = result;

          const nonSilentDependenciesByOperation: Map<Operation, Set<string>> = new Map();
          function getNonSilentDependencies(operation: Operation): ReadonlySet<string> {
            let realDependencies: Set<string> | undefined = nonSilentDependenciesByOperation.get(operation);
            if (!realDependencies) {
              realDependencies = new Set();
              nonSilentDependenciesByOperation.set(operation, realDependencies);
              for (const dependency of operation.dependencies) {
                const dependencyRecord: IOperationExecutionResult | undefined =
                  operationResults.get(dependency);
                if (dependencyRecord?.silent) {
                  for (const deepDependency of getNonSilentDependencies(dependency)) {
                    realDependencies.add(deepDependency);
                  }
                } else {
                  realDependencies.add(dependency.name!);
                }
              }
            }
            return realDependencies;
          }

          for (const [operation, operationResult] of operationResults) {
            if (operationResult.silent) {
              // Architectural operation. Ignore.
              continue;
            }

            const { _operationMetadataManager: operationMetadataManager } =
              operationResult as OperationExecutionRecord;

            const { startTime, endTime } = operationResult.stopwatch;
            jsonOperationResults[operation.name!] = {
              startTimestampMs: startTime,
              endTimestampMs: endTime,
              nonCachedDurationMs: operationResult.nonCachedDurationMs,
              wasExecutedOnThisMachine: operationMetadataManager?.wasCobuilt !== true,
              result: operationResult.status,
              dependencies: Array.from(getNonSilentDependencies(operation)).sort()
            };

            extraData.countAll++;
            switch (operationResult.status) {
              case OperationStatus.Success:
                extraData.countSuccess++;
                break;
              case OperationStatus.SuccessWithWarning:
                extraData.countSuccessWithWarnings++;
                break;
              case OperationStatus.Failure:
                extraData.countFailure++;
                break;
              case OperationStatus.Blocked:
                extraData.countBlocked++;
                break;
              case OperationStatus.FromCache:
                extraData.countFromCache++;
                break;
              case OperationStatus.Skipped:
                extraData.countSkipped++;
                break;
              case OperationStatus.NoOp:
                extraData.countNoOp++;
                break;
              default:
                // Do nothing.
                break;
            }
          }
        }

        const innerLogEntry: ITelemetryData = {
          name: this._actionName,
          durationInSeconds: stopwatch.duration,
          result: success ? 'Succeeded' : 'Failed',
          extraData,
          operationResults: jsonOperationResults
        };

        return innerLogEntry;
      });

      measureFn(`${PERF_PREFIX}:beforeLog`, () => this._hooks.beforeLog.call(logEntry));

      logTelemetry(logEntry);
    }

    if (!success && !isWatch) {
      throw new AlreadyReportedError();
    }
  }
}
