// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { ScopedCommandLineAction } from '../providers/ScopedCommandLineAction';
import { CommandLineStringParameter } from '../parameters/CommandLineStringParameter';
import { CommandLineParser } from '../providers/CommandLineParser';
import { CommandLineParameterProvider } from '../providers/CommandLineParameterProvider';
import { AliasCommandLineAction } from '../providers/AliasCommandLineAction';
import { CommandLineAction } from '../providers/CommandLineAction';
import { CommandLineFlagParameter } from '../parameters/CommandLineFlagParameter';

class TestAliasAction extends AliasCommandLineAction {
  public done: boolean = false;

  public constructor(targetAction: CommandLineAction, defaultArguments?: string[]) {
    super({
      toolFilename: 'example',
      aliasName: 'alias-action',
      defaultArguments,
      targetAction
    });
  }
}

class TestAction extends CommandLineAction {
  public done: boolean = false;
  private _flag!: CommandLineFlagParameter;

  public constructor() {
    super({
      actionName: 'action',
      summary: 'does the action',
      documentation: 'a longer description'
    });
  }

  protected async onExecute(): Promise<void> {
    expect(this._flag.value).toEqual(true);
    this.done = true;
  }

  protected onDefineParameters(): void {
    this._flag = this.defineFlagParameter({
      parameterLongName: '--flag',
      description: 'The flag'
    });
  }
}

class TestScopedAction extends ScopedCommandLineAction {
  public done: boolean = false;
  public scopedValue: string | undefined;
  private _verboseArg!: CommandLineFlagParameter;
  private _scopeArg!: CommandLineStringParameter;
  private _scopedArg: CommandLineStringParameter | undefined;

  public constructor() {
    super({
      actionName: 'scoped-action',
      summary: 'does the scoped action',
      documentation: 'a longer description'
    });
  }

  protected async onExecute(): Promise<void> {
    if (this._scopedArg) {
      expect(this._scopedArg.longName).toBe(`--scoped-${this._scopeArg.value}`);
      this.scopedValue = this._scopedArg.value;
    }
    this.done = true;
  }

  protected onDefineUnscopedParameters(): void {
    this._verboseArg = this.defineFlagParameter({
      parameterLongName: '--verbose',
      description: 'A flag parameter.'
    });

    this._scopeArg = this.defineStringParameter({
      parameterLongName: '--scope',
      parameterGroup: ScopedCommandLineAction.ScopingParameterGroup,
      argumentName: 'SCOPE',
      description: 'The scope'
    });
  }

  protected onDefineScopedParameters(scopedParameterProvider: CommandLineParameterProvider): void {
    if (this._scopeArg.value) {
      this._scopedArg = scopedParameterProvider.defineStringParameter({
        parameterLongName: `--scoped-${this._scopeArg.value}`,
        argumentName: 'SCOPED',
        description: 'The scoped argument.'
      });
    }
  }
}

class TestCommandLine extends CommandLineParser {
  public constructor() {
    super({
      toolFilename: 'example',
      toolDescription: 'An example project'
    });

    this.addAction(new TestAction());
    this.addAction(new TestScopedAction());
  }
}

