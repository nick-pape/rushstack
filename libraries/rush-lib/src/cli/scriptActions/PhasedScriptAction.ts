// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { AsyncSeriesHook } from 'tapable';

import { type ITerminal, Terminal, Colorize } from '@rushstack/terminal';
import type {
  CommandLineFlagParameter,
  CommandLineParameter,
  CommandLineStringParameter
} from '@rushstack/ts-command-line';

import type { Subspace } from '../../api/Subspace';
import type { IPhasedCommand } from '../../pluginFramework/RushLifeCycle';
import { PhasedCommandHooks, type ICreateOperationsContext } from '../../pluginFramework/PhasedCommandHooks';
import { SetupChecks } from '../../logic/SetupChecks';
import { Stopwatch } from '../../utilities/Stopwatch';
import { BaseScriptAction, type IBaseScriptActionOptions } from './BaseScriptAction';
import {
  PhasedCommandRunner,
  type IInitialRunPhasesOptions,
  type IRunPhasesOptions
} from './PhasedCommandRunner';
import type { DaemonControlServer } from './DaemonControlServer';
import type { IOperationExecutionManagerOptions } from '../../logic/operations/OperationExecutionManager';
import { RushConstants } from '../../logic/RushConstants';
import { EnvironmentVariableNames } from '../../api/EnvironmentConfiguration';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { BuildCacheConfiguration } from '../../api/BuildCacheConfiguration';
import { SelectionParameterSet } from '../parsing/SelectionParameterSet';
import type { IPhase, IPhasedCommandConfig } from '../../api/CommandLineConfiguration';
import type { OperationExecutionRecord } from '../../logic/operations/OperationExecutionRecord';
import { associateParametersByPhase } from '../parsing/associateParametersByPhase';
import { PhasedOperationPlugin } from '../../logic/operations/PhasedOperationPlugin';
import { ShellOperationRunnerPlugin } from '../../logic/operations/ShellOperationRunnerPlugin';
import { Event } from '../../api/EventHooks';
import { OperationResultSummarizerPlugin } from '../../logic/operations/OperationResultSummarizerPlugin';
import type { ITelemetryData } from '../../logic/Telemetry';
import { parseParallelism } from '../parsing/ParseParallelism';
import { CobuildConfiguration } from '../../api/CobuildConfiguration';
import { CacheableOperationPlugin } from '../../logic/operations/CacheableOperationPlugin';
import { RushProjectConfiguration } from '../../api/RushProjectConfiguration';
import { LegacySkipPlugin } from '../../logic/operations/LegacySkipPlugin';
import { ValidateOperationsPlugin } from '../../logic/operations/ValidateOperationsPlugin';
import { ShardedPhasedOperationPlugin } from '../../logic/operations/ShardedPhaseOperationPlugin';
import { FlagFile } from '../../api/FlagFile';
import { WeightedOperationPlugin } from '../../logic/operations/WeightedOperationPlugin';
import { getVariantAsync, VARIANT_PARAMETER } from '../../api/Variants';
import { Selection } from '../../logic/Selection';
import { NodeDiagnosticDirPlugin } from '../../logic/operations/NodeDiagnosticDirPlugin';
import { IgnoredParametersPlugin } from '../../logic/operations/IgnoredParametersPlugin';
import { DebugHashesPlugin } from '../../logic/operations/DebugHashesPlugin';
import { measureAsyncFn, measureFn } from '../../utilities/performance';

const PERF_PREFIX: 'rush:phasedScriptAction' = 'rush:phasedScriptAction';

/**
 * Constructor parameters for PhasedScriptAction.
 */
export interface IPhasedScriptActionOptions extends IBaseScriptActionOptions<IPhasedCommandConfig> {
  enableParallelism: boolean;
  allowOversubscription: boolean;
  incremental: boolean;
  disableBuildCache: boolean;

  originalPhases: Set<IPhase>;
  initialPhases: Set<IPhase>;
  watchPhases: Set<IPhase>;
  phases: Map<string, IPhase>;

