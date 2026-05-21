// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  type BaseTool,
  RushConflictResolverTool,
  RushMigrateProjectTool,
  RushCommandValidatorTool,
  RushWorkspaceDetailsTool,
  RushProjectDetailsTool,
  RushBuildStatusTool,
  RushBuildLogsTool,
  RushRebuildTool,
  RushSetWatchStateTool,
  RushAbortBuildTool,
  RushRunCommandTool,
  RushShutdownHostTool
} from './tools';
import { RushMcpPluginLoader } from './pluginFramework/RushMcpPluginLoader';
import { RushServeClient, getBuildHostConfigFromEnv } from './buildHost/RushServeClient';

export class RushMCPServer extends McpServer {
  private _rushWorkspacePath: string;
  private _tools: BaseTool[] = [];
  private _pluginLoader: RushMcpPluginLoader;
  private _buildHostClient: RushServeClient;

  public constructor(rushWorkspacePath: string) {
    super({
      name: 'rush',
      version: '1.0.0'
    });

    this._rushWorkspacePath = rushWorkspacePath;
    this._pluginLoader = new RushMcpPluginLoader(this._rushWorkspacePath, this);
    this._buildHostClient = new RushServeClient(getBuildHostConfigFromEnv(this._rushWorkspacePath));
  }

  public async startAsync(): Promise<void> {
    this._initializeTools();
    this._registerTools();

    await this._pluginLoader.loadAsync();
  }

  private _initializeTools(): void {
    this._tools.push(new RushConflictResolverTool());
    this._tools.push(new RushMigrateProjectTool(this._rushWorkspacePath));
    this._tools.push(new RushCommandValidatorTool());
    this._tools.push(new RushWorkspaceDetailsTool());
    this._tools.push(new RushProjectDetailsTool());
    this._tools.push(new RushBuildStatusTool(this._buildHostClient));
    this._tools.push(new RushBuildLogsTool(this._buildHostClient));
    this._tools.push(new RushRebuildTool(this._buildHostClient));
    this._tools.push(new RushSetWatchStateTool(this._buildHostClient));
    this._tools.push(new RushAbortBuildTool(this._buildHostClient));
    this._tools.push(new RushRunCommandTool(this._buildHostClient));
    this._tools.push(new RushShutdownHostTool(this._buildHostClient));
  }

  private _registerTools(): void {
    process.chdir(this._rushWorkspacePath);

    for (const tool of this._tools) {
      tool.register(this);
    }
  }
}
