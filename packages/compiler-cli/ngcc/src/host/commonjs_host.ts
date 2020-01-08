/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as ts from 'typescript';
import {absoluteFrom} from '../../../src/ngtsc/file_system';
import {Declaration, Import} from '../../../src/ngtsc/reflection';
import {Logger} from '../logging/logger';
import {BundleProgram} from '../packages/bundle_program';
import {isDefined, stripExtension} from '../utils';

import {Esm5ReflectionHost} from './esm5_host';
import {NgccClassSymbol} from './ngcc_host';

export class CommonJsReflectionHost extends Esm5ReflectionHost {
  protected commonJsExports = new Map<ts.SourceFile, Map<string, Declaration>|null>();
  protected topLevelHelperCalls = new Map<string, Map<ts.SourceFile, ts.CallExpression[]>>();
  protected program: ts.Program;
  protected compilerHost: ts.CompilerHost;
  constructor(logger: Logger, isCore: boolean, src: BundleProgram, dts: BundleProgram|null = null) {
    super(logger, isCore, src, dts);
    this.program = src.program;
    this.compilerHost = src.host;
  }

  getImportOfIdentifier(id: ts.Identifier): Import|null {
    const superImport = super.getImportOfIdentifier(id);
    if (superImport !== null) {
      return superImport;
    }

    const requireCall = this.findCommonJsImport(id);
    if (requireCall === null) {
      return null;
    }
    return {from: requireCall.arguments[0].text, name: id.text};
  }

  getDeclarationOfIdentifier(id: ts.Identifier): Declaration|null {
    return this.getCommonJsImportedDeclaration(id) || super.getDeclarationOfIdentifier(id);
  }

  getExportsOfModule(module: ts.Node): Map<string, Declaration>|null {
    return super.getExportsOfModule(module) || this.getCommonJsExports(module.getSourceFile());
  }

  getCommonJsExports(sourceFile: ts.SourceFile): Map<string, Declaration>|null {
    return getOrDefault(
        this.commonJsExports, sourceFile, () => this.computeExportsOfCommonJsModule(sourceFile));
  }

  /**
   * Search statements related to the given class for calls to the specified helper.
   *
   * In CommonJS these helper calls can be outside the class's IIFE at the top level of the
   * source file. Searching the top level statements for helpers can be expensive, so we
   * try to get helpers from the IIFE first and only fall back on searching the top level if
   * no helpers are found.
   *
   * @param classSymbol the class whose helper calls we are interested in.
   * @param helperName the name of the helper (e.g. `__decorate`) whose calls we are interested in.
   * @returns an array of nodes of calls to the helper with the given name.
   */
  protected getHelperCallsForClass(classSymbol: NgccClassSymbol, helperNames: string[]):
      ts.CallExpression[] {
    const esm5HelperCalls = super.getHelperCallsForClass(classSymbol, helperNames);
    if (esm5HelperCalls.length > 0) {
      return esm5HelperCalls;
    } else {
      const sourceFile = classSymbol.declaration.valueDeclaration.getSourceFile();
      return this.getTopLevelHelperCalls(sourceFile, helperNames);
    }
  }

  /**
   * Find all the helper calls at the top level of a source file.
   *
   * We cache the helper calls per source file so that we don't have to keep parsing the code for
   * each class in a file.
   *
   * @param sourceFile the source who may contain helper calls.
   * @param helperNames the names of the helpers (e.g. `__decorate`) whose calls we are interested
   * in.
   * @returns an array of nodes of calls to the helper with the given name.
   */
  private getTopLevelHelperCalls(sourceFile: ts.SourceFile, helperNames: string[]):
      ts.CallExpression[] {
    const calls: ts.CallExpression[] = [];
    helperNames.forEach(helperName => {
      const helperCallsMap = getOrDefault(this.topLevelHelperCalls, helperName, () => new Map());
      calls.push(...getOrDefault(
          helperCallsMap, sourceFile,
          () => sourceFile.statements.map(statement => this.getHelperCall(statement, helperNames))
                    .filter(isDefined)));
    });
    return calls;
  }

  private computeExportsOfCommonJsModule(sourceFile: ts.SourceFile): Map<string, Declaration> {
    const moduleMap = new Map<string, Declaration>();
    for (const statement of this.getModuleStatements(sourceFile)) {
      if (isCommonJsExportStatement(statement)) {
        const exportDeclaration = this.extractCommonJsExportDeclaration(statement);
        moduleMap.set(exportDeclaration.name, exportDeclaration.declaration);
      } else if (isReexportStatement(statement)) {
        const reexports = this.extractCommonJsReexports(statement, sourceFile);
        for (const reexport of reexports) {
          moduleMap.set(reexport.name, reexport.declaration);
        }
      }
    }
    return moduleMap;
  }

  private extractCommonJsExportDeclaration(statement: CommonJsExportStatement):
      CommonJsExportDeclaration {
    const exportExpression = statement.expression.right;
    const declaration = this.getDeclarationOfExpression(exportExpression);
    const name = statement.expression.left.name.text;
    if (declaration !== null) {
      return {name, declaration};
    } else {
      return {
        name,
        declaration: {
          node: null,
          expression: exportExpression,
          viaModule: null,
        },
      };
    }
  }