  alwaysWatch: boolean;
  alwaysInstall: boolean | undefined;

  watchDebounceMs: number | undefined;
}

/**
 * This class implements phased commands which are run individually for each project in the repo,
 * possibly in parallel, and which may define multiple phases.
 *
 * @remarks
 * Phased commands can be defined via common/config/command-line.json.  Rush's predefined "build"
 * and "rebuild" commands are also modeled as phased commands with a single phase that invokes the npm
 * "build" script for each project.
 */
export class PhasedScriptAction extends BaseScriptAction<IPhasedCommandConfig> implements IPhasedCommand {
  /**
   * @internal
   */
  public _runsBeforeInstall: boolean | undefined;
  public readonly hooks: PhasedCommandHooks;
  public readonly sessionAbortController: AbortController;

  private readonly _enableParallelism: boolean;
  private readonly _allowOversubscription: boolean;
  private readonly _isIncrementalBuildAllowed: boolean;
  private readonly _disableBuildCache: boolean;
  private readonly _originalPhases: ReadonlySet<IPhase>;
  private readonly _initialPhases: ReadonlySet<IPhase>;
  private readonly _watchPhases: ReadonlySet<IPhase>;
  private readonly _watchDebounceMs: number;
  private readonly _alwaysWatch: boolean;
  private readonly _alwaysInstall: boolean | undefined;
  private readonly _knownPhases: ReadonlyMap<string, IPhase>;
  private readonly _terminal: ITerminal;

  private readonly _changedProjectsOnlyParameter: CommandLineFlagParameter | undefined;
  private readonly _selectionParameters: SelectionParameterSet;
  private readonly _verboseParameter: CommandLineFlagParameter;
  private readonly _parallelismParameter: CommandLineStringParameter | undefined;
  private readonly _ignoreHooksParameter: CommandLineFlagParameter;
  private readonly _watchParameter: CommandLineFlagParameter | undefined;
  private readonly _timelineParameter: CommandLineFlagParameter | undefined;
  private readonly _cobuildPlanParameter: CommandLineFlagParameter | undefined;
  private readonly _installParameter: CommandLineFlagParameter | undefined;
  private readonly _variantParameter: CommandLineStringParameter | undefined;
  private readonly _noIPCParameter: CommandLineFlagParameter | undefined;
  private readonly _nodeDiagnosticDirParameter: CommandLineStringParameter;
  private readonly _debugBuildCacheIdsParameter: CommandLineFlagParameter;
  private readonly _includePhaseDeps: CommandLineFlagParameter | undefined;

