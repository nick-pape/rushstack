// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { z } from 'zod';

import type { RushServeClient } from '../buildHost/RushServeClient';
import type { IOperationInfo } from '../buildHost/protocol.types';
import { BaseTool, type CallToolResult } from './base.tool';

const DEFAULT_TAIL_LINES: number = 200;

interface IRushBuildLogsArgs {
  project: string;
  phase?: string;
  errorsOnly?: boolean;
  tailLines?: number;
}

/**
 * Fetches the build log for a project's operation from the running Rush build host, trimmed to the
 * tail (and optionally to stderr only) so an agent can inspect failures without ingesting whole logs.
 */
export class RushBuildLogsTool extends BaseTool {
  private readonly _client: RushServeClient;

  public constructor(client: RushServeClient) {
    super({
      name: 'rush_build_logs',
      description:
        "Returns the build log for a project's operation from the running Rush build/watch host, " +
        'trimmed to the last N lines and optionally to errors only. Requires a running watch command ' +
        '(e.g. "rush start") with @rushstack/rush-serve-plugin enabled.',
      schema: {
        project: z.string().describe('The npm package name of the project.'),
        phase: z
          .string()
          .optional()
          .describe('The phase name (e.g. "_phase:build"). Required if the project has multiple phases.'),
        errorsOnly: z
          .boolean()
          .optional()
          .describe('Return only the stderr log instead of the merged stdout+stderr log.'),
        tailLines: z
          .number()
          .optional()
          .describe(`Return only the last N lines (default ${DEFAULT_TAIL_LINES}).`)
      }
    });
    this._client = client;
  }

  public async executeAsync({
    project,
    phase,
    errorsOnly,
    tailLines
  }: IRushBuildLogsArgs): Promise<CallToolResult> {
    await this._client.ensureReadyAsync();
    const operations: IOperationInfo[] = this._client.getSnapshot().operations;

    let matches: IOperationInfo[] = operations.filter((op) => op.packageName === project);
    if (phase) {
      matches = matches.filter((op) => op.phaseName === phase);
    }

    if (matches.length === 0) {
      return this._textResult(
        phase
          ? `No operation found for project "${project}" and phase "${phase}".`
          : `No operations found for project "${project}".`
      );
    }

    if (matches.length > 1) {
      const phases: string[] = matches.map((op) => op.phaseName).sort();
      return this._textResult(
        `Project "${project}" has multiple phases. Specify one via the "phase" argument:\n` +
          phases.map((name) => `  ${name}`).join('\n')
      );
    }

    const operation: IOperationInfo = matches[0];
    if (!operation.logFileURLs) {
      return this._textResult(
        `No logs are available for ${operation.name} (status: ${operation.status}). ` +
          `It may not have run yet, or may be a no-op.`
      );
    }

    const relativeUrl: string = errorsOnly ? operation.logFileURLs.error : operation.logFileURLs.text;
    const rawLog: string | undefined = await this._client.fetchLogTextAsync(relativeUrl);

    if (rawLog === undefined) {
      return this._textResult(
        `No ${errorsOnly ? 'stderr' : 'merged'} log file found for ${operation.name} ` +
          `(status: ${operation.status}). It may have produced no ${errorsOnly ? 'errors' : 'output'}.`
      );
    }

    const limit: number = tailLines ?? DEFAULT_TAIL_LINES;
    const allLines: string[] = rawLog.split(/\r?\n/);
    const truncated: boolean = allLines.length > limit;
    const shownLines: string[] = truncated ? allLines.slice(-limit) : allLines;

    const header: string =
      `Log for ${operation.name} (status: ${operation.status}, ${errorsOnly ? 'stderr only' : 'merged'})` +
      (truncated ? `, showing last ${limit} of ${allLines.length} lines` : '');

    return this._textResult(`${header}\n\n${shownLines.join('\n')}`);
  }

  private _textResult(text: string): CallToolResult {
    return {
      content: [{ type: 'text', text }]
    };
  }
}
