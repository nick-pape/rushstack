// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { RushServeClient } from '../buildHost/RushServeClient';
import { BaseTool, type CallToolResult } from './base.tool';

/**
 * Aborts the current execution pass of the running Rush build/watch host.
 */
export class RushAbortBuildTool extends BaseTool {
  private readonly _client: RushServeClient;

  public constructor(client: RushServeClient) {
    super({
      name: 'rush_abort_build',
      description:
        'Aborts the current execution pass of the running Rush build/watch host. Operations already ' +
        'started will finish; queued operations are cancelled. Requires a running watch command ' +
        '(e.g. "rush start") with @rushstack/rush-serve-plugin enabled.',
      schema: {}
    });
    this._client = client;
  }

  public async executeAsync(): Promise<CallToolResult> {
    await this._client.sendCommandAsync({ command: 'abort-execution' });
    return {
      content: [
        {
          type: 'text',
          text: 'Sent abort request. Operations already started will finish; queued operations are cancelled.'
        }
      ]
    };
  }
}