  public constructor(options: IPhasedScriptActionOptions) {
    super(options);
    const {
      enableParallelism,
      allowOversubscription,
      incremental,
      disableBuildCache,
      originalPhases,
      initialPhases,
      watchPhases,
      watchDebounceMs = RushConstants.defaultWatchDebounceMs,
      alwaysWatch,
      alwaysInstall,
      phases
    } = options;
    this._enableParallelism = enableParallelism;
    this._allowOversubscription = allowOversubscription;
    this._isIncrementalBuildAllowed = incremental;
    this._disableBuildCache = disableBuildCache;
    this._originalPhases = originalPhases;
    this._initialPhases = initialPhases;
    this._watchPhases = watchPhases;
    this._watchDebounceMs = watchDebounceMs;
    this._alwaysWatch = alwaysWatch;
    this._alwaysInstall = alwaysInstall;
    this._runsBeforeInstall = false;
    this._knownPhases = phases;
    this.sessionAbortController = new AbortController();

    this.hooks = new PhasedCommandHooks();

    this._terminal = new Terminal(this.rushSession.terminalProvider);

    this._parallelismParameter = this._enableParallelism
      ? this.defineStringParameter({
          parameterLongName: '--parallelism',
          parameterShortName: '-p',
          argumentName: 'COUNT',
          environmentVariable: EnvironmentVariableNames.RUSH_PARALLELISM,
          description:
            'Specifies the maximum number of concurrent processes to launch during a build.' +
            ' The COUNT should be a positive integer, a percentage value (eg. "50%") or the word "max"' +
            ' to specify a count that is equal to the number of CPU cores. If this parameter is omitted,' +
            ' then the default value depends on the operating system and number of CPU cores.'
        })
      : undefined;

    this._timelineParameter = this.defineFlagParameter({
      parameterLongName: '--timeline',
      description:
        'After the build is complete, print additional statistics and CPU usage information,' +
        ' including an ASCII chart of the start and stop times for each operation.'
    });
    this._cobuildPlanParameter = this.defineFlagParameter({
      parameterLongName: '--log-cobuild-plan',
      description:
        '(EXPERIMENTAL) Before the build starts, log information about the cobuild state. This will include information about ' +
        'clusters and the projects that are part of each cluster.'
    });

    this._selectionParameters = new SelectionParameterSet(this.rushConfiguration, this, {
      gitOptions: {
        // Include lockfile processing since this expands the selection, and we need to select
        // at least the same projects selected with the same query to "rush build"
        includeExternalDependencies: true,
        // Enable filtering to reduce evaluation cost
        enableFiltering: true
      },
      includeSubspaceSelector: false,
      cwd: this.parser.cwd
    });

    this._verboseParameter = this.defineFlagParameter({
      parameterLongName: '--verbose',
      parameterShortName: '-v',
      description: 'Display the logs during the build, rather than just displaying the build status summary'
    });

    this._includePhaseDeps = this.defineFlagParameter({
      parameterLongName: '--include-phase-deps',
      description:
        'If the selected projects are "unsafe" (missing some dependencies), add the minimal set of phase dependencies. For example, ' +
        `"--from A" normally might include the "_phase:test" phase for A's dependencies, even though changes to A can't break those tests. ` +
        `Using "--impacted-by A --include-phase-deps" avoids that work by performing "_phase:test" only for downstream projects.`
    });

    this._changedProjectsOnlyParameter = this._isIncrementalBuildAllowed
      ? this.defineFlagParameter({
          parameterLongName: '--changed-projects-only',
          parameterShortName: '-c',
          description:
            'Normally the incremental build logic will rebuild changed projects as well as' +
            ' any projects that directly or indirectly depend on a changed project. Specify "--changed-projects-only"' +
            ' to ignore dependent projects, only rebuilding those projects whose files were changed.' +
            ' Note that this parameter is "unsafe"; it is up to the developer to ensure that the ignored projects' +
            ' are okay to ignore.'
        })
      : undefined;

    this._ignoreHooksParameter = this.defineFlagParameter({
      parameterLongName: '--ignore-hooks',
      description:
        `Skips execution of the "eventHooks" scripts defined in ${RushConstants.rushJsonFilename}. ` +
        'Make sure you know what you are skipping.'
    });

    // Only define the parameter if it has an effect.
    this._watchParameter =
      this._watchPhases.size > 0 && !this._alwaysWatch
        ? this.defineFlagParameter({
            parameterLongName: '--watch',
            description: `Starts a file watcher after initial execution finishes. Will run the following phases on affected projects: ${Array.from(
              this._watchPhases,
              (phase: IPhase) => phase.name
            ).join(', ')}`
          })
        : undefined;

    // If `this._alwaysInstall === undefined`, Rush does not define the parameter
    // but a repository may still define a custom parameter with the same name.
    this._installParameter =
      this._alwaysInstall === false
        ? this.defineFlagParameter({
            parameterLongName: '--install',
            description:
              'Normally a phased command expects "rush install" to have been manually run first. If this flag is specified, ' +
              'Rush will automatically perform an install before processing the current command.'
          })
        : undefined;

    this._variantParameter =
      this._alwaysInstall !== undefined ? this.defineStringParameter(VARIANT_PARAMETER) : undefined;

    const isIpcSupported: boolean =
      this._watchPhases.size > 0 &&
      !!this.rushConfiguration.experimentsConfiguration.configuration.useIPCScriptsInWatchMode;
    this._noIPCParameter = isIpcSupported
      ? this.defineFlagParameter({
          parameterLongName: '--no-ipc',
          description:
            'Disables the IPC feature for the current command (if applicable to selected operations). Operations will not look for a ":ipc" suffixed script.' +
            'This feature only applies in watch mode and is enabled by default.'
        })
      : undefined;

    this._nodeDiagnosticDirParameter = this.defineStringParameter({
      parameterLongName: '--node-diagnostic-dir',
      argumentName: 'DIRECTORY',
      description:
        'Specifies the directory where Node.js diagnostic reports will be written. ' +
        'This directory will contain a subdirectory for each project and phase.'
    });

    this._debugBuildCacheIdsParameter = this.defineFlagParameter({
      parameterLongName: '--debug-build-cache-ids',
      description:
        'Logs information about the components of the build cache ids for individual operations. This is useful for debugging the incremental build logic.'
    });

    this.defineScriptParameters();

    // Associate parameters with their respective phases
    associateParametersByPhase(this.customParameters, this._knownPhases);
  }

