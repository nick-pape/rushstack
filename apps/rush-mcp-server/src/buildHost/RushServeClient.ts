// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';

import { WebSocket, type RawData } from 'ws';

import { LockFile } from '@rushstack/node-core-library';

import type {
  IOperationInfo,
  IRushSessionInfo,
  IWebSocketCommandMessage,
  IWebSocketEventMessage,
  ReadableOperationStatus
} from './protocol.types';
import { clearDiscovery, isProcessAlive, readDiscovery } from '../daemon/discoveryFile';

/**
 * The default WebSocket URL for the build status server. Override with the
 * `RUSHMCP_BUILD_STATUS_WS_URL` environment variable to attach to a specific (e.g. externally started)
 * build host. When unset, the client discovers/starts the shared daemon.
 */
const DEFAULT_WEB_SOCKET_URL: string = 'wss://localhost:8443/';

/** Default command the daemon uses to start the watch. */
const DEFAULT_START_COMMAND: string = 'rush start';

const CONNECT_TIMEOUT_MS: number = 15000;
const DEFAULT_START_TIMEOUT_MS: number = 180000;
const DISCOVERY_POLL_MS: number = 250;
const STOP_TIMEOUT_MS: number = 10000;
// Mutating commands (install/update) can take a while; allow generous time for an in-process command.
const DAEMON_COMMAND_TIMEOUT_MS: number = 600000;

