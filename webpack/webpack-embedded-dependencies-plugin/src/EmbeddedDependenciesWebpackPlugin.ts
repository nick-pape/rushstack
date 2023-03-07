import path from 'path';
import { sources, Compilation, WebpackError } from 'webpack';
import { Async, Sort, LegacyAdapters, FileSystem } from '@rushstack/node-core-library';
import { LICENSE_FILES_REGEXP, COPYRIGHT_REGEX } from './regexpUtils';

import type { Compiler, WebpackPluginInstance } from 'webpack';
import type { IPackageJson } from '@rushstack/node-core-library';

const PLUGIN_NAME: 'EmbeddedDependenciesWebpackPlugin' = 'EmbeddedDependenciesWebpackPlugin';
const PLUGIN_ERROR_PREFIX: string = '[embedded-dependencies-webpack-plugin]';
const DEFAULT_GENERATED_LICENSE_FILE_NAME: 'THIRD-PARTY-NOTICES.html' = 'THIRD-PARTY-NOTICES.html';
const DEFAULT_EMBEDDED_DEPENDENCIES_FILE_NAME: 'embedded-dependencies.json' = 'embedded-dependencies.json';
const DEFAULT_PACKAGE_FILTER_FUNCTION: (packageJson: IPackageData, filePath: string) => boolean = () => true;

interface IEmbeddedDependenciesFile {
  name?: string;
  version?: string;
  embeddedDependencies: IPackageData[];
}

interface IResourceResolveData {
  descriptionFileData?: IPackageData;
  descriptionFileRoot?: string;
  relativePath?: string;
}

interface IWebpackModuleCreateData {
  resourceResolveData?: IResourceResolveData;
}

/**
 * @beta
 * Data type for a package.json file. This is a superset of the full package.json file and includes additional fields
 * that are generated by the plugin, including licenseSource, licenses, copyright, and author.
 */
export interface IPackageData extends IPackageJson {
  /**
   * A small string subset which is used for copyright extraction from a licenseSource file.
   */
  copyright: string | undefined;
  /**
   * The author of the package. This is a superset of the full package.json author field.
   * Grabs either the author field or author.name field from package.json.
   */
  author?: string | { name?: string };
  /**
   * Additional license metadata if present. May contain information about a project which has multiple licenses.
   */
  licenses?: { type: string; url: string }[];

  /**
   * The source of the license file itself used for generating THIRD-PARTY-NOTICES.html or custom license files.
   */
  licenseSource?: string;
}

/**
 * @beta
 * Plugin options for EmbeddedDependenciesWebpackPlugin
 *
 * @param outputFileName - Name of the file to be generated. Defaults to embedded-dependencies.json
 * @param generateLicenseFile - Whether to generate a license file. Defaults to false and will only generate the embedded-dependencies.json file
 * @param generateLicenseFileFunction - Function that generates the license file. Defaults to the plugin's internal default generator function but allows you to override it
 * @param generatedLicenseFilename - Name of the generated license file. Defaults to THIRD-PARTY-NOTICES.html
 *
 * @example
 * ```ts
 * // webpack.config.js
 * plugins: [
 *  new EmbeddedDependenciesWebpackPlugin({
 *    outputFileName: 'custom-file-name.json',
 *    generateLicenseFile: true,
 *    generateLicenseFileFunction: (packages: IPackageData[]) => {
 *      return packages
 *        .map((pkg) => {
 *      return `<h2>${pkg.name}</h2><p>${pkg.license}</p>`;
 *     }).join('');
 *    },
 *  generatedLicenseFilename: 'custom-license-file-name.html'
 *  })
 * ]
 * ```
 */
export interface IEmbeddedDependenciesWebpackPluginOptions {
  /**
   * Name of the file to be generated. Defaults to embedded-dependencies.json
   */
  outputFileName?: string;
  /**
   * Whether to generate a license file. Defaults to false and will only generate the embedded-dependencies.json file
   */
  generateLicenseFile?: boolean;
  /**
   * Function that generates the license file. Defaults to the plugin's internal default generator function but allows you to override it
   */
  generateLicenseFileFunction?: LicenseFileGeneratorFunction;
  /**
   * Name of the generated license file. Defaults to THIRD-PARTY-NOTICES.html
   */
  generatedLicenseFilename?: LicenseFileName;

  /**
   * Predicate function that determines whether a package should be included in the embedded
   * dependencies file or the generated license file.
   */
  packageFilterPredicate?: (packageJson: IPackageData, filePath: string) => boolean;
}

/**
 * @beta
 * Function type that generates the license file.
 *
 * @example
 * ```ts
 * const licenseFileGenerator: LicenseFileGeneratorFunction = (packages: IPackageData[]): string => {
 *  return packages
 *   .map((pkg) => {
 *    return `<h2>${pkg.name}</h2><p>${pkg.license}</p>`;
 *  }).join('');
 * }
 * ```
 */