describe(AliasCommandLineAction.name, () => {
  it('executes the aliased action', async () => {
    const commandLineParser: TestCommandLine = new TestCommandLine();
    const targetAction: TestAction = commandLineParser.actions.find(
      (a) => a.actionName === 'action'
    )! as TestAction;
    const aliasAction: TestAliasAction = new TestAliasAction(targetAction);
    commandLineParser.addAction(aliasAction);

    await commandLineParser.execute(['alias-action', '--flag']);

    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    expect(targetAction.done).toBe(true);
  });

  it('executes the aliased action with provided default arguments', async () => {
    const commandLineParser: TestCommandLine = new TestCommandLine();
    const targetAction: TestAction = commandLineParser.actions.find(
      (a) => a.actionName === 'action'
    )! as TestAction;
    const aliasAction: TestAliasAction = new TestAliasAction(targetAction, ['--flag']);
    commandLineParser.addAction(aliasAction);

    await commandLineParser.execute(['alias-action']);

    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    expect(targetAction.done).toBe(true);
  });

  it('executes the aliased scoped action', async () => {
    const commandLineParser: TestCommandLine = new TestCommandLine();
    const targetAction: TestScopedAction = commandLineParser.actions.find(
      (a) => a.actionName === 'scoped-action'
    )! as TestScopedAction;
    const aliasAction: TestAliasAction = new TestAliasAction(targetAction);
    commandLineParser.addAction(aliasAction);

    await commandLineParser.execute(['alias-action', '--scope', 'foo', '--', '--scoped-foo', 'bar']);

    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    expect(targetAction.done).toBe(true);
    expect(targetAction.scopedValue).toBe('bar');
  });

  it('executes the aliased scoped action with provided default scoping arguments', async () => {
    const commandLineParser: TestCommandLine = new TestCommandLine();
    const targetAction: TestScopedAction = commandLineParser.actions.find(
      (a) => a.actionName === 'scoped-action'
    )! as TestScopedAction;
    const aliasAction: TestAliasAction = new TestAliasAction(targetAction, ['--scope', 'foo', '--']);
    commandLineParser.addAction(aliasAction);

    await commandLineParser.execute(['alias-action', '--scoped-foo', 'bar']);

    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    expect(targetAction.done).toBe(true);
    expect(targetAction.scopedValue).toBe('bar');
  });

  it('prints the action parameter map', async () => {
    const commandLineParser: TestCommandLine = new TestCommandLine();
    const targetAction: TestAction = commandLineParser.actions.find(
      (a) => a.actionName === 'action'
    )! as TestAction;
    const aliasAction: TestAliasAction = new TestAliasAction(targetAction);
    commandLineParser.addAction(aliasAction);

    // Execute the parser in order to populate the parameters
    await commandLineParser.execute(['alias-action', '--flag']);
    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    const selectedAction: TestAliasAction = commandLineParser.selectedAction as TestAliasAction;
    expect(targetAction.done).toBe(true);
    expect(selectedAction.parameters.length).toBe(targetAction.parameters.length);
    const parameterStringMap: Record<string, string> = targetAction.getParameterStringMap();
    expect(parameterStringMap).toMatchSnapshot();
  });

  it('prints the unscoped action parameter map', async () => {
    const commandLineParser: TestCommandLine = new TestCommandLine();
    const targetAction: TestScopedAction = commandLineParser.actions.find(
      (a) => a.actionName === 'scoped-action'
    )! as TestScopedAction;
    const aliasAction: TestAliasAction = new TestAliasAction(targetAction);
    commandLineParser.addAction(aliasAction);

    // Execute the parser in order to populate the parameters
    await commandLineParser.execute(['alias-action', '--verbose']);
    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    const selectedAction: TestAliasAction = commandLineParser.selectedAction as TestAliasAction;
    expect(targetAction.done).toBe(true);
    expect(selectedAction.parameters.length).toBe(targetAction.parameters.length);
    const parameterStringMap: Record<string, string> = targetAction.getParameterStringMap();
    expect(parameterStringMap).toMatchSnapshot();
  });

  it('prints the unscoped action parameter map with provided default arguments', async () => {
    const commandLineParser: TestCommandLine = new TestCommandLine();
    const targetAction: TestScopedAction = commandLineParser.actions.find(
      (a) => a.actionName === 'scoped-action'
    )! as TestScopedAction;
    const aliasAction: TestAliasAction = new TestAliasAction(targetAction, ['--verbose']);
    commandLineParser.addAction(aliasAction);

    // Execute the parser in order to populate the parameters
    await commandLineParser.execute(['alias-action']);
    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    const selectedAction: TestAliasAction = commandLineParser.selectedAction as TestAliasAction;
    expect(targetAction.done).toBe(true);
    expect(selectedAction.parameters.length).toBe(targetAction.parameters.length);
    const parameterStringMap: Record<string, string> = targetAction.getParameterStringMap();
    expect(parameterStringMap).toMatchSnapshot();
  });

  it('prints the scoped action parameter map', async () => {
    let commandLineParser: TestCommandLine = new TestCommandLine();
    let targetAction: TestScopedAction = commandLineParser.actions.find(
      (a) => a.actionName === 'scoped-action'
    )! as TestScopedAction;
    let aliasAction: TestAliasAction = new TestAliasAction(targetAction);
    commandLineParser.addAction(aliasAction);

    // Execute the parser in order to populate the parameters
    await commandLineParser.execute(['alias-action', '--scope', 'foo']);
    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    let selectedAction: TestAliasAction = commandLineParser.selectedAction as TestAliasAction;
    expect(targetAction.done).toBe(true);
    // The alias action only has the 2 unscoped parameters, while the target action has 3 parameters
    // (2 unscoped, 1 scoped)
    expect(selectedAction.parameters.length).toBe(2);
    expect(targetAction.parameters.length).toBe(3);
    let parameterStringMap: Record<string, string> = targetAction.getParameterStringMap();
    expect(parameterStringMap).toMatchSnapshot();

    commandLineParser = new TestCommandLine();
    targetAction = commandLineParser.actions.find(
      (a) => a.actionName === 'scoped-action'
    )! as TestScopedAction;
    aliasAction = new TestAliasAction(targetAction);
    commandLineParser.addAction(aliasAction);

    // Execute the parser in order to populate the parameters
    await commandLineParser.execute(['alias-action', '--scope', 'foo', '--', '--scoped-foo', 'bar']);
    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    selectedAction = commandLineParser.selectedAction as TestAliasAction;
    expect(targetAction.done).toBe(true);
    expect(targetAction.scopedValue).toBe('bar');
    // The alias action only has the 2 unscoped parameters, while the target action has 3 parameters
    // (2 unscoped, 1 scoped)
    expect(selectedAction.parameters.length).toBe(2);
    expect(targetAction.parameters.length).toBe(3);
    parameterStringMap = targetAction.getParameterStringMap();
    expect(parameterStringMap).toMatchSnapshot();
  });

  it('prints the scoped action parameter map with provided default scoping arguments', async () => {
    let commandLineParser: TestCommandLine = new TestCommandLine();
    let targetAction: TestScopedAction = commandLineParser.actions.find(
      (a) => a.actionName === 'scoped-action'
    )! as TestScopedAction;
    let aliasAction: TestAliasAction = new TestAliasAction(targetAction, ['--scope', 'foo', '--']);
    commandLineParser.addAction(aliasAction);

    // Execute the parser in order to populate the parameters
    await commandLineParser.execute(['alias-action']);
    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    let selectedAction: TestAliasAction = commandLineParser.selectedAction as TestAliasAction;
    expect(targetAction.done).toBe(true);
    // The alias action only has the 2 unscoped parameters, while the target action has 3 parameters
    // (2 unscoped, 1 scoped)
    expect(selectedAction.parameters.length).toBe(2);
    expect(targetAction.parameters.length).toBe(3);
    let parameterStringMap: Record<string, string> = targetAction.getParameterStringMap();
    expect(parameterStringMap).toMatchSnapshot();

    commandLineParser = new TestCommandLine();
    targetAction = commandLineParser.actions.find(
      (a) => a.actionName === 'scoped-action'
    )! as TestScopedAction;
    aliasAction = new TestAliasAction(targetAction, ['--scope', 'foo', '--']);
    commandLineParser.addAction(aliasAction);

    // Execute the parser in order to populate the parameters
    await commandLineParser.execute(['alias-action', '--scoped-foo', 'bar']);
    expect(commandLineParser.selectedAction).toBeDefined();
    expect(commandLineParser.selectedAction!.actionName).toEqual('alias-action');
    selectedAction = commandLineParser.selectedAction as TestAliasAction;
    expect(targetAction.done).toBe(true);
    expect(targetAction.scopedValue).toBe('bar');
    // The alias action only has the 2 unscoped parameters, while the target action has 3 parameters
    // (2 unscoped, 1 scoped)
    expect(selectedAction.parameters.length).toBe(2);
    expect(targetAction.parameters.length).toBe(3);
    parameterStringMap = targetAction.getParameterStringMap();
    expect(parameterStringMap).toMatchSnapshot();
  });
});
