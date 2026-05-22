// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { RushServeClient } from '../buildHost/RushServeClient';
import { BaseTool, type CallToolResult } from './base.tool';

/**
 * Stops the shared Rush build/watch host daemon. It restarts automatically the next time build status
 * or logs are requested.
 */
export class RushShutdownHostTool extends BaseTool {
  private readonly _client: RushServeClient;

  public constructor(client: RushServeClient) {
    super({
      name: 'rush_shutdown_host',
      description:
        'Stops the shared Rush build/watch host daemon (if running), releasing the repository lock. It ' +
        'restarts automatically the next time build status or logs are requested.',
      schema: {}
    });
    this._client = client;
  }

  public async executeAsync(): Promise<CallToolResult> {
    const stopped: boolean = await this._client.stopDaemonAsync();
    return {
      content: [
        {
          type: 'text',
          text: stopped ? 'Stopped the shared build host daemon.' : 'No build host daemon was running.'
        }
      ]
    };
  }
}
