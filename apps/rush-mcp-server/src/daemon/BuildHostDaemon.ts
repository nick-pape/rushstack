// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { Executable, LockFile, SubprocessTerminator } from '@rushstack/node-core-library';

import { clearDiscovery, writeDiscovery } from './discoveryFile';

/** Matches the `https://<host>:<port>/` line that rush-serve logs once it begins serving. */
const SERVE_URL_REGEX: RegExp = /https:\/\/([a-zA-Z0-9.-]+):(\d+)\//;

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

  public constructor(options: IBuildHostDaemonOptions) {
    this._options = options;
  }

  public async runAsync(): Promise<void> {
    const { workspacePath } = this._options;
    const commonTempFolder: string = path.join(workspacePath, 'common', 'temp');

    // Only one daemon per repo.
    const lock: LockFile | undefined = LockFile.tryAcquire(commonTempFolder, 'rushmcp-daemon');
    if (!lock) {
      process.stderr.write('A rushmcp build-host daemon is already running in this repository.\n');
      return;
    }

    let child: ChildProcess | undefined;
    // Clean up the discovery file no matter how we exit.
    process.once('exit', () => {
      try {
        clearDiscovery(workspacePath);
      } catch {
        // ignore
      }
    });
    process.once('SIGINT', () => process.exit(0));
    process.once('SIGTERM', () => process.exit(0));

    try {
      child = this._spawnWatch();
      // Reap the watch tree when this daemon exits or is signalled.
      SubprocessTerminator.killProcessTreeOnExit(child, SubprocessTerminator.RECOMMENDED_OPTIONS);

      const webSocketUrl: string = await this._discoverServeUrlAsync(child);
      writeDiscovery(workspacePath, {
        webSocketUrl,
        daemonPid: process.pid,
        startedAt: new Date().toISOString()
      });
      process.stdout.write(`Build host ready at ${webSocketUrl} (daemon pid ${process.pid}).\n`);

      // Stay alive until the watch exits (a signal triggers process.exit above, which kills the watch).
      await once(child, 'exit');
      process.stdout.write('Watch process exited; shutting down daemon.\n');
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
