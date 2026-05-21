// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';

import { WebSocket, type RawData } from 'ws';

import { Executable } from '@rushstack/node-core-library';

import type {
  IOperationInfo,
  IRushSessionInfo,
  IWebSocketCommandMessage,
  IWebSocketEventMessage,
  ReadableOperationStatus
} from './protocol.types';

/**
 * The default WebSocket URL for the build status server. Override with the
 * `RUSHMCP_BUILD_STATUS_WS_URL` environment variable to match the `buildStatusWebSocketPath`
 * and port configured for `@rushstack/rush-serve-plugin`.
 */
const DEFAULT_WEB_SOCKET_URL: string = 'wss://localhost:8443/';

/** Default command used to start a build host when none is reachable. */
const DEFAULT_START_COMMAND: string = 'rush start';

const CONNECT_TIMEOUT_MS: number = 15000;
const DEFAULT_START_TIMEOUT_MS: number = 180000;

/** Matches the `https://<host>:<port>/` line that rush-serve logs once it begins serving. */
const SERVE_URL_REGEX: RegExp = /https:\/\/([a-zA-Z0-9.-]+):(\d+)\//;

/**
 * A point-in-time view of the build host's state.
 */
export interface IBuildStatusSnapshot {
  connected: boolean;
  overallStatus: ReadableOperationStatus;
  sessionInfo: IRushSessionInfo | undefined;
  operations: IOperationInfo[];
}

export interface IRushServeClientOptions {
  /** The full WebSocket URL of the build status server, e.g. `wss://localhost:8443/`. */
  webSocketUrl: string;
  /** If true, start a build host (`rush start`) when none is reachable. Default true. */
  autoStart: boolean;
  /** The executable to start a build host with, e.g. `rush`. */
  startCommand: string;
  /** The arguments for the start command, e.g. `["start"]`. */
  startArgs: string[];
  /** The working directory in which to start the build host (the Rush workspace root). */
  workspacePath: string;
  /** How long to wait for a spawned build host to begin serving before giving up. */
  startTimeoutMs: number;
}

/**
 * Resolves the build host connection options from the environment.
 */
export function getBuildHostConfigFromEnv(workspacePath: string): IRushServeClientOptions {
  /* eslint-disable dot-notation */
  const env: NodeJS.ProcessEnv = process.env;
  const webSocketUrl: string = env['RUSHMCP_BUILD_STATUS_WS_URL'] || DEFAULT_WEB_SOCKET_URL;
  const autoStartRaw: string | undefined = env['RUSHMCP_BUILD_AUTOSTART'];
  const autoStart: boolean = autoStartRaw === undefined ? true : !/^(0|false|no)$/i.test(autoStartRaw);
  const startCommandRaw: string = env['RUSHMCP_BUILD_START_COMMAND'] || DEFAULT_START_COMMAND;
  const startTimeoutMs: number = Number(env['RUSHMCP_BUILD_START_TIMEOUT_MS']) || DEFAULT_START_TIMEOUT_MS;
  /* eslint-enable dot-notation */

  const startParts: string[] = startCommandRaw.trim().split(/\s+/);
  return {
    webSocketUrl,
    autoStart,
    startCommand: startParts[0],
    startArgs: startParts.slice(1),
    workspacePath,
    startTimeoutMs
  };
}

function toHttpsOrigin(wsUrl: string): string {
  const url: URL = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.origin;
}

/**
 * A client that connects to the live build status WebSocket served by `@rushstack/rush-serve-plugin`.
 * If no host is reachable and `autoStart` is enabled, it starts one (`rush start`), discovers the
 * port it serves on, and connects. The connection is established lazily on first use.
 */
export class RushServeClient {
  private readonly _configuredWebSocketUrl: string;
  private readonly _autoStart: boolean;
  private readonly _startCommand: string;
  private readonly _startArgs: string[];
  private readonly _workspacePath: string;
  private readonly _startTimeoutMs: number;
  // The serve plugin uses a self-signed debug certificate. For localhost dev tooling we skip
  // verification.
  // TODO (hardening): trust the CA via @rushstack/debug-certificate-manager instead of disabling it.
  private readonly _httpsAgent: https.Agent;

  private _httpsOrigin: string;
  private _webSocket: WebSocket | undefined;
  private _readyPromise: Promise<void> | undefined;
  private _spawnedChild: ChildProcess | undefined;
  private _cleanupRegistered: boolean;

  private _overallStatus: ReadableOperationStatus;
  private _sessionInfo: IRushSessionInfo | undefined;
  private readonly _operationsByName: Map<string, IOperationInfo>;

