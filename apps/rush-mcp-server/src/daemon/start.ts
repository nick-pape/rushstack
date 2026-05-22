// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'node:path';

import { getBuildHostConfigFromEnv } from '../buildHost/RushServeClient';
import { BuildHostDaemon } from './BuildHostDaemon';

async function main(): Promise<void> {
  const workspacePath: string = path.resolve(process.argv[2] || process.cwd());
  const config: ReturnType<typeof getBuildHostConfigFromEnv> = getBuildHostConfigFromEnv(workspacePath);

  const daemon: BuildHostDaemon = new BuildHostDaemon({
    workspacePath,
    startCommand: config.startCommand,
    startArgs: config.startArgs,
    webSocketPath: new URL(config.webSocketUrl).pathname,
    startTimeoutMs: config.startTimeoutMs
  });

  await daemon.runAsync();
}

main().catch((error: unknown) => {
  process.stderr.write(`Build host daemon failed: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