function delayAsync(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

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
  /** If true, start the shared daemon when no host is reachable. Default true. */
  autoStart: boolean;
  /** The executable the daemon uses to start the watch, e.g. `rush`. */
  startCommand: string;
  /** The arguments for the start command, e.g. `["start"]`. */
  startArgs: string[];
  /** The Rush workspace root. */
  workspacePath: string;
  /** How long to wait for a starting daemon to begin serving before giving up. */
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
 * A client for the shared Rush build host. It connects to the watch served by the `BuildHostDaemon`
 * (`@rushstack/rush-serve-plugin` under the hood), discovering it via `common/temp/rushmcp-build-host.json`
 * and starting the daemon if none is running. The daemon (not this client) owns the watch, so the watch
 * is shared across MCP clients and survives them. Connection is established lazily on first use.
 */
export class RushServeClient {
  private readonly _configuredWebSocketUrl: string;
  private readonly _autoStart: boolean;
  private readonly _startCommand: string;
  private readonly _startArgs: string[];
  private readonly _workspacePath: string;
  private readonly _startTimeoutMs: number;
  // The serve plugin uses a self-signed debug certificate. For localhost dev tooling we skip verification.
  // TODO (hardening): trust the CA via @rushstack/debug-certificate-manager instead of disabling it.
  private readonly _httpsAgent: https.Agent;

  private _httpsOrigin: string;
  private _webSocket: WebSocket | undefined;
  private _readyPromise: Promise<void> | undefined;

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

    this._overallStatus = 'Ready';
    this._operationsByName = new Map();
  }

  public get webSocketUrl(): string {
    return this._configuredWebSocketUrl;
  }

  /**
   * Ensures the client is connected and has received an initial snapshot, discovering or starting the
   * shared daemon as needed. Safe to call repeatedly.
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

  /** True if currently connected to a build host. */
  public isConnected(): boolean {
    return !!this._webSocket && this._webSocket.readyState === WebSocket.OPEN;
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
   * Stops the shared build host daemon (if one is running), releasing the repository lock. Returns true
   * if a daemon was stopped. The daemon restarts automatically the next time the host is needed.
   */
  public async stopDaemonAsync(): Promise<boolean> {
    const webSocket: WebSocket | undefined = this._webSocket;
    this._webSocket = undefined;
    this._readyPromise = undefined;
    if (webSocket) {
      try {
        webSocket.close();
      } catch {
        // ignore
      }
    }

    const info: ReturnType<typeof readDiscovery> = readDiscovery(this._workspacePath);
    if (!info) {
      return false;
    }

    const { daemonPid } = info;
    try {
      process.kill(daemonPid, 'SIGTERM');
    } catch {
      // Already gone.
    }

    const deadline: number = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline && isProcessAlive(daemonPid)) {
      await delayAsync(DISCOVERY_POLL_MS);
    }
    if (isProcessAlive(daemonPid)) {
      try {
        process.kill(daemonPid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    // The daemon clears the discovery file on exit; clear defensively in case it was force-killed.
    try {
      clearDiscovery(this._workspacePath);
    } catch {
      // ignore
    }
    return true;
  }

  /**
   * Returns the path of the watch's in-process control socket, if the running daemon advertises one.
   */
  public getControlSocketPath(): string | undefined {
    return readDiscovery(this._workspacePath)?.controlSocketPath;
  }

  /**
   * Sends a command to the watch's in-process control channel (e.g. an `install` that runs inside the
   * watch under the held lock) and returns its result. Throws if no control socket is available.
   */
  public async sendDaemonCommandAsync(
    command: string,
    args: string[] = []
  ): Promise<{ ok: boolean; text: string }> {
    const socketPath: string | undefined = this.getControlSocketPath();
    if (!socketPath) {
      throw new Error(
        'No build-host control socket is available (the watch was not started with in-process command support).'
      );
    }
    return await new Promise<{ ok: boolean; text: string }>((resolve, reject) => {
      const socket: net.Socket = net.connect(socketPath);
      let buffer: string = '';
      let settled: boolean = false;
      const timeout: NodeJS.Timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error('Timed out waiting for the daemon control response.'));
        }
      }, DAEMON_COMMAND_TIMEOUT_MS);

      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(JSON.stringify({ id: 1, command, args }) + '\n');
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newlineIndex: number = buffer.indexOf('\n');
        if (newlineIndex >= 0 && !settled) {
          settled = true;
          clearTimeout(timeout);
          let response: { ok?: boolean; text?: string };
          try {
            response = JSON.parse(buffer.slice(0, newlineIndex));
          } catch {
            socket.end();
            reject(new Error('Malformed daemon control response.'));
            return;
          }
          socket.end();
          resolve({ ok: !!response.ok, text: String(response.text ?? '') });
        }
      });
      socket.on('error', (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Could not reach the daemon control socket: ${error.message}`));
        }
      });
    });
  }

  /**
   * No-op: the shared daemon is intentionally NOT stopped when a client disposes, so it survives for
   * other clients. Use {@link stopDaemonAsync} (or the shutdown tool) to stop it explicitly.
   */
  public disposeAsync(): void {
    // Intentionally empty.
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

  private async _establishConnectionAsync(): Promise<void> {
    // 1. Try the configured URL (an explicitly-specified or externally-started host).
    try {
      await this._connectToUrlAsync(this._configuredWebSocketUrl);
      return;
    } catch {
      // fall through
    }

    // 2. Try a daemon advertised in the discovery file.
    const existing: ReturnType<typeof readDiscovery> = readDiscovery(this._workspacePath);
    if (existing) {
      try {
        await this._connectToUrlAsync(existing.webSocketUrl);
        return;
      } catch {
        // The discovery file is stale or the host is unreachable; remove it and start fresh.
        try {
          clearDiscovery(this._workspacePath);
        } catch {
          // ignore
        }
      }
    }

    // 3. Start the shared daemon and connect to it.
    if (!this._autoStart) {
      throw new Error(
        `Could not connect to a Rush build host (configured URL ${this._configuredWebSocketUrl} and no ` +
          `running daemon). Start one with "${this._startCommand} ${this._startArgs.join(' ')}" + ` +
          `@rushstack/rush-serve-plugin, or enable autostart (RUSHMCP_BUILD_AUTOSTART=1).`
      );
    }
    const startedUrl: string = await this._startDaemonAndGetUrlAsync();
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

        if (!settled && message.event === 'sync') {
          settled = true;
          clearTimeout(timeout);
          this._webSocket = webSocket;
          this._httpsOrigin = toHttpsOrigin(url);
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
   * Starts the shared build host daemon (detached, so it outlives this process) and resolves with the
   * WebSocket URL it advertises once it begins serving. Serialized with a lock so concurrent clients
   * do not each start a daemon.
   */
  private async _startDaemonAndGetUrlAsync(): Promise<string> {
    const commonTempFolder: string = path.join(this._workspacePath, 'common', 'temp');
    const launchLock: LockFile = await LockFile.acquireAsync(commonTempFolder, 'rushmcp-daemon-launch');
    try {
      // Another client may have started the daemon while we waited for the lock.
      const existing: ReturnType<typeof readDiscovery> = readDiscovery(this._workspacePath);
      if (existing) {
        return existing.webSocketUrl;
      }

      const daemonScript: string = path.resolve(__dirname, '..', 'daemon', 'start.js');
      const logPath: string = path.join(commonTempFolder, 'rushmcp-build-host.log');
      const logFd: number = fs.openSync(logPath, 'a');
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [daemonScript, this._workspacePath], {
          cwd: this._workspacePath,
          // Detached + unref so the daemon outlives this client (the daemon owns the watch).
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: process.env
        });
      } finally {
        fs.closeSync(logFd);
      }
      child.unref();

      const deadline: number = Date.now() + this._startTimeoutMs;
      while (Date.now() < deadline) {
        const info: ReturnType<typeof readDiscovery> = readDiscovery(this._workspacePath);
        if (info) {
          return info.webSocketUrl;
        }
        if (child.exitCode !== null) {
          throw new Error(
            `The build host daemon exited (code ${child.exitCode}) before serving. See ${logPath}.`
          );
        }
        await delayAsync(DISCOVERY_POLL_MS);
      }
      throw new Error(`Timed out waiting for the build host daemon to start. See ${logPath}.`);
    } finally {
      launchLock.release();
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