  public constructor(options: IRushServeClientOptions) {
    this._configuredWebSocketUrl = options.webSocketUrl;
    this._autoStart = options.autoStart;
    this._startCommand = options.startCommand;
    this._startArgs = options.startArgs;
    this._workspacePath = options.workspacePath;
    this._startTimeoutMs = options.startTimeoutMs;

    this._httpsOrigin = toHttpsOrigin(this._configuredWebSocketUrl);
    this._httpsAgent = new https.Agent({ rejectUnauthorized: false });

    this._cleanupRegistered = false;
    this._overallStatus = 'Ready';
    this._operationsByName = new Map();
  }

  public get webSocketUrl(): string {
    return this._configuredWebSocketUrl;
  }

  /**
   * Ensures the client is connected and has received an initial snapshot. If no host is reachable and
   * autostart is enabled, starts one first. Safe to call repeatedly.
   */
  public async ensureReadyAsync(): Promise<void> {
    if (this._webSocket && this._webSocket.readyState === WebSocket.OPEN) {
      return;
    }
    if (!this._readyPromise) {
      this._readyPromise = this._establishConnectionAsync();
    }
    try {
      await this._readyPromise;
    } catch (error) {
      this._readyPromise = undefined;
      throw error;
    }
  }

  /**
   * Returns the current in-memory snapshot of the build host's state.
   */
  public getSnapshot(): IBuildStatusSnapshot {
    return {
      connected: !!this._webSocket && this._webSocket.readyState === WebSocket.OPEN,
      overallStatus: this._overallStatus,
      sessionInfo: this._sessionInfo,
      operations: Array.from(this._operationsByName.values())
    };
  }

  /**
   * Returns the operations in the current snapshot that match the given project and/or phase.
   */
  public findOperations(filter: { project?: string; phase?: string }): IOperationInfo[] {
    let operations: IOperationInfo[] = Array.from(this._operationsByName.values());
    if (filter.project !== undefined) {
      operations = operations.filter((operation) => operation.packageName === filter.project);
    }
    if (filter.phase !== undefined) {
      operations = operations.filter((operation) => operation.phaseName === filter.phase);
    }
    return operations;
  }

  /**
   * Sends a command to the build host. Commands are fire-and-forget; their effect is observed via
   * subsequent status events.
   */
  public async sendCommandAsync(message: IWebSocketCommandMessage): Promise<void> {
    await this.ensureReadyAsync();
    if (!this._webSocket || this._webSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to the Rush build host.');
    }
    this._webSocket.send(JSON.stringify(message));
  }

