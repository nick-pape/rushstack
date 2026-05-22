// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { z } from 'zod';

import type { RushServeClient } from '../buildHost/RushServeClient';
import type { IOperationInfo } from '../buildHost/protocol.types';
import { BaseTool, type CallToolResult } from './base.tool';

interface IRushRebuildArgs {
  project: string;
  phase?: string;
}

/**
 * Forces the running Rush build/watch host to rebuild a project's operations by invalidating them,
 * the same as if their inputs had changed.
 */
export class RushRebuildTool extends BaseTool {
  private readonly _client: RushServeClient;

  public constructor(client: RushServeClient) {
    super({
      name: 'rush_rebuild',
      description:
        'Forces the running Rush build/watch host to rebuild a project (optionally a single phase) by ' +
        'invalidating its operations. Requires a running watch command (e.g. "rush start") with ' +
        '@rushstack/rush-serve-plugin enabled.',
      schema: {
        project: z.string().describe('The npm package name of the project to rebuild.'),
        phase: z
          .string()
          .optional()
          .describe('Limit the rebuild to this phase (e.g. "_phase:build"). Defaults to all phases.')
      }
    });
    this._client = client;
  }

  public async executeAsync({ project, phase }: IRushRebuildArgs): Promise<CallToolResult> {
    await this._client.ensureReadyAsync();
    const operations: IOperationInfo[] = this._client.findOperations({ project, phase });

    if (operations.length === 0) {
      return this._textResult(
        phase
          ? `No operation found for project "${project}" and phase "${phase}".`
          : `No operations found for project "${project}".`
      );
    }

    const operationNames: string[] = operations.map((operation) => operation.name);
    await this._client.sendCommandAsync({ command: 'invalidate', operationNames });

    return this._textResult(
      `Requested rebuild of ${operationNames.length} operation(s):\n` +
        operationNames
          .sort()
          .map((name) => `  ${name}`)
          .join('\n')
    );
  }

  private _textResult(text: string): CallToolResult {
    return { content: [{ type: 'text', text }] };
  }
}
