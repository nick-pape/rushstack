// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { z } from 'zod';

import type { RushServeClient } from '../buildHost/RushServeClient';
import { CommandRunner, type ICommandResult } from '../utilities/command-runner';
import { BaseTool, type CallToolResult } from './base.tool';

/**
 * The Rush commands this tool is allowed to run. Read-only commands set
 * `safeForSimultaneousRushProcesses` (they skip the repo lock) and run directly. Mutating commands
 * acquire the repo lock and rewrite `node_modules`, so they are coordinated with a running watch.
 */
const ALLOWED_COMMANDS: readonly ['check', 'list', 'install', 'update', 'add', 'remove'] = [
  'check',
  'list',
  'install',
  'update',
  'add',
  'remove'
];

const MUTATING_COMMANDS: ReadonlySet<string> = new Set(['install', 'update', 'add', 'remove']);

/** Mutating commands the daemon's in-process control channel can run (vs. the stop-daemon fallback). */
const DAEMON_INPROCESS_COMMANDS: ReadonlySet<string> = new Set(['install']);

const MAX_OUTPUT_LINES: number = 1000;

interface IRushRunCommandArgs {
  command: (typeof ALLOWED_COMMANDS)[number];
  args?: string[];
}

function trimOutput(text: string): string {
  const lines: string[] = text.split(/\r?\n/);
  if (lines.length <= MAX_OUTPUT_LINES) {
    return text;
  }
  return `... (showing last ${MAX_OUTPUT_LINES} of ${lines.length} lines)\n${lines
    .slice(-MAX_OUTPUT_LINES)
    .join('\n')}`;
}

/**
 * Runs an allowed Rush command in the workspace via the `rush` CLI. Read-only commands (`check`,
 * `list`) are safe alongside a running watch. Mutating commands (`install`, `update`, `add`, `remove`)
 * need the repository lock, so a watch this server started is stopped first (and restarts on the next
 * build query); a watch this server did not start causes the command to be refused.
 */
export class RushRunCommandTool extends BaseTool {
  private readonly _client: RushServeClient;

  public constructor(client: RushServeClient) {
    super({
      name: 'rush_run_command',
      description:
        `Runs an allowed Rush command (${ALLOWED_COMMANDS.join(', ')}) in the workspace and returns ` +
        'its output. Read-only commands (check, list) are safe alongside a running watch. Mutating ' +
        'commands (install, update, add, remove) need the repository lock: if this server started a ' +
        'watch it is stopped first (and restarts on the next build-status query); if a watch this ' +
        'server did not start is running, the command is refused so it cannot conflict.',
      schema: {
        command: z.enum(ALLOWED_COMMANDS).describe('The Rush command to run.'),
        args: z
          .array(z.string())
          .optional()
          .describe('Additional command-line arguments to pass (e.g. ["--to", "my-project"]).')
      }
    });
    this._client = client;
  }

  public async executeAsync({ command, args = [] }: IRushRunCommandArgs): Promise<CallToolResult> {
    // Defense-in-depth: enforce the allowlist in the handler, not only via the input schema.
    if (!(ALLOWED_COMMANDS as readonly string[]).includes(command)) {
      return this._textResult(
        `Command "${command}" is not allowed. Allowed commands: ${ALLOWED_COMMANDS.join(', ')}.`,
        true
      );
    }

    let notice: string = '';
    if (MUTATING_COMMANDS.has(command)) {
      // Preferred path: if the running daemon's watch exposes an in-process control channel and supports
      // this command, run it inside the watch under the lock it already holds (no teardown, watch stays
      // warm). Falls back to stopping the daemon and shelling out otherwise.
      if (DAEMON_INPROCESS_COMMANDS.has(command) && this._client.getControlSocketPath()) {
        const inProcess: { ok: boolean; text: string } = await this._client.sendDaemonCommandAsync(
          command,
          args
        );
        return this._textResult(
          `Ran "rush ${command}" in-process in the build host (watch kept warm, lock never released).\n\n` +
            inProcess.text,
          !inProcess.ok
        );
      }

      const stopped: boolean = await this._client.stopDaemonAsync();
      if (stopped) {
        notice =
          'Stopped the shared build host daemon to free the repository lock; it will restart on the ' +
          'next build-status query.\n\n';
      }
    }

    const result: ICommandResult = await CommandRunner.runRushCommandCaptureAsync([command, ...args]);

    const sections: string[] = [`$ rush ${[command, ...args].join(' ')}`, `(exit code: ${result.status})`];
    if (result.stdout.trim()) {
      sections.push('', '--- stdout ---', trimOutput(result.stdout.trimEnd()));
    }
    if (result.stderr.trim()) {
      sections.push('', '--- stderr ---', trimOutput(result.stderr.trimEnd()));
    }
    if (!result.stdout.trim() && !result.stderr.trim()) {
      sections.push('', '(no output)');
    }

    // If the command bounced off the repo lock, add a hint (e.g. an external watch we never connected to).
    if (
      result.status !== 0 &&
      /Another Rush command is already running/i.test(result.stdout + result.stderr)
    ) {
      sections.push(
        '',
        'Hint: another Rush process holds the repository lock (likely a watch). Stop it and retry.'
      );
    }

    return this._textResult(notice + sections.join('\n'));
  }

  private _textResult(text: string, isError: boolean = false): CallToolResult {
    return { isError, content: [{ type: 'text', text }] };
  }
}