  public async runAsync(): Promise<void> {
    const stopwatch: Stopwatch = Stopwatch.start();

    if (this._alwaysInstall || this._installParameter?.value) {
      await measureAsyncFn(`${PERF_PREFIX}:install`, async () => {
        const { doBasicInstallAsync } = await import(
          /* webpackChunkName: 'doBasicInstallAsync' */
          '../../logic/installManager/doBasicInstallAsync'
        );

        const variant: string | undefined = await getVariantAsync(
          this._variantParameter,
          this.rushConfiguration,
          true
        );
        await doBasicInstallAsync({
          terminal: this._terminal,
          rushConfiguration: this.rushConfiguration,
          rushGlobalFolder: this.rushGlobalFolder,
          isDebug: this.parser.isDebug,
          variant,
          beforeInstallAsync: (subspace: Subspace) =>
            this.rushSession.hooks.beforeInstall.promise(this, subspace, variant),
          afterInstallAsync: (subspace: Subspace) =>
            this.rushSession.hooks.afterInstall.promise(this, subspace, variant),
          // Eventually we may want to allow a subspace to be selected here
          subspace: this.rushConfiguration.defaultSubspace
        });
      });
    }

    if (!this._runsBeforeInstall) {
      await measureAsyncFn(`${PERF_PREFIX}:checkInstallFlag`, async () => {
        // TODO: Replace with last-install.flag when "rush link" and "rush unlink" are removed
        const lastLinkFlag: FlagFile = new FlagFile(
          this.rushConfiguration.defaultSubspace.getSubspaceTempFolderPath(),
          RushConstants.lastLinkFlagFilename,
          {}
        );
        // Only check for a valid link flag when subspaces is not enabled
        if (!(await lastLinkFlag.isValidAsync()) && !this.rushConfiguration.subspacesFeatureEnabled) {
          const useWorkspaces: boolean =
            this.rushConfiguration.pnpmOptions && this.rushConfiguration.pnpmOptions.useWorkspaces;
          if (useWorkspaces) {
            throw new Error('Link flag invalid.\nDid you run "rush install" or "rush update"?');
          } else {
            throw new Error('Link flag invalid.\nDid you run "rush link"?');
          }
        }
      });
    }

    measureFn(`${PERF_PREFIX}:doBeforeTask`, () => this._doBeforeTask());

    const hooks: PhasedCommandHooks = this.hooks;
    const terminal: ITerminal = this._terminal;

    // if this is parallelizable, then use the value from the flag (undefined or a number),
    // if parallelism is not enabled, then restrict to 1 core
    const parallelism: number = this._enableParallelism
      ? parseParallelism(this._parallelismParameter?.value)
      : 1;

    const includePhaseDeps: boolean = this._includePhaseDeps?.value ?? false;

    await measureAsyncFn(`${PERF_PREFIX}:applyStandardPlugins`, async () => {
      // Generates the default operation graph
      new PhasedOperationPlugin().apply(hooks);
      // Splices in sharded phases to the operation graph.
      new ShardedPhasedOperationPlugin().apply(hooks);
      // Applies the Shell Operation Runner to selected operations
      new ShellOperationRunnerPlugin().apply(hooks);

      new WeightedOperationPlugin().apply(hooks);
      new ValidateOperationsPlugin(terminal).apply(hooks);

      // Forward ignored parameters to child processes as an environment variable
      new IgnoredParametersPlugin().apply(hooks);

      const showTimeline: boolean = this._timelineParameter?.value ?? false;
      if (showTimeline) {
        const { ConsoleTimelinePlugin } = await import(
          /* webpackChunkName: 'ConsoleTimelinePlugin' */
          '../../logic/operations/ConsoleTimelinePlugin'
        );
        new ConsoleTimelinePlugin(terminal).apply(this.hooks);
      }

      const diagnosticDir: string | undefined = this._nodeDiagnosticDirParameter.value;
      if (diagnosticDir) {
        new NodeDiagnosticDirPlugin({
          diagnosticDir
        }).apply(this.hooks);
      }

      // Enable the standard summary
      new OperationResultSummarizerPlugin(terminal).apply(this.hooks);
    });

    const { hooks: sessionHooks } = this.rushSession;
    if (sessionHooks.runAnyPhasedCommand.isUsed()) {
      await measureAsyncFn(`${PERF_PREFIX}:runAnyPhasedCommand`, async () => {
        // Avoid the cost of compiling the hook if it wasn't tapped.
        await sessionHooks.runAnyPhasedCommand.promise(this);
      });
    }

    const hookForAction: AsyncSeriesHook<IPhasedCommand> | undefined = sessionHooks.runPhasedCommand.get(
      this.actionName
    );

    if (hookForAction) {
      await measureAsyncFn(`${PERF_PREFIX}:runPhasedCommand`, async () => {
        // Run the more specific hook for a command with this name after the general hook
        await hookForAction.promise(this);
      });
    }

    const isQuietMode: boolean = !this._verboseParameter.value;

    const changedProjectsOnly: boolean = !!this._changedProjectsOnlyParameter?.value;

    let buildCacheConfiguration: BuildCacheConfiguration | undefined;
    let cobuildConfiguration: CobuildConfiguration | undefined;
    if (!this._disableBuildCache) {
      await measureAsyncFn(`${PERF_PREFIX}:configureBuildCache`, async () => {
        [buildCacheConfiguration, cobuildConfiguration] = await Promise.all([
          BuildCacheConfiguration.tryLoadAsync(terminal, this.rushConfiguration, this.rushSession),
          CobuildConfiguration.tryLoadAsync(terminal, this.rushConfiguration, this.rushSession)
        ]);
        if (cobuildConfiguration) {
          await cobuildConfiguration.createLockProviderAsync(terminal);
        }
      });
    }

    try {
      const projectSelection: Set<RushConfigurationProject> = await measureAsyncFn(
        `${PERF_PREFIX}:getSelectedProjects`,
        () => this._selectionParameters.getSelectedProjectsAsync(terminal)
      );

      if (!projectSelection.size) {
        terminal.writeLine(
          Colorize.yellow(`The command line selection parameters did not match any projects.`)
        );
        return;
      }

      const customParametersByName: Map<string, CommandLineParameter> = new Map();
      for (const [configParameter, parserParameter] of this.customParameters) {
        customParametersByName.set(configParameter.longName, parserParameter);
      }

      const isWatch: boolean = this._watchParameter?.value || this._alwaysWatch;

      await measureAsyncFn(`${PERF_PREFIX}:applySituationalPlugins`, async () => {
        if (isWatch && this._noIPCParameter?.value === false) {
          new (
            await import(
              /* webpackChunkName: 'IPCOperationRunnerPlugin' */ '../../logic/operations/IPCOperationRunnerPlugin'
            )
          ).IPCOperationRunnerPlugin().apply(this.hooks);
        }

        if (buildCacheConfiguration?.buildCacheEnabled) {
          terminal.writeVerboseLine(`Incremental strategy: cache restoration`);
          new CacheableOperationPlugin({
            allowWarningsInSuccessfulBuild:
              !!this.rushConfiguration.experimentsConfiguration.configuration
                .buildCacheWithAllowWarningsInSuccessfulBuild,
            buildCacheConfiguration,
            cobuildConfiguration,
            terminal,
            excludeAppleDoubleFiles:
              !!this.rushConfiguration.experimentsConfiguration.configuration
                .omitAppleDoubleFilesFromBuildCache
          }).apply(this.hooks);

          if (this._debugBuildCacheIdsParameter.value) {
            new DebugHashesPlugin(terminal).apply(this.hooks);
          }
        } else if (!this._disableBuildCache) {
          terminal.writeVerboseLine(`Incremental strategy: output preservation`);
          // Explicitly disabling the build cache also disables legacy skip detection.
          new LegacySkipPlugin({
            allowWarningsInSuccessfulBuild:
              this.rushConfiguration.experimentsConfiguration.configuration
                .buildSkipWithAllowWarningsInSuccessfulBuild,
            terminal,
            changedProjectsOnly,
            isIncrementalBuildAllowed: this._isIncrementalBuildAllowed
          }).apply(this.hooks);
        } else {
          terminal.writeVerboseLine(`Incremental strategy: none (full rebuild)`);
        }

        const showBuildPlan: boolean = this._cobuildPlanParameter?.value ?? false;

        if (showBuildPlan) {
          if (!buildCacheConfiguration?.buildCacheEnabled) {
            throw new Error('You must have build cache enabled to use this option.');
          }
          const { BuildPlanPlugin } = await import('../../logic/operations/BuildPlanPlugin');
          new BuildPlanPlugin(terminal).apply(this.hooks);
        }

        const { configuration: experiments } = this.rushConfiguration.experimentsConfiguration;
        if (this.rushConfiguration?.isPnpm && experiments?.usePnpmSyncForInjectedDependencies) {
          const { PnpmSyncCopyOperationPlugin } = await import(
            '../../logic/operations/PnpmSyncCopyOperationPlugin'
          );
          new PnpmSyncCopyOperationPlugin(terminal).apply(this.hooks);
        }
      });

      const relevantProjects: Set<RushConfigurationProject> =
        Selection.expandAllDependencies(projectSelection);

      const projectConfigurations: ReadonlyMap<RushConfigurationProject, RushProjectConfiguration> = this
        ._runsBeforeInstall
        ? new Map()
        : await measureAsyncFn(`${PERF_PREFIX}:loadProjectConfigurations`, () =>
            RushProjectConfiguration.tryLoadForProjectsAsync(relevantProjects, terminal)
          );

      const initialCreateOperationsContext: ICreateOperationsContext = {
        buildCacheConfiguration,
        changedProjectsOnly,
        cobuildConfiguration,
        customParameters: customParametersByName,
        isIncrementalBuildAllowed: this._isIncrementalBuildAllowed,
        isInitial: true,
        isWatch,
        rushConfiguration: this.rushConfiguration,
        parallelism,
        phaseOriginal: new Set(this._originalPhases),
        phaseSelection: new Set(this._initialPhases),
        includePhaseDeps,
        projectSelection,
        projectConfigurations,
        projectsInUnknownState: projectSelection
      };

      const executionManagerOptions: Omit<
        IOperationExecutionManagerOptions,
        'beforeExecuteOperations' | 'inputsSnapshot'
      > = {
        quietMode: isQuietMode,
        debugMode: this.parser.isDebug,
        parallelism,
        allowOversubscription: this._allowOversubscription,
        beforeExecuteOperationAsync: async (record: OperationExecutionRecord) => {
          return await this.hooks.beforeExecuteOperation.promise(record);
        },
        afterExecuteOperationAsync: async (record: OperationExecutionRecord) => {
          await this.hooks.afterExecuteOperation.promise(record);
        },
        createEnvironmentForOperation: this.hooks.createEnvironmentForOperation.isUsed()
          ? (record: OperationExecutionRecord) => {
              return this.hooks.createEnvironmentForOperation.call({ ...process.env }, record);
            }
          : undefined,
        onOperationStatusChangedAsync: (record: OperationExecutionRecord) => {
          this.hooks.onOperationStatusChanged.call(record);
        }
      };

      const initialInternalOptions: IInitialRunPhasesOptions = {
        initialCreateOperationsContext,
        executionManagerOptions,
        stopwatch,
        terminal
      };

      const changedProjectsOnlyParameter: CommandLineFlagParameter | undefined =
        this._changedProjectsOnlyParameter;
      const runner: PhasedCommandRunner = new PhasedCommandRunner({
        actionName: this.actionName,
        hooks: this.hooks,
        rushConfiguration: this.rushConfiguration,
        terminal,
        isDebug: this.parser.isDebug,
        sessionAbortController: this.sessionAbortController,
        watchPhases: this._watchPhases,
        watchDebounceMs: this._watchDebounceMs,
        ipcEnabled: this._noIPCParameter?.value === false,
        changedProjectsOnly,
        changedProjectsOnlyParameterName: changedProjectsOnlyParameter
          ? (changedProjectsOnlyParameter.scopedLongName ?? changedProjectsOnlyParameter.longName)
          : undefined,
        getTelemetryExtraData: () => ({
          ...this._selectionParameters.getTelemetry(),
          ...this.getParameterStringMap()
        }),
        logTelemetry: this.parser.telemetry
          ? (entry: ITelemetryData) => {
              this.parser.telemetry!.log(entry);
              this.parser.flushTelemetry();
            }
          : undefined,
        onAfterExecuteTask: () => this._doAfterTask()
      });

      const internalOptions: IRunPhasesOptions = await measureAsyncFn(`${PERF_PREFIX}:runInitialPhases`, () =>
        runner.runInitialPhasesAsync(initialInternalOptions)
      );

      if (isWatch) {
        if (buildCacheConfiguration) {
          // Cache writes are not supported during watch mode, only reads.
          buildCacheConfiguration.cacheWriteEnabled = false;
        }

        // EXPERIMENTAL (rush daemon prototype): when RUSHMCP_DAEMON_SOCKET is set, expose an in-process
        // control channel so this long-lived watch process can also run Rush commands under the single
        // repository lock it already holds. Slated to become a first-class "rush daemon" action.
        // eslint-disable-next-line dot-notation
        const daemonSocketPath: string | undefined = process.env['RUSHMCP_DAEMON_SOCKET'];
        let daemonControlServer: DaemonControlServer | undefined;
        if (daemonSocketPath) {
          const { DaemonControlServer } = await import(
            /* webpackChunkName: 'DaemonControlServer' */ './DaemonControlServer'
          );
          daemonControlServer = new DaemonControlServer({
            socketPath: daemonSocketPath,
            rushConfiguration: this.rushConfiguration,
            terminal
          });
          daemonControlServer.start();
        }

        try {
          await runner.runWatchPhasesAsync(internalOptions);
        } finally {
          daemonControlServer?.close();
        }
        terminal.writeDebugLine(`Watch mode exited.`);
      }
    } finally {
      if (cobuildConfiguration) {
        await cobuildConfiguration.destroyLockProviderAsync();
      }
    }
  }

  private _doBeforeTask(): void {
    if (
      this.actionName !== RushConstants.buildCommandName &&
      this.actionName !== RushConstants.rebuildCommandName
    ) {
      // Only collects information for built-in commands like build or rebuild.
      return;
    }

    SetupChecks.validate(this.rushConfiguration);

    this.eventHooksManager.handle(Event.preRushBuild, this.parser.isDebug, this._ignoreHooksParameter.value);
  }

  private _doAfterTask(): void {
    if (
      this.actionName !== RushConstants.buildCommandName &&
      this.actionName !== RushConstants.rebuildCommandName
    ) {
      // Only collects information for built-in commands like build or rebuild.
      return;
    }
    this.eventHooksManager.handle(Event.postRushBuild, this.parser.isDebug, this._ignoreHooksParameter.value);
  }
}
