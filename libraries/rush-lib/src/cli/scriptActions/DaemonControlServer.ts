// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as net from 'node:net';

import { FileSystem } from '@rushstack/node-core-library';
import { type ITerminal, Terminal, StringBufferTerminalProvider } from '@rushstack/terminal';

import type { RushConfiguration } from '../../api/RushConfiguration';
import type { RushGlobalFolder } from '../../api/RushGlobalFolder';
import { VersionMismatchFinder } from '../../logic/versionMismatch/VersionMismatchFinder';

/**
 * A request received over the daemon control socket.
 */
interface IControlRequest {
  id: number;
  command: string;
  args?: string[];
}

interface IControlResponse {
  id: number;
  ok: boolean;
  text: string;
}

export interface IDaemonControlServerOptions {
  socketPath: string;
  rushConfiguration: RushConfiguration;
  rushGlobalFolder: RushGlobalFolder;
  terminal: ITerminal;
  /**
   * Runs `fn` with the watch quiesced (paused, in-flight execution aborted, child processes stopped)
   * and the repository lock still held, then resumes the watch. Used for mutating commands.
   */
  runExclusiveAsync: (fn: () => Promise<void>) => Promise<void>;
}

/**
 * EXPERIMENTAL (6d prototype): a control channel that lets a long-lived watch process additionally run
 * Rush commands in-process, under the single repository lock the watch already holds. Read-only commands
 * run directly; mutating commands run via `runExclusiveAsync`, which quiesces the watch first.
 *
 * This is gated behind the `RUSHMCP_DAEMON_SOCKET` environment variable and is the prototype seam for a
 * future first-class `rush daemon` action.
 */
export class DaemonControlServer {
  private readonly _options: IDaemonControlServerOptions;
  private _server: net.Server | undefined;

  public constructor(options: IDaemonControlServerOptions) {
    this._options = options;
  }

  public start(): void {
    const { socketPath, terminal } = this._options;
    // Remove a stale socket file from a previous run.
    FileSystem.deleteFile(socketPath);

    const server: net.Server = net.createServer((socket: net.Socket) => {
      let buffer: string = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let newlineIndex: number = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line: string = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.trim()) {
            void this._handleLineAsync(line, socket);
          }
          newlineIndex = buffer.indexOf('\n');
        }
      });
      socket.on('error', () => {
        /* client disconnected; ignore */
      });
    });

    server.on('error', (error: Error) => {
      terminal.writeErrorLine(`Daemon control server error: ${error.message}`);
    });

    server.listen(socketPath, () => {
      terminal.writeLine(`Daemon control socket listening at ${socketPath}`);
    });

    this._server = server;
  }

  public close(): void {
    if (this._server) {
      this._server.close();
      this._server = undefined;
    }
    FileSystem.deleteFile(this._options.socketPath);
  }

  private async _handleLineAsync(line: string, socket: net.Socket): Promise<void> {
    let request: IControlRequest;
    try {
      request = JSON.parse(line);
    } catch {
      this._reply(socket, { id: 0, ok: false, text: 'Malformed request (expected JSON).' });
      return;
    }

    try {
      const text: string = await this._runCommandAsync(request.command, request.args ?? []);
      this._reply(socket, { id: request.id, ok: true, text });
    } catch (error) {
      this._reply(socket, {
        id: request.id,
        ok: false,
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async _runCommandAsync(command: string, args: string[]): Promise<string> {
    const { rushConfiguration } = this._options;
    switch (command) {
      case 'status': {
        return JSON.stringify({ watching: true, pid: process.pid });
      }
      case 'check': {
        // Read-only; safe to run alongside the watch without quiescing.
        const provider: StringBufferTerminalProvider = new StringBufferTerminalProvider(false);
        const terminal: Terminal = new Terminal(provider);
        VersionMismatchFinder.rushCheck(rushConfiguration, terminal);
        return provider.getOutput() + provider.getErrorOutput();
      }
      case 'install': {
        // Mutating: rewrite node_modules under the held lock, with the watch quiesced.
        const provider: StringBufferTerminalProvider = new StringBufferTerminalProvider(false);
        const terminal: Terminal = new Terminal(provider);
        await this._options.runExclusiveAsync(async () => {
          const { doBasicInstallAsync } = await import('../../logic/installManager/doBasicInstallAsync');
          await doBasicInstallAsync({
            rushConfiguration,
            rushGlobalFolder: this._options.rushGlobalFolder,
            isDebug: false,
            variant: undefined,
            terminal,
            subspace: rushConfiguration.defaultSubspace
          });
        });
        return provider.getOutput() + provider.getErrorOutput() || 'Install completed.';
      }
      default: {
        throw new Error(`Unknown or unsupported command: "${command}"`);
      }
    }
  }

  private _reply(socket: net.Socket, response: IControlResponse): void {
    if (socket.writable) {
      socket.write(JSON.stringify(response) + '\n');
    }
  }
}
