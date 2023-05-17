import type * as TTypescript from 'typescript';

export interface ITypescriptWorkerData {
  /**
   * Path to the version of TypeScript to use.
   */
  typeScriptToolPath: string;
}

export interface ITranspilationRequestMessage {
  /**
   * Unique identifier for this request.
   */
  requestId: number;
  /**
   * The tsconfig compiler options to use for the request.
   */
  compilerOptions: TTypescript.CompilerOptions;
  /**
   * The variants to emit.
   */
  moduleKindsToEmit: ICachedEmitModuleKind[];
  /**
   * The set of files to build.
   */
  fileNames: string[];
}

export interface ITranspilationResponseMessage {
  requestId: number;
  result: TTypescript.EmitResult;
}

export interface ICachedEmitModuleKind {
  moduleKind: TTypescript.ModuleKind;

  outFolderPath: string;

  /**
   * File extension to use instead of '.js' for emitted ECMAScript files.
   * For example, '.cjs' to indicate commonjs content, or '.mjs' to indicate ECMAScript modules.
   */
  jsExtensionOverride: string | undefined;

  /**
   * Set to true if this is the emit kind that is specified in the tsconfig.json.
   * Declarations are only emitted for the primary module kind.
   */
  isPrimary: boolean;
}
