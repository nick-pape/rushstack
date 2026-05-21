// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'node:path';

import { FileSystem, JsonFile } from '@rushstack/node-core-library';

/**
 * Written by the build-host daemon when it begins serving, so that any MCP client can discover and
 * attach to the shared watch. Lives in `common/temp` (git-ignored).
 */
export interface IBuildHostDiscovery {
  /** The WebSocket URL the shared watch is served on, e.g. `wss://localhost:43635/`. */
  webSocketUrl: string;
  /** The PID of the daemon process that owns the watch. Used to detect a stale discovery file. */
  daemonPid: number;
  /** ISO timestamp of when the daemon started serving. */
  startedAt: string;
  /**
   * The unix socket path of the watch's in-process control channel, if the watch was started with one
   * (rush-lib `RUSHMCP_DAEMON_SOCKET`). When present, mutating commands can run in-process in the watch
   * instead of stopping the daemon.
   */
  controlSocketPath?: string;
}

const DISCOVERY_RELATIVE_PATH: string = 'common/temp/rushmcp-build-host.json';

export function getDiscoveryFilePath(workspacePath: string): string {
  return path.join(workspacePath, DISCOVERY_RELATIVE_PATH);
}

/**
 * Returns true if a process with the given PID exists.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't send a signal; it only checks for the existence of the process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads the discovery file, returning `undefined` if it is missing, malformed, or stale (the daemon
 * process it points to is no longer running).
 */
export function readDiscovery(workspacePath: string): IBuildHostDiscovery | undefined {
  let info: IBuildHostDiscovery;
  try {
    info = JsonFile.load(getDiscoveryFilePath(workspacePath));
  } catch {
    return undefined;
  }
  if (typeof info?.webSocketUrl !== 'string' || typeof info?.daemonPid !== 'number') {
    return undefined;
  }
  if (!isProcessAlive(info.daemonPid)) {
    return undefined;
  }
  return info;
}

export function writeDiscovery(workspacePath: string, info: IBuildHostDiscovery): void {
  JsonFile.save(info, getDiscoveryFilePath(workspacePath), { ensureFolderExists: true });
}

export function clearDiscovery(workspacePath: string): void {
  // FileSystem.deleteFile is a no-op if the file does not exist.
  FileSystem.deleteFile(getDiscoveryFilePath(workspacePath));
}
