// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import type * as TWebpack from 'webpack';
import { FileSystem } from '@rushstack/node-core-library';
import type { IScopedLogger, IHeftTaskSession, HeftConfiguration } from '@rushstack/heft';

import type { IWebpack4PluginOptions } from './Webpack4Plugin';
import type { IWebpackConfiguration } from './shared';

interface ILoadWebpackConfigurationOptions extends IWebpack4PluginOptions {
  taskSession: IHeftTaskSession;
  heftConfiguration: HeftConfiguration;
  webpack: typeof TWebpack;
}

/**
 * See https://webpack.js.org/api/cli/#environment-options
 */
interface IWebpackConfigFunctionEnv {
  prod: boolean;
  production: boolean;

  // Non-standard environment options
  taskSession: IHeftTaskSession;
  heftConfiguration: HeftConfiguration;
  webpack: typeof TWebpack;
}

type IWebpackConfigJsExport =
  | TWebpack.Configuration
  | TWebpack.Configuration[]
  | Promise<TWebpack.Configuration>
  | Promise<TWebpack.Configuration[]>
  | ((env: IWebpackConfigFunctionEnv) => TWebpack.Configuration | TWebpack.Configuration[])
  | ((env: IWebpackConfigFunctionEnv) => Promise<TWebpack.Configuration | TWebpack.Configuration[]>);
type IWebpackConfigJs = IWebpackConfigJsExport | { default: IWebpackConfigJsExport };

const DEFAULT_WEBPACK_CONFIG_PATH: './webpack.config.js' = './webpack.config.js';
const DEFAULT_WEBPACK_DEV_CONFIG_PATH: './webpack.dev.config.js' = './webpack.dev.config.js';

export class WebpackConfigurationLoader {
  private readonly _logger: IScopedLogger;
  private readonly _production: boolean;
  private readonly _serveMode: boolean;

  public constructor(logger: IScopedLogger, production: boolean, serveMode: boolean) {
    this._logger = logger;
    this._production = production;
    this._serveMode = serveMode;
  }

  public async tryLoadWebpackConfigurationAsync(
    options: ILoadWebpackConfigurationOptions
  ): Promise<IWebpackConfiguration | undefined> {
    // TODO: Eventually replace this custom logic with a call to this utility in in webpack-cli:
    // https://github.com/webpack/webpack-cli/blob/next/packages/webpack-cli/lib/groups/ConfigGroup.js

    const {
      taskSession,
      heftConfiguration,
      configurationPath,
      devConfigurationPath,
      webpack
    } = options;
    let webpackConfigJs: IWebpackConfigJs | undefined;

    try {
      const buildFolder: string = heftConfiguration.buildFolder;
      if (this._serveMode) {
        const devConfigPath: string =
          path.resolve(buildFolder, devConfigurationPath || DEFAULT_WEBPACK_DEV_CONFIG_PATH);
        this._logger.terminal.writeVerboseLine(
          `Attempting to load webpack configuration from "${devConfigPath}".`
        );
        webpackConfigJs = await this._tryLoadWebpackConfigurationInnerAsync(devConfigPath);
      }

      if (!webpackConfigJs) {
        const configPath: string =
          path.resolve(buildFolder, configurationPath || DEFAULT_WEBPACK_CONFIG_PATH);
        this._logger.terminal.writeVerboseLine(
          `Attempting to load webpack configuration from "${configPath}".`
        );
        webpackConfigJs = await this._tryLoadWebpackConfigurationInnerAsync(configPath);
      }
    } catch (error) {
      this._logger.emitError(error as Error);
    }

    if (webpackConfigJs) {
      const webpackConfig: IWebpackConfigJsExport =
        (webpackConfigJs as { default: IWebpackConfigJsExport }).default || webpackConfigJs;

      if (typeof webpackConfig === 'function') {
        return webpackConfig({
          prod: this._production,
          production: this._production,
          taskSession,
          heftConfiguration,
          webpack
        });
      } else {
        return webpackConfig;
      }
    } else {
      return undefined;
    }
  }

  private async _tryLoadWebpackConfigurationInnerAsync(
    configurationPath: string
  ): Promise<IWebpackConfigJs | undefined> {
    const configExists: boolean = await FileSystem.existsAsync(configurationPath);
    if (configExists) {
      try {
        return await import(configurationPath);
      } catch (e) {
        throw new Error(`Error loading webpack configuration at "${configurationPath}": ${e}`);
      }
    } else {
      return undefined;
    }
  }
}
