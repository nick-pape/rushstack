// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { z } from 'zod';

import type { RushServeClient } from '../buildHost/RushServeClient';
import type { IOperationInfo, OperationEnabledState } from '../buildHost/protocol.types';
import { BaseTool, type CallToolResult } from './base.tool';

interface IRushSetWatchStateArgs {
  project: string;
  state: OperationEnabledState;
  phase?: string;
}

/**
 * Turns watching/building on or off for a project's operations in the running Rush build/watch host
 * by setting their enabled state. Takes effect on the next watch iteration.
 */
export class RushSetWatchStateTool extends BaseTool {
  private readonly _client: RushServeClient;

  public constructor(client: RushServeClient) {
    super({
      name: 'rush_set_watch_state',
      description:
        "Controls whether the running Rush build/watch host rebuilds a project's operations when changes " +
        'occur. Use "never" to stop building a project, "default" to restore normal behavior. Takes effect ' +
        'on the next watch iteration. Requires a running watch command (e.g. "rush start") with ' +
        '@rushstack/rush-serve-plugin enabled.',
      schema: {
        project: z.string().describe('The npm package name of the project.'),
        state: z
          .enum(['never', 'changed', 'affected', 'default'])
          .describe(
            'never = never build; changed = build only when this project itself changes; ' +
              'affected = always build when reached; default = restore original behavior.'
          ),
        phase: z
          .string()
          .optional()
          .describe('Limit the change to this phase (e.g. "_phase:build"). Defaults to all phases.')
      }
    });
    this._client = client;
  }

  public async executeAsync({ project, state, phase }: IRushSetWatchStateArgs): Promise<CallToolResult> {
    await this._client.ensureReadyAsync();
    const operations: IOperationInfo[] = this._client.findOperations({ project, phase });

    if (operations.length === 0) {
      return this._textResult(
        phase
          ? `No operation found for project "${project}" and phase "${phase}".`
          : `No operations found for project "${project}".`
      );
    }

    const enabledStateByOperationName: Record<string, OperationEnabledState> = {};
    for (const operation of operations) {
      enabledStateByOperationName[operation.name] = state;
    }

    await this._client.sendCommandAsync({ command: 'set-enabled-states', enabledStateByOperationName });

    const names: string[] = Object.keys(enabledStateByOperationName).sort();
    return this._textResult(
      `Set watch state to "${state}" for ${names.length} operation(s) (effective next watch iteration):\n` +
        names.map((name) => `  ${name}`).join('\n')
    );
  }

  private _textResult(text: string): CallToolResult {
    return { content: [{ type: 'text', text }] };
  }
}
