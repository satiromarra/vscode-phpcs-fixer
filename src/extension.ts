/**
 * This file is part of the vscode-php-cs-fixer distribution.
 * Copyright (c) Satiro Marra.
 *
 * vscode-php-cs-fixer is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, version 3.
 *
 * vscode-php-cs-fixer is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import {
  WorkspaceConfiguration,
  workspace,
  commands,
  TextDocument,
  window,
  ExtensionContext,
  ConfigurationChangeEvent,
  TextEditor,
  Disposable,
  languages,
  Range,
  Position,
  TextEdit
} from 'vscode';
import { spawn } from 'child_process';
import { existsSync, writeFileSync, unlink, readFileSync } from 'fs';
import { isAbsolute } from 'path';
import { homedir, tmpdir } from 'os'

interface Config extends WorkspaceConfiguration {
  execPath?: string;
  rules?: string | object;
  config?: string;
  onsave?: boolean;
}

class PHPCSFIXER {
  private isReloadingConfig: Boolean = false;
  private isDeactivating: Boolean = false;
  private isFixing: Boolean = false;
  private config: Config;
  private fixOnSave: Disposable;
  private realExecPath: string;
  private execPath: string;

  private readConfig() {
    if (this.isReloadingConfig) {
      return;
    }
    this.isReloadingConfig = true;
    try {
      this.config = workspace.getConfiguration("phpcsfixer") || <any>{};
    } catch (error) {
      console.error(error);
      this.isReloadingConfig = false;
      return;
    } finally {
      console.log("finally")
    }
    if (this.config.onsave && !this.fixOnSave) {
      this.fixOnSave = workspace.onDidSaveTextDocument(document => {
        this.onDidSaveTextDocument(document);
      });
    } else if (!this.config.onsave && this.fixOnSave) {
      this.fixOnSave.dispose();
      this.fixOnSave = undefined;
    }
    this.execPath = (this.config.execPath || (process.platform === "win32" ? 'php-cs-fixer.bat' : 'php-cs-fixer'))
      .replace('${extensionPath}', __dirname)
      .replace(/^~\//, homedir() + '/')
    this.isReloadingConfig = false;
    return;
  }

  public constructor() {
    this.initialize();
  }

  public async initialize() {
    this.readConfig();
  }

  public async onDidChangeConfiguration() {
    this.readConfig();
  }

  public getActiveWorkspacePath() {
    let f = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri)
    if (f != undefined) {
      return f.uri.fsPath
    }
    return
  }
  public registerDocumentProvider(document, options): Promise<TextEdit[]> {
    return new Promise((resolve, reject) => {
      let oText = document.getText()
      let lLine = document.lineAt(document.lineCount - 1)
      let range = new Range(new Position(0, 0), lLine.range.end)

      this.fixDocument(oText).then((text: string) => {
        if (text != oText) {
          resolve([new TextEdit(range, text)])
        } else {
          resolve([])
        }
      }).catch(err => {
        console.log(err)
        reject(err)
      })
    });
  }
  public getArgs() {
    let args = ['fix', '--using-cache=no', '--path-mode=override', '-vv'];
    let rootPath = this.getActiveWorkspacePath()
    let cFiles = this.config.config.split(';').filter(f => '' !== f).map(f => f.replace(/^~\//, homedir() + '/'))
    let searchPaths = []
    const files = []
    let useConfig = false;
    this.realExecPath = undefined
    if (workspace.workspaceFolders != undefined) {
      this.realExecPath = this.execPath.replace(/^\$\{workspace(Root|Folder)\}/, rootPath || workspace.workspaceFolders[0].uri.fsPath)
    }
    if (rootPath !== undefined) {
      searchPaths = ['.vscode', ''].map(f => rootPath + '/' + (f ? f + '/' : ''))
    }
    for (const file of cFiles) {
      if (isAbsolute(file)) {
        files.push(file)
      } else if (searchPaths.length > 0) {
        for (const searchPath of searchPaths) {
          files.push(searchPath + file)
        }
      }
    }
    for (let i = 0, len = files.length; i < len; i++) {
      if (existsSync(files[i])) {
        args.push('--config=' + files[i])
        useConfig = true
        break
      }
    }
    if (!useConfig && this.config.rules) {
      if (typeof (this.config.rules) == 'object') {
        args.push('--rules=' + JSON.stringify(this.config.rules))
      } else {
        args.push('--rules=' + this.config.rules)
      }
    }
    return args
  }

  public async fixDocument(text: string): Promise<string> {
    if (this.isFixing) {
      return
    }
    this.isFixing = true
    const filePath = tmpdir() + window.activeTextEditor.document.uri.fsPath.replace(/^.*[\\/]/, '/')
    writeFileSync(filePath, text)
    const args = this.getArgs()
    args.push(filePath)
    const process = spawn(this.realExecPath || this.execPath, args);
    process.stdout.on('data', buffer => {
      // console.log(buffer.toString())
    });
    process.stderr.on('data', buffer => {
      let err = buffer.toString();
      // console.error(err)
      if (err.includes('Files that were not fixed due to errors reported during linting before fixing:')) {
        showView('error', "phpcsfixer: php syntax error" + (err.split('before fixing:')[1]))
      } else if (err.includes('Configuration file `.php_cs` is outdated, rename to `.php-cs-fixer.php`.')) {
        showView('info', 'Configuration file `.php_cs` is outdated, rename to `.php-cs-fixer.php`.')
      }
    });
    return new Promise((resolve, reject) => {
      process.on("error", err => {
        reject(err);
      });
      process.on('exit', (code) => {
        if (code == 0) {
          let fixed = readFileSync(filePath, 'utf-8')
          if (fixed.length > 0) {
            resolve(fixed)
          } else {
            reject();
          }
          showView('success', 'PHP CS Fixer: Fixed all files!');
        } else {
          let msgs = {
            1: 'PHP CS Fixer: php general error.',
            16: 'PHP CS Fixer: Configuration error of the application.',
            32: 'PHP CS Fixer: Configuration error of a Fixer.',
            64: 'PHP CS Fixer: Exception raised within the application.',
            'fallback': 'PHP CS Fixer: Unknown error.'
          }
          let msg = msgs[code in msgs ? code : 'fallback']
          if (code != 16)
            showView('error', msg)
          reject(msg)
        }
        unlink(filePath, (err) => { })
        this.isFixing = false
      });
    });

  }

  public async onDidSaveTextDocument(document: TextDocument) {
    if (document.languageId !== 'php') {
      return;
    }
    if (this.config.onsave === true) {
      commands.executeCommand("editor.action.formatDocument")
    }
  }

  public async deactivate() {
    if (this.isDeactivating) {
      return;
    }
    this.isDeactivating = true;
    showView('info', 'Extension deactivated');
  }
}

function showView(type: string, message: string): void {
  switch (type) {
    case 'success':
      window.setStatusBarMessage(message, 5000);
      break;
    case 'info':
      window.showInformationMessage(message);
      break;
    case 'error':
      window.showErrorMessage(message);
      break;
    case 'warning':
      window.showWarningMessage(message);
      break;
  }
}

const WD: PHPCSFIXER = new PHPCSFIXER();

export async function activate(context: ExtensionContext) {
  WD.onDidChangeConfiguration();
  context.subscriptions.push(workspace.onDidSaveTextDocument(async (e: TextDocument) => {
    WD.onDidSaveTextDocument(e);
  }));
  context.subscriptions.push(workspace.onDidChangeConfiguration(async (e: ConfigurationChangeEvent) => {
    WD.onDidChangeConfiguration();
  }));
  context.subscriptions.push(commands.registerTextEditorCommand('phpcsfixer.fix', async (textEditor: TextEditor) => {
    commands.executeCommand("editor.action.formatDocument")
  }));
  context.subscriptions.push(languages.registerDocumentFormattingEditProvider('php', {
    provideDocumentFormattingEdits: (document, options, token) => {
      return WD.registerDocumentProvider(document, options);
    },
  }))
}
export async function deactivate() {
  WD.deactivate();
}