  /**
   * Fetches the contents of a log file by its serve-relative URL (as found in `IOperationInfo.logFileURLs`).
   * Resolves to `undefined` if the log file does not exist (HTTP 404); for example, the stderr log is only
   * written when an operation produces stderr output.
   */
  public async fetchLogTextAsync(relativeUrl: string): Promise<string | undefined> {
    const fullUrl: string = `${this._httpsOrigin}${relativeUrl}`;
    return await new Promise<string | undefined>((resolve, reject) => {
      const request: ClientRequest = https.get(
        fullUrl,
        { agent: this._httpsAgent },
        (response: IncomingMessage) => {
          const statusCode: number = response.statusCode ?? 0;
          if (statusCode === 404) {
            response.resume();
            resolve(undefined);
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            response.resume();
            reject(new Error(`Failed to fetch log at ${fullUrl}: HTTP ${statusCode}`));
            return;
          }
          let body: string = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () => {
            resolve(body);
          });
        }
      );
      request.on('error', (error: Error) => {
        reject(new Error(`Failed to fetch log at ${fullUrl}: ${error.message}`));
      });
    });
  }

  /**
   * Terminates a build host that this client started (if any). No-op if the host was not started by us.
   */
  public disposeAsync(): void {
    this._killSpawnedHost();
  }

  private async _establishConnectionAsync(): Promise<void> {
    // 1. Try to connect to an already-running host.
    try {
      await this._connectToUrlAsync(this._configuredWebSocketUrl);
      return;
    } catch (initialError) {
      if (!this._autoStart) {
        throw new Error(
          `Could not connect to the Rush build host at ${this._configuredWebSocketUrl}: ` +
            `${(initialError as Error).message}\n` +
            `Start one with "${this._startCommand} ${this._startArgs.join(' ')}" (with ` +
            `@rushstack/rush-serve-plugin enabled), or enable autostart (RUSHMCP_BUILD_AUTOSTART=1).`
        );
      }
    }

    // 2. Nothing reachable: start a host and connect to it.
    const startedUrl: string = await this._spawnHostAndGetUrlAsync();
    await this._connectToUrlAsync(startedUrl);
  }

  private async _connectToUrlAsync(url: string): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
      const webSocket: WebSocket = new WebSocket(url, { rejectUnauthorized: false });
      let settled: boolean = false;

      const timeout: NodeJS.Timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          webSocket.terminate();
          reject(new Error(`Timed out connecting to ${url}.`));
        }
      }, CONNECT_TIMEOUT_MS);

      webSocket.on('message', (data: RawData) => {
        let message: IWebSocketEventMessage;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        this._handleMessage(message);

        // The first message after connecting is a 'sync', which means our snapshot is now populated.
        if (!settled && message.event === 'sync') {
          settled = true;
          clearTimeout(timeout);
          this._webSocket = webSocket;
          this._httpsOrigin = toHttpsOrigin(url);
          // Reconnect on a future close.
          webSocket.on('close', () => {
            this._webSocket = undefined;
            this._readyPromise = undefined;
          });
          resolve();
        }
      });

      webSocket.on('error', (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });

      webSocket.on('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Connection closed before the initial sync message.'));
        }
      });
    });
  }

  /**
   * Starts a build host and resolves with the WebSocket URL it serves on (discovered by scraping the
   * serve URL it prints to stdout).
   */
  private async _spawnHostAndGetUrlAsync(): Promise<string> {
    const resolvedCommand: string | undefined = Executable.tryResolve(this._startCommand);
    if (!resolvedCommand) {
      throw new Error(`Cannot start a build host: command "${this._startCommand}" was not found on PATH.`);
    }

    // Strip our own config vars from the child's environment so they can't confuse Rush. (Rush also
    // rejects any unrecognized variable that starts with the reserved "RUSH_" prefix, which is why
    // these are named "RUSHMCP_" rather than "RUSH_".)
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('RUSHMCP_')) {
        delete childEnv[key];
      }
    }

    const child: ChildProcess = spawn(resolvedCommand, this._startArgs, {
      cwd: this._workspacePath,
      // Run in its own process group so we can terminate the whole tree later.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv
    });
    this._spawnedChild = child;
    this._registerHostCleanup();

    // The path of the WebSocket endpoint comes from the configured URL; the host:port is discovered.
    const webSocketPath: string = new URL(this._configuredWebSocketUrl).pathname;

    return await new Promise<string>((resolve, reject) => {
      let settled: boolean = false;
      let buffer: string = '';

      const timeout: NodeJS.Timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this._killSpawnedHost();
          reject(
            new Error(
              `Timed out after ${this._startTimeoutMs}ms waiting for "${this._startCommand} ` +
                `${this._startArgs.join(' ')}" to begin serving.`
            )
          );
        }
      }, this._startTimeoutMs);

      const onData = (chunk: Buffer): void => {
        // Keep consuming output even after we've found the URL so the child's pipe never blocks.
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
          reject(new Error(`Failed to start build host: ${error.message}`));
        }
      });

      child.on('exit', (code: number | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Build host exited (code ${code}) before it began serving.`));
        }
      });
    });
  }

  private _registerHostCleanup(): void {
    if (this._cleanupRegistered) {
      return;
    }
    this._cleanupRegistered = true;
    process.once('exit', () => this._killSpawnedHost());
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        this._killSpawnedHost();
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
    }
  }

  private _killSpawnedHost(): void {
    const child: ChildProcess | undefined = this._spawnedChild;
    if (!child || child.exitCode !== null || child.pid === undefined) {
      return;
    }
    try {
      // Negative pid targets the whole process group (the host was started detached).
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Best effort; ignore (the process may have already exited).
    }
  }

  private _handleMessage(message: IWebSocketEventMessage): void {
    switch (message.event) {
      case 'sync': {
        this._operationsByName.clear();
        this._sessionInfo = message.sessionInfo;
        this._overallStatus = message.status;
        this._mergeOperations(message.operations);
        break;
      }
      case 'before-execute': {
        this._overallStatus = 'Executing';
        this._mergeOperations(message.operations);
        break;
      }
      case 'status-change': {
        this._mergeOperations(message.operations);
        break;
      }
      case 'after-execute': {
        this._overallStatus = message.status;
        this._mergeOperations(message.operations);
        break;
      }
    }
  }

  private _mergeOperations(operations: IOperationInfo[]): void {
    for (const operation of operations) {
      this._operationsByName.set(operation.name, operation);
    }
  }
}
