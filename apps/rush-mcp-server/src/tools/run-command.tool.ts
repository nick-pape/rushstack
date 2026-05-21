// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { z } from 'zod';

import { CommandRunner, type ICommandResult } from '../utilities/command-runner';
import { BaseTool, type CallToolResult } from './base.tool';

/**
 * The Rush commands this tool is allowed to run. Restricted to read-only commands that set
 * `safeForSimultaneousRushProcesses` (they skip the repo lock), so they are safe to run alongside a
 * live `rush start` watch. Mutating commands (install/update/add/remove) are intentionally excluded.
 */
const ALLOWED_COMMANDS: readonly ['check', 'list'] = ['check', 'list'];

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
 * Runs a read-only Rush command in the workspace via the `rush` CLI. Safe to use while a watch is
 * running because the allowed commands do not acquire the repository lock.
 */
export class RushRunCommandTool extends BaseTool {
  public constructor() {
    super({
      name: 'rush_run_command',
      description:
        `Runs a read-only Rush command (one of: ${ALLOWED_COMMANDS.join(', ')}) in the workspace and ` +
        'returns its output. These commands are safe to run alongside a running "rush start" watch ' +
        'because they do not take the repository lock. Mutating commands (install, update, add, remove) ' +
        'are not supported by this tool.',
      schema: {
        command: z
          .enum(ALLOWED_COMMANDS)
          .describe('The Rush command to run. Only read-only commands are allowed.'),
        args: z
          .array(z.string())
          .optional()
          .describe('Additional command-line arguments to pass (e.g. ["--json"]).')
      }
    });
  }

  public async executeAsync({ command, args = [] }: IRushRunCommandArgs): Promise<CallToolResult> {
    // Defense-in-depth: enforce the allowlist in the handler, not only via the input schema, so the
    // tool never runs an arbitrary (e.g. mutating) Rush command even if invoked outside the schema.
    if (!(ALLOWED_COMMANDS as readonly string[]).includes(command)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Command "${command}" is not allowed. Allowed read-only commands: ${ALLOWED_COMMANDS.join(', ')}.`
          }
        ]
      };
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

    return { content: [{ type: 'text', text: sections.join('\n') }] };
  }
}
