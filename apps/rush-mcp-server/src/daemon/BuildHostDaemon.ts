// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { Executable, LockFile, SubprocessTerminator } from '@rushstack/node-core-library';

import { clearDiscovery, writeDiscovery } from './discoveryFile';

/** Matches the `https://<host>:<port>/` line that rush-serve logs once it begins serving. */
const SERVE_URL_REGEX: RegExp = /https:\/\/([a-zA-Z0-9.-]+):(\d+)\//;

const RESTART_DELAY_MS: number = 1000;
/** A watch that exits within this window of starting is treated as a crash for back-off purposes. */
const FAST_FAILURE_WINDOW_MS: number = 5000;
const MAX_CONSECUTIVE_FAILURES: number = 3;

function delayAsync(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export interface IBuildHostDaemonOptions {
  /** The Rush workspace root. */
  workspacePath: string;
  /** Executable to start the watch with, e.g. `rush`. */
  startCommand: string;
  /** Arguments for the start command, e.g. `["start"]`. */
  startArgs: string[];
  /** The URL path of the WebSocket endpoint (host:port is discovered), e.g. `/`. */
  webSocketPath: string;
  /** How long to wait for the watch to begin serving before giving up. */
  startTimeoutMs: number;
}

/**
 * A long-lived supervisor process that owns a single Rush watch (`rush start` + rush-serve-plugin)
 * and advertises it via a discovery file so multiple MCP clients can share it. The watch is owned by
 * the daemon (not by any client), so it survives individual MCP processes and is reaped when the
 * daemon itself exits.
 */
export class BuildHostDaemon {
  private readonly _options: IBuildHostDaemonOptions;
  private _controlSocketPath: string | undefined;

  public constructor(options: IBuildHostDaemonOptions) {
    this._options = options;
  }

  public async runAsync(): Promise<void> {
    const { workspacePath } = this._options;
    const commonTempFolder: string = path.join(workspacePath, 'common', 'temp');
    // The watch will open its in-process control channel here (rush-lib reads RUSHMCP_DAEMON_SOCKET).
    this._controlSocketPath = path.join(commonTempFolder, 'rushmcp-build-host-control.sock');

    // Only one daemon per repo.
    const lock: LockFile | undefined = LockFile.tryAcquire(commonTempFolder, 'rushmcp-daemon');
    if (!lock) {
      process.stderr.write('A rushmcp build-host daemon is already running in this repository.\n');
      return;
    }

    let child: ChildProcess | undefined;

    // Clean up the discovery file no matter how we exit (including process.exit on a signal).
    process.once('exit', () => {
      try {
        clearDiscovery(workspacePath);
      } catch {
        // ignore
      }
    });
    // On a signal, exit; the 'exit' handler clears discovery and SubprocessTerminator reaps the watch.
    process.once('SIGINT', () => process.exit(0));
    process.once('SIGTERM', () => process.exit(0));

    try {
      // Supervision loop: keep the watch running, restarting it if it exits unexpectedly (each restart
      // re-advertises the new port; connected clients reconnect via the discovery file). The loop ends
      // only if the watch crash-loops; the counter is the loop condition.
      let consecutiveFailures: number = 0;
      while (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
        const startedAt: number = Date.now();
        child = this._spawnWatch();
        // Reap the watch tree if this daemon exits or is signalled.
        SubprocessTerminator.killProcessTreeOnExit(child, SubprocessTerminator.RECOMMENDED_OPTIONS);

        let webSocketUrl: string;
        try {
          webSocketUrl = await this._discoverServeUrlAsync(child);
        } catch (error) {
          consecutiveFailures++;
          process.stderr.write(`Watch failed to start: ${(error as Error).message}\n`);
          await delayAsync(RESTART_DELAY_MS);
          continue;
        }

        writeDiscovery(workspacePath, {
          webSocketUrl,
          daemonPid: process.pid,
          startedAt: new Date().toISOString(),
          controlSocketPath: this._controlSocketPath
        });
        process.stdout.write(`Build host ready at ${webSocketUrl} (daemon pid ${process.pid}).\n`);

        await once(child, 'exit');

        // The watch exited on its own. Drop the advertisement and restart unless it's crash-looping
        // (a watch that ran long enough before exiting resets the failure counter).
        clearDiscovery(workspacePath);
        consecutiveFailures = Date.now() - startedAt < FAST_FAILURE_WINDOW_MS ? consecutiveFailures + 1 : 0;
        process.stderr.write('Watch exited; restarting...\n');
        await delayAsync(RESTART_DELAY_MS);
      }
      process.stderr.write(`Watch crash-looped; giving up after ${MAX_CONSECUTIVE_FAILURES} failures.\n`);
    } finally {
      clearDiscovery(workspacePath);
      if (child) {
        SubprocessTerminator.killProcessTree(child, SubprocessTerminator.RECOMMENDED_OPTIONS);
      }
      lock.release();
    }
  }

  private _spawnWatch(): ChildProcess {
    const { startCommand, startArgs, workspacePath } = this._options;
    const resolved: string | undefined = Executable.tryResolve(startCommand);
    if (!resolved) {
      throw new Error(`Cannot start the watch: command "${startCommand}" was not found on PATH.`);
    }

    // Don't leak our own RUSHMCP_* config into Rush (which rejects unrecognized RUSH_*-prefixed vars).
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('RUSHMCP_')) {
        delete childEnv[key];
      }
    }
    // ...except RUSHMCP_DAEMON_SOCKET, which tells the watch where to open its in-process control
    // channel. rush-lib reads (and does not reject) this variable.
    if (this._controlSocketPath) {
      // eslint-disable-next-line dot-notation
      childEnv['RUSHMCP_DAEMON_SOCKET'] = this._controlSocketPath;
    }

    return spawn(resolved, startArgs, {
      cwd: workspacePath,
      ...SubprocessTerminator.RECOMMENDED_OPTIONS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv
    });
  }

  private async _discoverServeUrlAsync(child: ChildProcess): Promise<string> {
    const { webSocketPath, startCommand, startArgs, startTimeoutMs } = this._options;
    return await new Promise<string>((resolve, reject) => {
      let settled: boolean = false;
      let buffer: string = '';

      const timeout: NodeJS.Timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `Timed out after ${startTimeoutMs}ms waiting for "${startCommand} ${startArgs.join(' ')}" ` +
                `to begin serving.`
            )
          );
        }
      }, startTimeoutMs);

      const onData = (chunk: Buffer): void => {
        if (settled) {
          return;
        }
        buffer += chunk.toString();
        const match: RegExpMatchArray | null = buffer.match(SERVE_URL_REGEX);
        if (match) {
          settled = true;
          clearTimeout(timeout);
          resolve(`wss://${match[1]}:${match[2]}${webSocketPath}`);
        }
      };

      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.on('error', (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to start the watch: ${error.message}`));
        }
      });

      child.on('exit', (code: number | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Watch process exited (code ${code}) before it began serving.`));
        }
      });
    });
  }
}