export type LicenseFileGeneratorFunction = (packages: IPackageData[]) => string;

/**
 * @beta
 * Loose string type that represents the name of the generated license file.
 *
 * @example
 * ```ts
 * const licenseFileName: LicenseFileName = 'custom-license-file-name.html';
 * const licenseMarkdownFileName: LicenseFileName = 'custom-license-file-name.md';
 * const licenseTextFileName: LicenseFileName = 'custom-license-file-name.txt';
 * ```
 */
export type LicenseFileName = `${string}.${'html' | 'md' | 'txt'}`;

type PackageNameAndVersion = `${string}@${string}`;
type ThirdPartyPackageMap = Map<
  PackageNameAndVersion,
  { packageFolderPath: string; packageJsonData: IPackageData }
>;
type DefaultLicenseTemplate = `<hr />${string}<br /><br />${string}`;

/**
 * @beta
 * Webpack plugin that generates a file with the list of embedded dependencies
 * and their licenses.
 */
export default class EmbeddedDependenciesWebpackPlugin implements WebpackPluginInstance {
  private readonly _outputFileName: string;
  private readonly _generateLicenseFile: boolean;
  private readonly _generateLicenseFileFunction: LicenseFileGeneratorFunction;
  private readonly _generatedLicenseFilename: LicenseFileName;
  private readonly _packageFilterFunction: (packageJson: IPackageData, filePath: string) => boolean;

  public constructor(options?: IEmbeddedDependenciesWebpackPluginOptions) {
    this._outputFileName = options?.outputFileName || DEFAULT_EMBEDDED_DEPENDENCIES_FILE_NAME;
    this._generateLicenseFile = options?.generateLicenseFile || false;
    this._generateLicenseFileFunction =
      options?.generateLicenseFileFunction || this._defaultLicenseFileGenerator;
    this._generatedLicenseFilename = options?.generatedLicenseFilename || DEFAULT_GENERATED_LICENSE_FILE_NAME;
    this._packageFilterFunction = options?.packageFilterPredicate || DEFAULT_PACKAGE_FILTER_FUNCTION;
  }

