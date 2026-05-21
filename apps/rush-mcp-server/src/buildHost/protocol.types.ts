// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * Wire protocol for the live build status WebSocket exposed by `@rushstack/rush-serve-plugin`.
 *
 * This is a hand-maintained mirror of the subset of `@rushstack/rush-serve-plugin/api` that this
 * MCP server consumes. It is duplicated (rather than imported) to keep `@rushstack/mcp-server` free
 * of a runtime dependency on the serve plugin. Keep it in sync with that package's `api.types.ts`.
 */

/**
 * Human readable status values. These are the PascalCase keys of the `OperationStatus` enumeration.
 */
export type ReadableOperationStatus =
  | 'Waiting'
  | 'Ready'
  | 'Queued'
  | 'Executing'
  | 'Success'
  | 'SuccessWithWarning'
  | 'Skipped'
  | 'FromCache'
  | 'Failure'
  | 'Blocked'
  | 'NoOp'
  | 'Aborted';

/**
 * Relative URLs (rooted at the serve origin) to the log files for an operation.
 */
export interface ILogFileURLs {
  /** The relative URL to the merged (interleaved stdout and stderr) text log. */
  text: string;
  /** The relative URL to the stderr log file. */
  error: string;
  /** The relative URL to the JSONL log file. */
  jsonl: string;
}

/**
 * Information about a single operation in the build graph.
 */
export interface IOperationInfo {
  /** The display name of the operation, e.g. `my-project (build)`. */
  name: string;
  /** The display names of the operation's dependencies. */
  dependencies: string[];
  /** The npm package name of the containing Rush project. */
  packageName: string;
  /** The name of the containing phase, e.g. `_phase:build`. */
  phaseName: string;
  /** If false, this operation is disabled and will report as `Skipped`. */
  enabled: boolean;
  /** If true, this operation is architectural and included only for graph completeness. */
  silent: boolean;
  /** If true, this operation is a no-op and included only for graph completeness. */
  noop: boolean;
  /** The current status of the operation. */
  status: ReadableOperationStatus;
  /** The URLs to the log files, if applicable. */
  logFileURLs: ILogFileURLs | undefined;
  /** The start time of the operation in milliseconds (not wall clock), if started. */
  startTime: number | undefined;
  /** The end time of the operation in milliseconds (not wall clock), if finished. */
  endTime: number | undefined;
}

/**
 * Information about the current Rush session.
 */
export interface IRushSessionInfo {
  /** The name of the command being run, e.g. `start`. */
  actionName: string;
  /** A unique identifier for the repository in which this Rush is running. */
  repositoryIdentifier: string;
}

export interface IWebSocketBeforeExecuteEventMessage {
  event: 'before-execute';
  operations: IOperationInfo[];
}

export interface IWebSocketAfterExecuteEventMessage {
  event: 'after-execute';
  operations: IOperationInfo[];
  status: ReadableOperationStatus;
}

export interface IWebSocketBatchStatusChangeEventMessage {
  event: 'status-change';
  operations: IOperationInfo[];
}

export interface IWebSocketSyncEventMessage {
  event: 'sync';
  operations: IOperationInfo[];
  sessionInfo: IRushSessionInfo;
  status: ReadableOperationStatus;
}

/**
 * The set of possible messages sent from the build host to a connected client.
 */
export type IWebSocketEventMessage =
  | IWebSocketBeforeExecuteEventMessage
  | IWebSocketAfterExecuteEventMessage
  | IWebSocketBatchStatusChangeEventMessage
  | IWebSocketSyncEventMessage;
