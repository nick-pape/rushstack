// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { z } from 'zod';

import type { IBuildStatusSnapshot, RushServeClient } from '../buildHost/RushServeClient';
import type { IOperationInfo, ReadableOperationStatus } from '../buildHost/protocol.types';
import { BaseTool, type CallToolResult } from './base.tool';

/**
 * Statuses that represent a finished operation that does NOT need attention. Everything else
 * (failures, warnings, and in-progress work) is surfaced by default to keep the output compact.
 */
const SETTLED_OK_STATUSES: ReadonlySet<ReadableOperationStatus> = new Set<ReadableOperationStatus>([
  'Success',
  'FromCache',
  'Skipped',
  'NoOp'
]);

interface IRushBuildStatusArgs {
  project?: string;
  includeAll?: boolean;
}

/**
 * Reports the live status of the running Rush build host (`rush start` + `@rushstack/rush-serve-plugin`)
 * without the agent needing to run `rush` or read raw build output.
 */
export class RushBuildStatusTool extends BaseTool {
  private readonly _client: RushServeClient;

  public constructor(client: RushServeClient) {
    super({
      name: 'rush_build_status',
      description:
        'Reports the current status of the running Rush build/watch host. By default it returns a ' +
        'compact summary plus only the operations that are failing, warning, or in progress. Requires ' +
        'a running watch command (e.g. "rush start") with @rushstack/rush-serve-plugin enabled.',
      schema: {
        project: z
          .string()
          .optional()
          .describe('Only report operations for this project (npm package name).'),
        includeAll: z
          .boolean()
          .optional()
          .describe('Include all operations, not just those failing, warning, or in progress.')
      }
    });
    this._client = client;
  }

  public async executeAsync({ project, includeAll }: IRushBuildStatusArgs): Promise<CallToolResult> {
    await this._client.ensureReadyAsync();
    const snapshot: IBuildStatusSnapshot = this._client.getSnapshot();

    let operations: IOperationInfo[] = snapshot.operations.filter((op) => !op.silent);
    if (project) {
      operations = operations.filter((op) => op.packageName === project);
    }

    const counts: Map<ReadableOperationStatus, number> = new Map();
    for (const op of operations) {
      counts.set(op.status, (counts.get(op.status) ?? 0) + 1);
    }

    const shown: IOperationInfo[] = includeAll
      ? operations
      : operations.filter((op) => !SETTLED_OK_STATUSES.has(op.status));

    const lines: string[] = [];
    const { sessionInfo } = snapshot;
    if (sessionInfo) {
      lines.push(`Build host: ${sessionInfo.repositoryIdentifier} (command "${sessionInfo.actionName}")`);
    }
    lines.push(`Overall status: ${snapshot.overallStatus}`);
    if (project) {
      lines.push(`Filtered to project: ${project}`);
    }

    const countSummary: string = Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([status, count]) => `${status}: ${count}`)
      .join(', ');
    lines.push(`Operations (${operations.length} total): ${countSummary || 'none'}`);
    lines.push('');

    if (operations.length === 0) {
      lines.push(project ? `No operations found for project "${project}".` : 'No operations found.');
    } else if (shown.length === 0) {
      lines.push('All operations are settled successfully. Pass includeAll=true to list them.');
    } else {
      lines.push(
        includeAll
          ? `All ${shown.length} operation(s):`
          : `${shown.length} operation(s) failing, warning, or in progress:`
      );
      for (const op of [...shown].sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`  [${op.status}] ${op.name}${formatDuration(op)}`);
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }]
    };
  }
}

function formatDuration(op: IOperationInfo): string {
  // startTime/endTime are not wall-clock times, so only a completed operation yields a meaningful duration.
  if (op.startTime === undefined || op.endTime === undefined) {
    return '';
  }
  const seconds: number = Math.max(0, (op.endTime - op.startTime) / 1000);
  return ` (${seconds.toFixed(1)}s)`;
}