  /**
   * @beta
   * Webpack plugin apply method. This method is called by the webpack compiler to apply the plugin, however it not usually
   * needed to be invoked manually by the developer in a webpack configuration. However, if you are calling this plugin (applying it from another plugin)
   * you can call `plugin.apply(compiler)` to apply the plugin and invoke it.
   * @param compiler - The webpack compiler instance.
   */
  public apply(compiler: Compiler): void {
    // Tap into compilation so we can tap into compilation.hooks.processAssets
    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation, { normalModuleFactory }) => {
      const thirdPartyPackages: ThirdPartyPackageMap = new Map();

      normalModuleFactory.hooks.module.tap(
        PLUGIN_NAME,
        (module, moduleCreateData: IWebpackModuleCreateData, resolveData) => {
          const { resourceResolveData } = moduleCreateData;
          const pkg: IPackageData | undefined = resourceResolveData?.descriptionFileData;
          const filePath: string | undefined = resourceResolveData?.descriptionFileRoot;

          if (
            pkg &&
            filePath &&
            this._packageFilterFunction(pkg, filePath) &&
            filePath?.includes('node_modules')
          ) {
            const key: PackageNameAndVersion = makePackageMapKeyForPackage(pkg);
            thirdPartyPackages.set(key, { packageFolderPath: filePath, packageJsonData: pkg });
          }

          return module;
        }
      );

      compilation.hooks.processAssets.tapPromise(
        { name: PLUGIN_NAME, stage: Compilation.PROCESS_ASSETS_STAGE_REPORT },
        async (assets) => {
          const packages: IPackageData[] = [];

          try {
            await Async.forEachAsync(
              thirdPartyPackages,
              async ([, { packageFolderPath: dir, packageJsonData: data }]) => {
                const { name, version } = data;
                let licenseSource: string | undefined;
                const license: string | undefined = parseLicense(data);
                const licensePath: string | undefined = await this._getLicenseFilePathAsync(dir, compiler);
                if (licensePath) {
                  licenseSource = await FileSystem.readFileAsync(licensePath);

                  const copyright: string | undefined =
                    this._parseCopyright(licenseSource) || parsePackageAuthor(data);

                  packages.push({
                    name,
                    version,
                    license,
                    licenseSource,
                    copyright
                  });
                } else {
                  // If there is no license file path, we still should populate the other required fields
                  const copyright: string | undefined = parsePackageAuthor(data);

                  packages.push({
                    name,
                    version,
                    license,
                    copyright
                  });
                }
              }
            );
          } catch (error) {
            this._emitWebpackError(compilation, 'Failed to process embedded dependencies', error);
          } finally {
            Sort.sortBy(packages, (pkg) => pkg.name);
          }

          const dataToStringify: IEmbeddedDependenciesFile = {
            embeddedDependencies: packages
          };

          compilation.emitAsset(this._outputFileName, new sources.RawSource(JSON.stringify(dataToStringify)));

          if (this._generateLicenseFile) {
            // We should try catch here because generator function can be output from user config
            try {
              compilation.emitAsset(
                this._generatedLicenseFilename,
                new sources.RawSource(this._generateLicenseFileFunction(packages))
              );
            } catch (error: unknown) {
              this._emitWebpackError(compilation, 'Failed to generate license file', error);
            }
          }

          return;
        }
      );
    });
  }

  /**
   * Default error handler for try/catch blocks in the plugin
   * try/catches emit errors of type `unknown` and we need to handle them based on what
   * type the error is. This function provides a convenient way to handle errors and then
   * propagate them to webpack as WebpackError objects on `compilation.errors` array.
   *
   * @remarks
   * _If we need to push errors to `compilation.warnings` array, we should just create a companion function
   * that does the same thing but pushes to `compilation.warnings` array instead._
   *
   * @example
   * ```typescript
   * try {
   *   // do some operation
   *   FileSystem.readFile('some-file');
   * } catch (error: unknown) {
   *   this._emitWebpackError(compilation, 'Failed to do some operation', error);
   * }
   * ```
   */
  private _emitWebpackError(compilation: Compilation, errorMessage: string, error: unknown): void {
    let emittedError: WebpackError;
    // If the error is a string, we can just emit it as is with message prefix and error message
    if (typeof error === 'string') {
      emittedError = new WebpackError(`${PLUGIN_ERROR_PREFIX}: ${errorMessage}: ${error}`);
      // If error is an instance of Error, we can emit it with message prefix, error message and stack trace
    } else if (error instanceof Error) {
      emittedError = new WebpackError(
        `${PLUGIN_ERROR_PREFIX}: ${errorMessage}: ${error.message}\n${error.stack || ''}`
      );
      // If error is not a string or an instance of Error, we can emit it with message prefix and error message and JSON.stringify it
    } else {
      emittedError = new WebpackError(
        `${PLUGIN_ERROR_PREFIX}: ${errorMessage}: ${JSON.stringify(error || '')}`
      );
    }

    compilation.errors.push(emittedError);
  }

  /**
   * Searches a third party package directory for a license file.
   */
  private async _getLicenseFilePathAsync(
    modulePath: string,
    compiler: Compiler
  ): Promise<string | undefined> {
    type InputFileSystemReadDirResults = Parameters<
      Parameters<typeof compiler.inputFileSystem.readdir>[1]
    >[1];

    // TODO: Real fs.readdir can take an arguement ({ withFileTypes: true }) which will filter out directories for better performance
    //       and return a list of Dirent objects. Currently the webpack types are hand generated for fs.readdir so
    //       we can't use this feature yet, or we would have to cast the types of inputFileSystem.readdir.
    //       https://github.com/webpack/webpack/issues/16780 tracks this issue.
    const files: InputFileSystemReadDirResults = await LegacyAdapters.convertCallbackToPromise(
      compiler.inputFileSystem.readdir,
      modulePath
    );

    return files
      ?.map((file) => file.toString())
      .filter((file) => LICENSE_FILES_REGEXP.test(file))
      .map((file) => path.join(modulePath, file))[0]; // Grabbing the first license file if multiple are found
  }

  /**
   * Given a module path, try to parse the module's copyright attribution.
   */
  private _parseCopyright(licenseSource: string): string | undefined {
    const match: RegExpMatchArray | null = licenseSource.match(COPYRIGHT_REGEX);

    if (match) {
      return match[0];
    }

    return undefined;
  }

  private _defaultLicenseFileGenerator(packages: IPackageData[]): string {
    const licenseContent = (pkg: IPackageData): string =>
      pkg.licenseSource || pkg.copyright || 'License or Copyright not found';

    const licenseTemplateForPackage = (pkg: IPackageData): DefaultLicenseTemplate => {
      return `<hr />${pkg.name} - ${pkg.version}<br /><br />${licenseContent(pkg)}`;
    };

    return packages.map(licenseTemplateForPackage).join('\n');
  }
}

function makePackageMapKeyForPackage(pkg: IPackageData): PackageNameAndVersion {
  return `${pkg.name}@${pkg.version}`;
}

/**
 * Returns the license type
 */
function parseLicense(packageData: IPackageData): string | undefined {
  if (packageData.license) {
    return packageData.license;
  } else if (typeof packageData.licenses === 'string') {
    return packageData.licenses;
  } else if (packageData.licenses?.length) {
    return packageData.licenses.length === 1
      ? packageData.licenses[0].type
      : `(${packageData.licenses
          .map((license: { type: string; url: string }) => license.type)
          .join(' OR ')})`;
  }

  return undefined;
}

function parsePackageAuthor(p: IPackageData): string | undefined {
  return typeof p.author === 'string' ? p.author : p.author?.name;
}
