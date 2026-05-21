// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';

import { WebSocket, type RawData } from 'ws';

import type {
  IOperationInfo,
  IRushSessionInfo,
  IWebSocketEventMessage,
  ReadableOperationStatus
} from './protocol.types';

/**
 * The default WebSocket URL for the build status server. Override with the
 * `RUSH_BUILD_STATUS_WS_URL` environment variable to match the `buildStatusWebSocketPath`
 * and port configured for `@rushstack/rush-serve-plugin`.
 */
const DEFAULT_WEB_SOCKET_URL: string = 'wss://localhost:8443/';

const CONNECT_TIMEOUT_MS: number = 15000;

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
}

/**
 * Resolves the build host connection options from the environment.
 */
export function getBuildHostConfigFromEnv(): IRushServeClientOptions {
  // eslint-disable-next-line dot-notation
  const webSocketUrl: string = process.env['RUSH_BUILD_STATUS_WS_URL'] || DEFAULT_WEB_SOCKET_URL;
  return { webSocketUrl };
}

/**
 * A client that connects to the live build status WebSocket served by `@rushstack/rush-serve-plugin`
 * (typically from a running `rush start`), maintains an in-memory snapshot of the build graph, and
 * fetches per-operation logs over HTTPS.
 *
 * The connection is established lazily on first use, so constructing this client is free and does not
 * require a running build host.
 */
export class RushServeClient {
  private readonly _webSocketUrl: string;
  private readonly _httpsOrigin: string;
  // The serve plugin uses a self-signed debug certificate. For localhost dev tooling we skip
  // verification.
  // TODO (hardening): trust the CA via @rushstack/debug-certificate-manager instead of disabling it.
  private readonly _httpsAgent: https.Agent;

  private _webSocket: WebSocket | undefined;
  private _readyPromise: Promise<void> | undefined;

  private _overallStatus: ReadableOperationStatus;
  private _sessionInfo: IRushSessionInfo | undefined;
  private readonly _operationsByName: Map<string, IOperationInfo>;

  public constructor(options: IRushServeClientOptions) {
    this._webSocketUrl = options.webSocketUrl;

    const httpsUrl: URL = new URL(this._webSocketUrl);
    httpsUrl.protocol = httpsUrl.protocol === 'wss:' ? 'https:' : 'http:';
    this._httpsOrigin = httpsUrl.origin;

    this._httpsAgent = new https.Agent({ rejectUnauthorized: false });

    this._overallStatus = 'Ready';
    this._operationsByName = new Map();
  }

  public get webSocketUrl(): string {
    return this._webSocketUrl;
  }

  /**
   * Ensures the client is connected and has received an initial snapshot. Safe to call repeatedly;
   * it will reconnect if a previous connection was closed.
   */
  public async ensureReadyAsync(): Promise<void> {
    if (this._webSocket && this._webSocket.readyState === WebSocket.OPEN) {
      return;
    }
    if (!this._readyPromise) {
      this._readyPromise = this._connectAsync();
    }
    await this._readyPromise;
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

  private async _connectAsync(): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
      const webSocket: WebSocket = new WebSocket(this._webSocketUrl, { rejectUnauthorized: false });
      let settled: boolean = false;

      const timeout: NodeJS.Timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this._readyPromise = undefined;
          webSocket.terminate();
          reject(new Error(`Timed out connecting to the Rush build host at ${this._webSocketUrl}.`));
        }
      }, CONNECT_TIMEOUT_MS);

      webSocket.on('message', (data: RawData) => {
        let message: IWebSocketEventMessage;
        try {
          message = JSON.parse(data.toString());
        } catch {
          // Ignore malformed messages.
          return;
        }
        this._handleMessage(message);

        // The first message after connecting is a 'sync', which means our snapshot is now populated.
        if (!settled && message.event === 'sync') {
          settled = true;
          clearTimeout(timeout);
          this._webSocket = webSocket;
          resolve();
        }
      });

      webSocket.on('error', (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this._readyPromise = undefined;
          reject(
            new Error(
              `Could not connect to the Rush build host at ${this._webSocketUrl}: ${error.message}\n` +
                `Is "rush start" (or another watch command) running with @rushstack/rush-serve-plugin and a ` +
                `matching "buildStatusWebSocketPath"? You can override the URL with the ` +
                `RUSH_BUILD_STATUS_WS_URL environment variable.`
            )
          );
        }
      });

      webSocket.on('close', () => {
        this._webSocket = undefined;
        this._readyPromise = undefined;
      });
    });
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