  private extractCommonJsReexports(statement: ReexportStatement, containingFile: ts.SourceFile):
      CommonJsExportDeclaration[] {
    const reexportArg = statement.expression.arguments[0];

    const requireCall = isRequireCall(reexportArg) ?
        reexportArg :
        ts.isIdentifier(reexportArg) ? this.findRequireCallReference(reexportArg) : null;
    if (requireCall === null) {
      return [];
    }

    const importPath = requireCall.arguments[0].text;
    const importedFile = this.resolveModuleName(importPath, containingFile);
    if (importedFile === undefined) {
      return [];
    }

    const importedExports = this.getExportsOfModule(importedFile);
    if (importedExports === null) {
      return [];
    }

    const viaModule = stripExtension(importedFile.fileName);
    const reexports: CommonJsExportDeclaration[] = [];
    importedExports.forEach((decl, name) => {
      if (decl.node !== null) {
        reexports.push({name, declaration: {node: decl.node, viaModule}});
      } else {
        reexports.push({name, declaration: {node: null, expression: decl.expression, viaModule}});
      }
    });
    return reexports;
  }

  private findCommonJsImport(id: ts.Identifier): RequireCall|null {
    // Is `id` a namespaced property access, e.g. `Directive` in `core.Directive`?
    // If so capture the symbol of the namespace, e.g. `core`.
    const nsIdentifier = findNamespaceOfIdentifier(id);
    return nsIdentifier && this.findRequireCallReference(nsIdentifier);
  }

  private findRequireCallReference(id: ts.Identifier): RequireCall|null {
    const symbol = id && this.checker.getSymbolAtLocation(id) || null;
    const declaration = symbol && symbol.valueDeclaration;
    const initializer =
        declaration && ts.isVariableDeclaration(declaration) && declaration.initializer || null;
    return initializer && isRequireCall(initializer) ? initializer : null;
  }

  private getCommonJsImportedDeclaration(id: ts.Identifier): Declaration|null {
    const importInfo = this.getImportOfIdentifier(id);
    if (importInfo === null) {
      return null;
    }

    const importedFile = this.resolveModuleName(importInfo.from, id.getSourceFile());
    if (importedFile === undefined) {
      return null;
    }

    const viaModule = !importInfo.from.startsWith('.') ? importInfo.from : null;
    return {node: importedFile, viaModule};
  }

  private resolveModuleName(moduleName: string, containingFile: ts.SourceFile): ts.SourceFile
      |undefined {
    if (this.compilerHost.resolveModuleNames) {
      const moduleInfo = this.compilerHost.resolveModuleNames(
          [moduleName], containingFile.fileName, undefined, undefined,
          this.program.getCompilerOptions())[0];
      return moduleInfo && this.program.getSourceFile(absoluteFrom(moduleInfo.resolvedFileName));
    } else {
      const moduleInfo = ts.resolveModuleName(
          moduleName, containingFile.fileName, this.program.getCompilerOptions(),
          this.compilerHost);
      return moduleInfo.resolvedModule &&
          this.program.getSourceFile(absoluteFrom(moduleInfo.resolvedModule.resolvedFileName));
    }
  }
}

type CommonJsExportStatement = ts.ExpressionStatement & {
  expression:
      ts.BinaryExpression & {left: ts.PropertyAccessExpression & {expression: ts.Identifier}}
};
export function isCommonJsExportStatement(s: ts.Statement): s is CommonJsExportStatement {
  return ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) &&
      ts.isPropertyAccessExpression(s.expression.left) &&
      ts.isIdentifier(s.expression.left.expression) &&
      s.expression.left.expression.text === 'exports';
}

interface CommonJsExportDeclaration {
  name: string;
  declaration: Declaration;
}

export type RequireCall = ts.CallExpression & {arguments: [ts.StringLiteral]};
export function isRequireCall(node: ts.Node): node is RequireCall {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' && node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]);
}

/**
 * If the identifier `id` is the RHS of a property access of the form `namespace.id`
 * and `namespace` is an identifer then return `namespace`, otherwise `null`.
 * @param id The identifier whose namespace we want to find.
 */
function findNamespaceOfIdentifier(id: ts.Identifier): ts.Identifier|null {
  return id.parent && ts.isPropertyAccessExpression(id.parent) &&
          ts.isIdentifier(id.parent.expression) ?
      id.parent.expression :
      null;
}

type ReexportStatement = ts.ExpressionStatement & {expression: ts.CallExpression};
function isReexportStatement(statement: ts.Statement): statement is ReexportStatement {
  return ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text === '__export' &&
      statement.expression.arguments.length === 1;
}

function getOrDefault<K, V>(map: Map<K, V>, key: K, factory: (key: K) => V): V {
  if (!map.has(key)) {
    map.set(key, factory(key));
  }
  return map.get(key) !;
}