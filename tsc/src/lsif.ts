/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
const Version: string = "0.2.0";

import * as os from 'os';
// In typescript all paths are /. So use the posix layer only
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

import URI from 'vscode-uri';
import * as ts from 'typescript';

import * as tss from './typescripts';

import {
	lsp, Vertex, Edge, Project, Document, Id, ReferenceResult, RangeTagTypes, ReferenceRange, ReferenceResultId, RangeId, TypeDefinitionResult, RangeBasedDocumentSymbol,
	ResultSet, HoverResult, DefinitionRange, DefinitionResult, Moniker, MonikerKind, PackageInformation, ItemEdgeProperties, ImplementationResult
} from 'lsif-protocol';

import { VertexBuilder, EdgeBuilder, Builder } from './graph';

import { Emitter } from './emitters/emitter';

namespace Converter {

	const DiagnosticCategory = ts.DiagnosticCategory;
	const DiagnosticSeverity = lsp.DiagnosticSeverity;

	export function asDiagnostic(this: void, value: ts.DiagnosticWithLocation): lsp.Diagnostic {
		return {
			severity: asDiagnosticSeverity(value.category),
			code: value.code,
			message: tss.flattenDiagnosticMessageText(value.messageText, os.EOL),
			range: asRange(value.file, value.start, value.length)
		};
	}

	export function asDiagnosticSeverity(this: void, value: ts.DiagnosticCategory): lsp.DiagnosticSeverity {
		switch (value) {
			case DiagnosticCategory.Message:
				return DiagnosticSeverity.Information;
			case DiagnosticCategory.Suggestion:
				return DiagnosticSeverity.Hint;
			case DiagnosticCategory.Warning:
				return DiagnosticSeverity.Warning;
			case DiagnosticCategory.Error:
				return DiagnosticSeverity.Error;
			default:
				return lsp.DiagnosticSeverity.Error;
		}
	}

	export function asRange(this: void, file: ts.SourceFile, offset: number, length: number): lsp.Range {
		let start = file.getLineAndCharacterOfPosition(offset);
		let end = file.getLineAndCharacterOfPosition(offset + length);
		return {
			start: { line: start.line, character: start.character },
			end: { line: end.line, character: end.character }
		};
	}

	export function rangeFromNode(this: void, file: ts.SourceFile, node: ts.Node, includeJsDocComment?: boolean): lsp.Range {
		let start = file.getLineAndCharacterOfPosition(node.getStart(file, includeJsDocComment));
		let end = file.getLineAndCharacterOfPosition(node.getEnd());
		return {
			start: { line: start.line, character: start.character },
			end: { line: end.line, character: end.character }
		}
	}

	export function rangeFromTextSpan(this: void, file: ts.SourceFile, textSpan: ts.TextSpan): lsp.Range {
		let start = file.getLineAndCharacterOfPosition(textSpan.start);
		let end = file.getLineAndCharacterOfPosition(textSpan.start + textSpan.length);
		return {
			start: { line: start.line, character: start.character },
			end: { line: end.line, character: end.character }
		};
	}

	export function asFoldingRange(this: void, file: ts.SourceFile, span: ts.OutliningSpan): lsp.FoldingRange {
		let kind = getFoldingRangeKind(span);
		let start = file.getLineAndCharacterOfPosition(span.textSpan.start);
		let end = file.getLineAndCharacterOfPosition(span.textSpan.start + span.textSpan.length);
		return {
			kind,
			startLine: start.line,
			startCharacter: start.character,
			endLine: end.line,
			endCharacter: end.character
		} as lsp.FoldingRange;
	}

	function getFoldingRangeKind(span: ts.OutliningSpan): lsp.FoldingRangeKind | undefined {
		switch (span.kind) {
			case 'comment':
				return lsp.FoldingRangeKind.Comment;
			case 'region':
				return lsp.FoldingRangeKind.Region;
			case 'imports':
				return lsp.FoldingRangeKind.Imports;
			case 'code':
			default:
				return undefined;
		}
	}

	const symbolKindMap: Map<number, lsp.SymbolKind> = new Map<number, lsp.SymbolKind>([
		[ts.SyntaxKind.ClassDeclaration, lsp.SymbolKind.Class],
		[ts.SyntaxKind.InterfaceDeclaration, lsp.SymbolKind.Interface],
		[ts.SyntaxKind.TypeParameter, lsp.SymbolKind.TypeParameter],
		[ts.SyntaxKind.MethodDeclaration, lsp.SymbolKind.Method],
		[ts.SyntaxKind.FunctionDeclaration, lsp.SymbolKind.Function]
	]);

	export function asSymbolKind(this: void, node: ts.Node): lsp.SymbolKind {
		let result: lsp.SymbolKind | undefined = symbolKindMap.get(node.kind);
		if (result === undefined) {
			result = lsp.SymbolKind.Property;
		}
		return result;
	}

	export function asHover(this: void, file: ts.SourceFile, value: ts.QuickInfo): lsp.Hover {
		let content: lsp.MarkedString[] = [];
		if (value.displayParts !== undefined) {
			content.push({ language: 'typescript', value: displayPartsToString(value.displayParts)});
		}
		if (value.documentation && value.documentation.length > 0) {
			content.push(displayPartsToString(value.documentation));
		}
		return {
			contents: content,
			range: rangeFromTextSpan(file, value.textSpan)
		};
	}

	function displayPartsToString(this: void, displayParts: ts.SymbolDisplayPart[] | undefined) {
		if (displayParts) {
			return displayParts.map(displayPart => displayPart.text).join('');
		}
		return '';
	}

	export function asLocation(file: ts.SourceFile, definition: ts.DefinitionInfo): lsp.Location {
		return { uri: URI.file(definition.fileName).toString(true), range: rangeFromTextSpan(file , definition.textSpan) } as lsp.Location;
	}
}

interface SymbolItemContext {
	vertex: VertexBuilder;
	edge: EdgeBuilder;
	emit(element: Vertex | Edge): void;

	typeChecker: ts.TypeChecker;
	getDocumentAndEmitIfNecessary(file: ts.SourceFile): DocumentInformation;
	getHover(node: ts.DeclarationName, sourceFile?: ts.SourceFile): HoverResult | undefined;
	getDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined;
	getTypeDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined;

	emitOnEndVisit(node: ts.Node, toEmit: (Vertex | Edge)[]): void;
	getEmittingNode(toEmit: Vertex | Edge): ts.Node | undefined;
	isFullContentIgnored(sourceFile: ts.SourceFile): boolean;
	isExported(symbol: ts.Symbol): boolean;
}

abstract class SymbolItem {

	private static all: Map<string, SymbolItem> = new Map();

	private static Unknown = 'unkown';
	private static Undefined = 'undefined';
	private static None = 'none';

	public static get(context: SymbolItemContext, symbol: ts.Symbol): SymbolItem {
		let key = this.createKey(symbol, context.typeChecker);
		let result: SymbolItem | undefined = this.all.get(key);
		if (result === undefined) {
			if (this.isClass(symbol)) {
				result = new ClassSymbolItem(key, context, symbol);
			} else if (this.isInterface(symbol)) {
				result = new InterfaceSymbolItem(key, context, symbol);
			} else if (this.isTypeLiteral(symbol)) {
				result = new TypeLiteralSymbolItem(key, context, symbol);
			} else if (this.isMethodSymbol(symbol)) {
				result = new MethodSymbolItem(key, context, symbol);
			} else if (this.isFunction(symbol)) {
				result = new FunctionSymbolItem(key, context, symbol);
			} else if (this.isAliasSymbol(symbol)) {
				let aliased = context.typeChecker.getAliasedSymbol(symbol);
				if (aliased !== undefined) {
					let aliasedSymbolItem = this.get(context, aliased);
					if (aliasedSymbolItem !== undefined) {
						result = new AliasSymbolItem(key, context, symbol, aliasedSymbolItem);
					}
				}
			}
			if (result === undefined) {
				result = new GenericSymbolItem(key, context, symbol);
			}
			this.all.set(key, result);
			result.initialize();
		}
		return result;
	}

	private static createKey(symbol: ts.Symbol, typeChecker: ts.TypeChecker): string {
		let declarations = symbol.getDeclarations()
		if (declarations === undefined) {
			if (typeChecker.isUnknownSymbol) {
				return SymbolItem.Unknown;
			} else if (typeChecker.isUndefinedSymbol) {
				return SymbolItem.Undefined;
			} else {
				return SymbolItem.None;
			}
		}
		let result: { f: string; s: number; e: number}[] = [];
		for (let declaration of declarations) {
			result.push({
				f: declaration.getSourceFile().fileName,
				s: declaration.getStart(),
				e: declaration.getEnd()
			})
		};
		let hash = crypto.createHash('md5');
		hash.write(JSON.stringify(result, undefined, 0));
		return hash.digest('base64');
	}

	protected static isFunction(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Function) !== 0;
	}

	public static isClass(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Class) !== 0;
	}

	public static isInterface(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Interface) !== 0;
	}

	public static isTypeLiteral(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.TypeLiteral) !== 0;
	}

	protected static isMethodSymbol(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Method) !== 0;
	}

	protected static isAliasSymbol(symbol: ts.Symbol): boolean  {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Alias) !== 0;
	}

	protected static isValueModule(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.ValueModule) !== 0;
	}

	protected static isBlockScopedVariable(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.BlockScopedVariable) !== 0;
	}

	protected static computeMoniker(nodes: ts.Node[]): string | undefined {
		if (nodes.length === 0) {
			return undefined;
		}
		if (nodes.length === 1) {
			return this.doComputeMoniker(nodes[0]);
		}
		let result: Set<string> = new Set<string>();
		for (let node of nodes) {
			let part = SymbolItem.doComputeMoniker(node);
			if (part === undefined) {
				return undefined;
			}
			result.add(part);
		}
		return Array.from(result).join('|');
	}

	private static stopKinds: Set<number> = new Set([ts.SyntaxKind.Block, ts.SyntaxKind.ClassExpression, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction]);
	private static doComputeMoniker(node: ts.Node): string | undefined {
		function getName(node: ts.Node): string | undefined {
			let namedDeclaration: ts.NamedDeclaration = node as ts.NamedDeclaration;
			if (namedDeclaration.name !== undefined) {
				return namedDeclaration.name.getText();
			} else {
				return undefined;
			}
		}
		// No monikers for source files.
		if (ts.isSourceFile(node)) {
			return undefined;
		}
		let buffer: string[] = [];
		do {
			if (SymbolItem.stopKinds.has(node.kind)) {
				// No keys for stuff inside a block, ...
				return undefined;
			}
			let name = getName(node);
			if (name !== undefined) {
				buffer.unshift(name);
			} else if (node.kind === ts.SyntaxKind.ClassDeclaration) {
				// We have an anonymous class declaration => no key.
				return undefined;
			} else if (node.kind === ts.SyntaxKind.FunctionDeclaration) {
				// We have an anonymous function declaration => no key.
				return undefined;
			}
		} while ((node = node.parent) !== undefined && !ts.isSourceFile(node))
		return buffer.join('.');
	}

	public static isPrivate(symbol: ts.Symbol): boolean {
		let declarations = symbol.getDeclarations();
		if (declarations) {
			for (let declaration of declarations) {
				let modifierFlags = ts.getCombinedModifierFlags(declaration);
				if ((modifierFlags & ts.ModifierFlags.Private) === 0) {
					return false;
				}
			}
		}
		return true;
	}

	protected static isStatic(symbol: ts.Symbol): boolean {
		let declarations = symbol.getDeclarations();
		if (declarations) {
			for (let declaration of declarations) {
				let modifierFlags = ts.getCombinedModifierFlags(declaration);
				if ((modifierFlags & ts.ModifierFlags.Static) === 0) {
					return false;
				}
			}
		}
		return true;
	}

	private static EmitBoundaries: Set<number> = new Set<number>([
		ts.SyntaxKind.TypeParameter,
		ts.SyntaxKind.Parameter,
		ts.SyntaxKind.PropertyDeclaration,
		ts.SyntaxKind.MethodDeclaration,
		ts.SyntaxKind.Constructor,
		ts.SyntaxKind.GetAccessor,
		ts.SyntaxKind.SetAccessor,
		ts.SyntaxKind.CallSignature,
		ts.SyntaxKind.FunctionExpression,
		ts.SyntaxKind.ArrowFunction,
		ts.SyntaxKind.ClassExpression,
		ts.SyntaxKind.VariableDeclaration,
		ts.SyntaxKind.FunctionDeclaration,
		ts.SyntaxKind.ClassDeclaration,
		ts.SyntaxKind.InterfaceDeclaration,
		ts.SyntaxKind.TypeAliasDeclaration,
		ts.SyntaxKind.EnumDeclaration,
		ts.SyntaxKind.ModuleDeclaration,
		ts.SyntaxKind.SourceFile
	]);

	public declarations: DefinitionRange | DefinitionRange[] | undefined;
	public rangeNodes: ts.Node | ts.Node[] | undefined;
	public _resultSet: ResultSet | undefined;
	public definitionResult: DefinitionResult | undefined;
	public _referenceResult:  ReferenceResult | undefined;
	public _implementationResult: ImplementationResult | undefined;

	protected constructor(public id: string, protected context: SymbolItemContext, public tsSymbol: ts.Symbol) {
	}

	public get resultSet(): ResultSet {
		if (this._resultSet === undefined) {
			throw new Error(`Result set not initialized.`)
		}
		return this._resultSet;
	}

	public get referenceResult(): ReferenceResult {
		if (this._referenceResult === undefined) {
			throw new Error(`Reference result not initialized.`)
		}
		return this._referenceResult;
	}

	protected initialize(): void {
		this.ensureResultSet();
		let declarations: ts.Declaration[] | undefined = this.tsSymbol.getDeclarations();
		if (declarations !== undefined && declarations.length > 0) {
			this.ensureReferenceResult();
			this.ensureImplementationResult();
			this.initializeDeclarations(declarations);
		} else {
			this.initializeNoDeclarartions();
		}
	}

	protected initializeDeclarations(declarations: ts.Declaration[]): void {
		let definitionResultValues: RangeId[] | undefined = this.getDefinitionResultValues();
		let hover: boolean = false;
		const monikerName = SymbolItem.computeMoniker(declarations);
		let monikers: Map<string, Moniker> = new Map();
		for (let declaration of declarations) {
			let sourceFile = declaration.getSourceFile();
			let [range, rangeNode, text] = this.resolveDefinitionRange(sourceFile, declaration);
			if (range !== undefined && rangeNode !== undefined && text !== undefined) {
				let { document, monikerPath, monikerKind, packageInfo } = this.context.getDocumentAndEmitIfNecessary(sourceFile);
				let definition = this.context.vertex.range(Converter.rangeFromNode(sourceFile, rangeNode), {
					type: RangeTagTypes.definition,
					text: text,
					kind: Converter.asSymbolKind(declaration),
					fullRange: Converter.rangeFromNode(sourceFile, declaration),
				});
				this.context.emit(definition);
				this.context.emit(this.context.edge.contains(document, definition));
				let moniker = monikers.get(sourceFile.fileName);
				if (moniker === undefined && monikerName !== undefined && monikerPath !== undefined && monikerKind !== undefined) {
					moniker = this.context.vertex.moniker(monikerKind, 'tsc', tss.createMonikerIdentifier(monikerPath, monikerName));
					monikers.set(sourceFile.fileName, moniker);
					this.context.emit(moniker);
					if (packageInfo !== undefined) {
						this.context.emit(this.context.edge.packageInformation(moniker, packageInfo));
					}
				}
				if (moniker !== undefined) {
					this.context.emit(this.context.edge.moniker(definition, moniker));
				}
				this.recordDeclaration(definition);
				this.storeDefinitionAndRange(definition, rangeNode);
				if (definitionResultValues !== undefined) {
					definitionResultValues.push(definition.id);
				}
				if (!hover && tss.isNamedDeclaration(declaration)) {
					hover = this.handleHover(sourceFile, declaration.name);
				}
			} else {
				// We should log this somewhere to improve the tool.
			}
		}
		if (definitionResultValues !== undefined && definitionResultValues.length > 0) {
			this.definitionResult = this.context.vertex.definitionResult(definitionResultValues);
			this.context.emit(this.definitionResult);
			this.context.emit(this.context.edge.definition(this.resultSet, this.definitionResult));
		}
		if (SymbolItem.isBlockScopedVariable(this.tsSymbol) && declarations.length === 1) {
			let type = this.context.typeChecker.getTypeOfSymbolAtLocation(this.tsSymbol, declarations[0]);
			if (type.symbol) {
				let typeSymbol = SymbolItem.get(this.context, type.symbol);
				let result: TypeDefinitionResult | undefined;
				if (Array.isArray(typeSymbol.declarations)) {
					result = this.context.vertex.typeDefinitionResult(typeSymbol.declarations.map(declaration => declaration.id));
				} else if (typeSymbol.declarations !== undefined) {
					result = this.context.vertex.typeDefinitionResult([typeSymbol.declarations.id]);
				}
				if (result !== undefined) {
					this.context.emit(result);
					this.context.emit(this.context.edge.typeDefinition(this.resultSet, result));
				}
			}
		}
	}

	protected initializeNoDeclarartions(): void {
		this.ensureReferenceResult();
		this.emitReferenceResult(this.referenceResult);
		this.definitionResult = this.context.vertex.definitionResult([]);
		this.context.emit(this.definitionResult);
		this.context.emit(this.context.edge.definition(this.resultSet, this.definitionResult));
	}

	protected resolveEmittingNode(): ts.Node | undefined {
		// The symbol is exported So we can't optimize any emitting.
		if (this.context.isExported(this.tsSymbol)) {
			return undefined;
		}
		let declarations = this.tsSymbol.getDeclarations();
		if (declarations === undefined || declarations.length !== 1) {
			return undefined;
		}
		let declaration = declarations[0];
		if (SymbolItem.isValueModule(this.tsSymbol) && declaration.kind === ts.SyntaxKind.SourceFile) {
			return undefined;
		}

		if (ts.isSourceFile(declaration)) {
			return this.context.isFullContentIgnored(declaration) ? undefined : declaration;
		}
		let result = declaration.parent;
		while (result !== undefined && !SymbolItem.EmitBoundaries.has(result.kind)) {
			result = result.parent;
		}
		if (result !== undefined && this.context.isFullContentIgnored(result.getSourceFile())) {
			return undefined;
		}
		return result;
	}

	protected ensureResultSet(): void {
		if (this._resultSet !== undefined) {
			return;
		}
		this._resultSet = this.context.vertex.resultSet();
		this.context.emit(this.resultSet);
	}

	protected getDefinitionResultValues(): RangeId[] | undefined {
		return [];
	}

	private ensureReferenceResult(): void {
		if (this._referenceResult !== undefined) {
			return;
		}
		this.resolveReferenceResult();
	}

	private resolveReferenceResult(): void {
		let declarations = this.tsSymbol.getDeclarations();
		if (declarations === undefined || declarations.length === 0) {
			this._referenceResult = this.createReferenceResult([], [], []);
			return;
		}
		this._referenceResult = this.doResolveReferenceResult(this.resolveEmittingNode());
	}

	protected doResolveReferenceResult(emittingNode: ts.Node | undefined): ReferenceResult {
		if (emittingNode !== undefined) {
			return this.createReferenceResult(emittingNode);
		} else {
			return this.createReferenceResult();
		}
	}

	protected createReferenceResult(): ReferenceResult;
	protected createReferenceResult(emittingNode: ts.Node): ReferenceResult;
	protected createReferenceResult(referenceResults: ReferenceResultId[]): ReferenceResult;
	protected createReferenceResult(declarations: (RangeId | lsp.Location)[], definitions: (RangeId | lsp.Location)[], references: (RangeId | lsp.Location)[]): ReferenceResult;
	protected createReferenceResult(arg0?: any, arg1?: any, arg2?: any): ReferenceResult {
		let result: ReferenceResult;
		if (tss.isNode(arg0)) {
			result = this.context.vertex.referencesResult([],[],[]);
			this.context.emitOnEndVisit(arg0, [
				result,
				this.context.edge.references(this.resultSet, result)
			]);
		} else {
			result = this.context.vertex.referencesResult(arg0, arg1, arg2);
			if (result.referenceResults === undefined && result.declarations === undefined && result.definitions === undefined && result.references === undefined) {
				this.emitReferenceResult(result);
			}
		}
		return result;
	}

	protected emitReferenceResult(result: ReferenceResult): void {
		this.context.emit(result);
		this.context.emit(this.context.edge.references(this.resultSet, result));
	}

	private ensureImplementationResult(): void {
		if (this._implementationResult !== undefined) {
			return;
		}
		this.resolveImplementationResult();
	}

	private resolveImplementationResult(): void {
		let declarations = this.tsSymbol.getDeclarations();
		if (declarations === undefined || declarations.length === 0) {
			this._implementationResult = this.createImplementationResult();
		}
		this._implementationResult = this.doResolveImplementationResult(this.resolveEmittingNode());
	}

	protected doResolveImplementationResult(emittingNode: ts.Node | undefined): ImplementationResult {
		if (emittingNode === undefined) {
			return this.createImplementationResult();
		}
		return this.createImplementationResult(emittingNode);
	}

	protected createImplementationResult(): ImplementationResult;
	protected createImplementationResult(emittingNode: ts.Node): ImplementationResult;
	protected createImplementationResult(arg0?: any): ImplementationResult {
		let implementationResult: ImplementationResult;

		if (tss.isNode(arg0)) {
			implementationResult = this.context.vertex.implementationResult();
			implementationResult.result = [];
			this.context.emitOnEndVisit(arg0, [implementationResult, this.context.edge.implementation(this.resultSet, implementationResult)]);
		}
		else {
			implementationResult = this.context.vertex.implementationResult();
			this.context.emit(implementationResult);
			this.context.emit(this.context.edge.implementation(this.resultSet, implementationResult));
		}

		return implementationResult;
	}

	protected emitEdgeToForeignReferenceResult(from: ResultSet, to: ReferenceResult): void {
		let emittingNode: ts.Node | undefined;
		let edge = this.context.edge.references(from, to);
		if (ReferenceResult.isStatic(to)) {
			emittingNode = this.context.getEmittingNode(to);
		}
		if (emittingNode !== undefined) {
			this.context.emitOnEndVisit(emittingNode, [edge]);
		} else {
			this.context.emit(edge);
		}
	}

	protected resolveDefinitionRange(sourceFile: ts.SourceFile, declaration: ts.Declaration): [lsp.Range, ts.Node, string] | [undefined, undefined, undefined] {
		if (tss.isNamedDeclaration(declaration)) {
			let name = declaration.name;
			return [Converter.rangeFromNode(sourceFile, name), name, name.getText()];
		}
		if (SymbolItem.isValueModule(this.tsSymbol) && ts.isSourceFile(declaration)) {

			return [{ start: { line: 0, character: 0}, end: { line: 0, character: 0 } }, declaration, ''];
		}
		return [undefined, undefined, undefined];
	}

	protected handleHover(sourceFile: ts.SourceFile, rangeNode: ts.DeclarationName): boolean  {
		let hover = this.context.getHover(rangeNode, sourceFile);
		if (hover !== undefined) {
			this.context.emit(hover);
			this.context.emit(this.context.edge.hover(this.resultSet, hover));
			return true;
		} else {
			return false;
		}
	}

	protected storeDefinitionAndRange(definition: DefinitionRange, rangeNode: ts.Node): void {
		if (Array.isArray(this.declarations)) {
			this.declarations.push(definition);
			(this.rangeNodes as Array<ts.Node>).push(rangeNode);
		} else if (this.declarations !== undefined) {
			this.declarations = [this.declarations, definition];
			this.rangeNodes = [this.rangeNodes as ts.Node, rangeNode];
		} else {
			this.declarations = definition;
			this.rangeNodes = rangeNode!;
		}
	}

	public forEachDeclaration(func: (declaration: DefinitionRange) => void): void {
		if (Array.isArray(this.declarations)) {
			for (let declaration of this.declarations) {
				func(declaration);
			}
		} else if (this.declarations !== undefined) {
			func(this.declarations);
		}
	}

	public addReference(reference: ReferenceRange): void {
		this.recordReference(reference);
	}

	public hasDeclaration(node: ts.Node): boolean {
		if (Array.isArray(this.rangeNodes)) {
			return this.rangeNodes.indexOf(node) !== -1;
		} else {
			return this.rangeNodes === node;
		}
	}

	public getDeclaration(node: ts.Node): DefinitionRange | undefined {
		if (Array.isArray(this.rangeNodes)) {
			for (let i = 0; i < this.rangeNodes.length; i++) {
				if (this.rangeNodes[i] === node) {
					return (this.declarations as DefinitionRange[])[i];
				}
			}
		} else {
			return this.rangeNodes === node ? this.declarations as DefinitionRange : undefined;
		}
		return undefined;
	}

	public findDeclaration(start: number, end: number): DefinitionRange | undefined {
		if (Array.isArray(this.rangeNodes)) {
			for (let i = 0; i < this.rangeNodes.length; i++) {
				let node = this.rangeNodes[i];
				if (node.getStart() === start && node.getEnd() === end) {
					return (this.declarations as DefinitionRange[])[i];
				}
			}
		} else if (this.rangeNodes !== undefined) {
			if (this.rangeNodes.getStart() === start && this.rangeNodes.getEnd() === end) {
				return this.declarations as DefinitionRange;
			}
		}
		return undefined;
	}

	protected recordDeclaration(definition: DefinitionRange): void {
		this.context.emit(this.context.edge.refersTo(definition, this.resultSet));
		if (this.referenceResult === undefined) {
			return;
		}
		// We have a lazy reference result
		if (this.referenceResult.declarations === undefined) {
			this.context.emit(this.context.edge.item(this.referenceResult, definition, ItemEdgeProperties.definitions));
		} else {
			this.referenceResult.declarations.push(definition.id);
		}

		// If this is not an interface, each declaration is an implementation result
		if (!MemberContainerItem.isInterface(this.tsSymbol) &&
			// If this is a method and the symbol kind is NOT method, then it is not an implementation
			!(MemberContainerItem.isMethodSymbol(this.tsSymbol) && definition.tag.kind !== lsp.SymbolKind.Method) &&
			this._implementationResult
		) {
			if(this._implementationResult.result === undefined) {
				this.context.emit(this.context.edge.item(this._implementationResult, definition));
			}
			else {
				this._implementationResult.result.push(definition.id);
			}
		}
	}

	protected recordReference(reference: ReferenceRange): void {
		this.context.emit(this.context.edge.refersTo(reference, this.resultSet));
		if (this.referenceResult === undefined) {
			return;
		}
		if (this.referenceResult.references === undefined) {
			this.context.emit(this.context.edge.item(this.referenceResult, reference, ItemEdgeProperties.references));
		} else {
			this.referenceResult.references.push(reference.id);
		}
	}
}

class GenericSymbolItem extends SymbolItem {
	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}
}

class FunctionSymbolItem extends SymbolItem {
	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}
}

abstract class MemberContainerItem extends SymbolItem {

	private static EMPTY: ReadonlyArray<MemberContainerItem> = Object.freeze([]);

	private baseSymbols: ReadonlyArray<MemberContainerItem> | undefined;

	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}

	protected initialize(): void {
		this.ensureBaseSymbol();
		super.initialize();
	}

	private ensureBaseSymbol(): void {
		// Already resolve or not class or interface.
		if (this.baseSymbols !== undefined) {
			return;
		}
		let bases = this.getBaseSymbols();
		if (bases === undefined || bases.length === 0) {
			this.baseSymbols = MemberContainerItem.EMPTY;
			return;
		}
		let baseSymbols: MemberContainerItem[] = [];
		for (let base of bases) {
			let baseSymbol = SymbolItem.get(this.context, base);
			if (!(baseSymbol instanceof MemberContainerItem)) {
				throw new Error(`Base symbol is not a class ${this.tsSymbol.getName()}`);
			}
			baseSymbols.push(baseSymbol);
		}
		this.baseSymbols = baseSymbols;
	}

	protected recordDeclaration(definition: DefinitionRange): void {
		super.recordDeclaration(definition);

		// If we have base symbols, add our declaration to their implementation results
		if (this.baseSymbols) {
			this.baseSymbols.forEach(baseSymbol => {
				if (baseSymbol._implementationResult) {
					if(baseSymbol._implementationResult.result === undefined) {
						this.context.emit(this.context.edge.item(baseSymbol._implementationResult, definition));
					}
					else {
						baseSymbol._implementationResult.result.push(definition.id);
					}
				}
			});
		}
	}

	protected abstract getBaseSymbols(): ts.Symbol[]  | undefined;

	public findBaseMembers(memberName: string): MethodSymbolItem[] | undefined {
		if (this.baseSymbols === undefined) {
			return undefined;
		}
		let result: MethodSymbolItem[] | undefined;
		for (let base of this.baseSymbols) {
			if (!base.tsSymbol.members) {
				continue;
			}
			let method = base.tsSymbol.members.get(memberName as ts.__String);
			if (method !== undefined) {
				if (result === undefined) {
					result = [SymbolItem.get(this.context, method) as MethodSymbolItem];
				} else {
					result.push(SymbolItem.get(this.context, method) as MethodSymbolItem);
				}
			} else {
				let baseResult = base.findBaseMembers(memberName);
				if (baseResult !== undefined) {
					if (result === undefined) {
						result = baseResult;
					} else {
						result.push(...baseResult);
					}
				}
			}
		}
		return result;
	}
}

class TypeLiteralSymbolItem extends MemberContainerItem {
	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}

	// Type literal symbols have no base symbols
	protected getBaseSymbols(): ts.Symbol[] | undefined {
		return undefined;
	}
}

class InterfaceSymbolItem extends MemberContainerItem {

	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}

	// Type literal symbols have no base symbols
	protected getBaseSymbols(): ts.Symbol[] | undefined {
		let result: ts.Symbol[] = [];
		let tsType = this.context.typeChecker.getDeclaredTypeOfSymbol(this.tsSymbol);
		if (tsType === undefined) {
			return undefined;
		}
		let baseTypes = tsType.getBaseTypes();
		if (baseTypes !== undefined) {
			for (let base of baseTypes) {
				let symbol = base.getSymbol();
				if (symbol) {
					result.push(symbol);
				}
			}
		}
		return result.length === 0 ? undefined : result;
	}
}

/**
 * Classes and interfaces.
 */
class ClassSymbolItem extends MemberContainerItem {

	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}

	// Type literal symbols have no base symbols
	protected getBaseSymbols(): ts.Symbol[] | undefined {
		let result: ts.Symbol[] = [];
		let declarations = this.tsSymbol.getDeclarations();
		if (declarations === undefined) {
			return undefined;
		}
		let typeChecker = this.context.typeChecker;
		for (let declaration of declarations) {
			if (ts.isClassDeclaration(declaration)) {
				let heritageClauses = declaration.heritageClauses;
				if (heritageClauses) {
					for (let heritageClause of heritageClauses) {
						for (let type of heritageClause.types) {
							let tsType = typeChecker.getTypeAtLocation(type.expression);
							if (tsType !== undefined) {
								let symbol = tsType.getSymbol();
								if (symbol) {
									result.push(symbol);
								}
							}
						}
					}
				}
			}
		}
		return result.length === 0 ? undefined : result;
	}
}

class MethodSymbolItem extends SymbolItem {

	private baseReferenceResults: ReadonlyArray<ReferenceResult> | undefined;

	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}

	private findBaseMethods(): MethodSymbolItem[] {
		let classSymbol = this.getMemberContainer();
		if (classSymbol === undefined) {
			return [];
		}
		let methodName = this.tsSymbol.getName();
		let baseMethods = classSymbol.findBaseMembers(methodName);
		if (baseMethods === undefined) {
			return [];
		}
		return baseMethods;
	}

	protected doResolveReferenceResult(emittingNode: ts.Node): ReferenceResult {
		if (SymbolItem.isPrivate(this.tsSymbol)) {
			return super.doResolveReferenceResult(emittingNode);
		}
		if (SymbolItem.isStatic(this.tsSymbol)) {
			return super.doResolveReferenceResult(emittingNode);
		}
		// We have a method that could be overridden. So try to find
		// a base method with the same name.
		let baseMethods = this.findBaseMethods();
		if (baseMethods.length === 0) {
			return this.createReferenceResult();
		}
		// We do have base methods. Easy case only one. Then reuse what the
		// base method has
		if (baseMethods.length === 1) {
			let baseMethod = baseMethods[0];
			let referenceResult = baseMethod.referenceResult;
			this.baseReferenceResults = baseMethod.baseReferenceResults;
			this.emitEdgeToForeignReferenceResult(this.resultSet, referenceResult);
			return referenceResult;
		}

		let baseReferenceResults: ReferenceResult[] = [];
		let mergeIds: ReferenceResultId[] = [];
		for (let base of baseMethods) {
			if (base.referenceResult !== undefined) {
				mergeIds.push(base.referenceResult.id);
			}
			if (base.referenceResult !== undefined && base.baseReferenceResults === undefined) {
				baseReferenceResults.push(base.referenceResult);
			} else if (base.baseReferenceResults !== undefined) {
				baseReferenceResults.push(...base.baseReferenceResults);
			}
		}
		this.baseReferenceResults = baseReferenceResults;
		let referenceResult = this.createReferenceResult(mergeIds);
		// The merged ID set is complete. So we can emit it
		this.emitReferenceResult(referenceResult);
		return referenceResult;
	}

	protected doResolveImplementationResult(emittingNode: ts.Node): ImplementationResult {
		// Implementation is the same as declaration
		if (SymbolItem.isPrivate(this.tsSymbol)) {
			return super.doResolveImplementationResult(emittingNode);
		}
		if (SymbolItem.isStatic(this.tsSymbol)) {
			return super.doResolveImplementationResult(emittingNode);
		}

		// We could be implementing another method
		// Look for base method
		let baseMethods = this.findBaseMethods();
		if (baseMethods.length === 0) {
			return super.doResolveImplementationResult(emittingNode);
		}

		// We implement some base method
		let implementationResult = this.context.vertex.implementationResult();
		implementationResult.result = [];

		// In this case, point all base methods to our results as well
		let toEmit: Edge[] = [];
		baseMethods.forEach(baseMethod => {
			if (baseMethod._implementationResult) {
				toEmit.push(this.context.edge.item(baseMethod._implementationResult, implementationResult));
			}
		});

		this.context.emitOnEndVisit(emittingNode, [implementationResult, this.context.edge.implementation(this.resultSet, implementationResult), ...toEmit]);

		return implementationResult;
	}

	private getMemberContainer(): MemberContainerItem | undefined {
		let tsSymbol = this.tsSymbol;
		let symbolParent = tss.getSymbolParent(tsSymbol);
		if (symbolParent === undefined) {
			return undefined;
		}
		let memberContainer = SymbolItem.get(this.context, symbolParent);
		if (!(memberContainer instanceof MemberContainerItem)) {
			return undefined;
		}
		return memberContainer;
	}

	protected recordDeclaration(definition: DefinitionRange): void {
		super.recordDeclaration(definition);
		if (this.baseReferenceResults !== undefined) {
			this.baseReferenceResults.forEach(result =>  {
				this.context.emit(this.context.edge.item(result, definition, ItemEdgeProperties.definitions))
			});
		}
	}

	protected recordReference(reference: ReferenceRange): void {
		super.recordReference(reference);
		if (this.baseReferenceResults !== undefined) {
			this.baseReferenceResults.forEach(result => {
				this.context.emit(this.context.edge.item(result, reference, ItemEdgeProperties.references));
			});
			return;
		}
	}
}

class AliasSymbolItem extends SymbolItem  {
	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol, private aliased: SymbolItem) {
		super(id, context, tsSymbol);
	}

	protected initialize(): void {
		this.ensureResultSet();
		this._referenceResult = this.aliased.referenceResult;
		this.definitionResult = this.aliased.definitionResult;

		// Wire the reference and definition result to aliased Symbol
		if (this.definitionResult !== undefined) {
			this.context.emit(this.context.edge.definition(this.resultSet, this.definitionResult));
		}
		this.emitEdgeToForeignReferenceResult(this.resultSet, this.referenceResult);
		let declarations = this.tsSymbol.getDeclarations();
		if (declarations !== undefined && declarations.length > 0) {
			this.initializeDeclarations(declarations);
		} else {
			// An aliased symbol without a declaration is not valid.
			// We should log this @log
		}
	}

	protected getDefinitionResultValues(): RangeId[] | undefined {
		// This is handled in recordDeclaration which forwards to the aliased set.
		return undefined;
	}

	protected recordDeclaration(definition: DefinitionRange): void {
		this.context.emit(this.context.edge.refersTo(definition, this.resultSet));
		if (this.referenceResult === undefined) {
			return;
		}
		// Alias declarations are recorded as references on the aliased set.
		if (this.referenceResult.references === undefined) {
			this.context.emit(this.context.edge.item(this.referenceResult, definition, ItemEdgeProperties.references));
		} else {
			this.referenceResult.references.push(definition.id);
		}
	}
}

interface DocumentInformation {
	document: Document;
	packageInfo?: PackageInformation;
	monikerKind?: MonikerKind;
	monikerPath?: string;
}

export interface ProjectInfo {
	rootDir: string;
	outDir: string;
}

export interface Options {
	project: string;
	noContents: boolean;
}

class Visitor implements SymbolItemContext {

	private builder: Builder;
	private project: Project;
	private projectRoot: string;
	private rootDir: string | undefined;
	private outDir: string | undefined;
	private dependentOutDirs: string[];
	private currentSourceFile: ts.SourceFile | undefined;
	private _currentDocument: Document | undefined;
	private _currentExports: Set<ts.Symbol> | undefined;
	private symbolContainer: RangeBasedDocumentSymbol[];
	private recordDocumentSymbol: boolean[];
	private documents: Map<string, DocumentInformation>;
	private packageInfos: Map<string, PackageInformation>;
	private externalLibraryImports: Map<string, ts.ResolvedModuleFull>;
	private _emitOnEndVisit: Map<ts.Node, (Vertex | Edge)[]>;

	constructor(private languageService: ts.LanguageService, options: Options, dependsOn: ProjectInfo[], private emitter: Emitter, idGenerator: () => Id, tsConfigFile: string | undefined) {
		this.builder = new Builder({
			idGenerator,
			emitSource: !options.noContents
		});
		this.symbolContainer = [];
		this.recordDocumentSymbol = [];
		this.documents = new Map();
		this.externalLibraryImports = new Map();
		this.packageInfos = new Map();
		this._emitOnEndVisit = new Map();
		this.dependentOutDirs = [];
		for (let info of dependsOn) {
			this.dependentOutDirs.push(info.outDir);
		}
		this.dependentOutDirs.sort((a, b) => {
			return b.length - a.length;
		})
		this.emit(this.vertex.metaData(Version));
		this.project = this.vertex.project();
		this.projectRoot = options.project;
		const configLocation = tsConfigFile !== undefined ? path.dirname(tsConfigFile) : undefined;
		let compilerOptions = this.program.getCompilerOptions();
		if (compilerOptions.outDir !== undefined) {
			this.outDir = tss.makeAbsolute(compilerOptions.outDir, configLocation);
		}
		if (compilerOptions.rootDir !== undefined) {
			this.rootDir = tss.makeAbsolute(compilerOptions.rootDir, configLocation);
		} else {
			// Try to compute the root directories.
		}
		this.emit(this.project);
	}

	public visitProgram(): ProjectInfo {
		// Make a first pass to collect all know external libray imports
		for (let sourceFile of this.program.getSourceFiles()) {
			let resolvedModules = tss.getResolvedModules(sourceFile);
			if (resolvedModules !== undefined) {
				resolvedModules.forEach((resolvedModule) => {
					if (resolvedModule === undefined) {
						return;
					}
					if (resolvedModule.isExternalLibraryImport === true) {
						if (!this.externalLibraryImports.has(resolvedModule.resolvedFileName)) {
							this.externalLibraryImports.set(resolvedModule.resolvedFileName, resolvedModule);
						}
					}
				});
			}
		}

		for (let sourceFile of this.program.getSourceFiles()) {
			// let start = Date.now();
			this.visit(sourceFile);
			// let end = Date.now();
			// console.log(`Processing ${sourceFile.fileName} took ${end-start} ms`);
		}
		return {
			rootDir: this.rootDir!,
			outDir: this.outDir!
		};
	}

	public emitOnEndVisit(node: ts.Node, toEmit: (Vertex | Edge)[]): void {
		let current = this._emitOnEndVisit.get(node);
		if (current !== undefined) {
			current.push(...toEmit);
		} else {
			this._emitOnEndVisit.set(node, toEmit);
		}
	}

	public getEmittingNode(toEmit: Vertex | Edge): ts.Node | undefined {
		// We assume this is not called to often so we don't spent a hash map for now
		for (let entry of this._emitOnEndVisit.entries()) {
			let [key, elements] = entry;
			if (elements.indexOf(toEmit) !== -1) {
				return key;
			}
		}
		return undefined;
	}

	protected visit(node: ts.Node): void {
		switch (node.kind) {
			case ts.SyntaxKind.SourceFile:
				this.doVisit(this.visitSourceFile, this.endVisitSourceFile, node as ts.SourceFile);
				break;
			case ts.SyntaxKind.ModuleDeclaration:
				this.doVisit(this.visitModuleDeclaration, this.endVisitModuleDeclaration, node as ts.ModuleDeclaration);
				break;
			case ts.SyntaxKind.ClassDeclaration:
				this.doVisit(this.visitClassOrInterfaceDeclaration, this.endVisitClassOrInterfaceDeclaration, node as (ts.ClassDeclaration | ts.InterfaceDeclaration));
				break;
			case ts.SyntaxKind.InterfaceDeclaration:
				this.doVisit(this.visitClassOrInterfaceDeclaration, this.endVisitClassOrInterfaceDeclaration, node as (ts.ClassDeclaration | ts.InterfaceDeclaration));
				break;
			case ts.SyntaxKind.TypeParameter:
				this.doVisit(this.visitTypeParameter, this.endVisitTypeParameter, node as ts.TypeParameterDeclaration);
				break;
			case ts.SyntaxKind.MethodDeclaration:
				this.doVisit(this.visitMethodDeclaration, this.endVisitMethodDeclaration, node as ts.MethodDeclaration);
				break;
			case ts.SyntaxKind.MethodSignature:
				this.doVisit(this.visitMethodSignature, this.endVisitMethodSignature, node as ts.MethodSignature);
				break;
			case ts.SyntaxKind.FunctionDeclaration:
				this.doVisit(this.visitFunctionDeclaration, this.endVisitFunctionDeclaration, node as ts.FunctionDeclaration);
				break;
			case ts.SyntaxKind.Parameter:
				this.doVisit(this.visitParameterDeclaration, this.endVisitParameterDeclaration, node as ts.ParameterDeclaration);
				break;
			case ts.SyntaxKind.ClassExpression:
				this.doVisit(this.visitClassExpression, this.endVisitClassExpression, node as ts.ClassExpression);
			case ts.SyntaxKind.Identifier:
				let identifier = node as ts.Identifier;
				this.visitIdentifier(identifier);
				break;
			default:
				node.forEachChild(child => this.visit(child));
		}
	}

	private doVisit<T extends ts.Node>(visit: (node: T) => boolean, endVisit: (node: T) => void, node: T): void {
		if (visit.call(this, node)) {
			node.forEachChild(child => this.visit(child));
		}
		endVisit.call(this, node);
		let toEmit = this._emitOnEndVisit.get(node);
		if (toEmit) {
			this._emitOnEndVisit.delete(node);
			toEmit.forEach(this.emit, this);
		}
	}

	private visitSourceFile(sourceFile: ts.SourceFile): boolean {
		if (this.isFullContentIgnored(sourceFile)) {
			return false;
		}
		// process.stderr.write('.');

		this.currentSourceFile = sourceFile;
		let info = this.getDocumentAndEmitIfNecessary(sourceFile);
		this._currentDocument = info.document;
		this.symbolContainer.push({ id: info.document.id, children: [] });
		this.recordDocumentSymbol.push(true);

		// Exported Symbols
		let symbol = this.program.getTypeChecker().getSymbolAtLocation(sourceFile);
		let symbols: Set<ts.Symbol> = new Set();
		if (symbol !== undefined) {
			this.collectExportedSymbols(symbols, symbol);
		}
		this._currentExports = symbols;

		return true;
	}

	private collectExportedSymbols(symbols: Set<ts.Symbol>, symbol: ts.Symbol): void {
		symbols.add(symbol);
		if (symbol.exports !== undefined && symbol.exports.size > 0) {
			symbol.exports.forEach(item => this.collectExportedSymbols(symbols, item));
		}
	}

	private endVisitSourceFile(sourceFile: ts.SourceFile): void {
		if (this.isFullContentIgnored(sourceFile)) {
			return;
		}

		let path = tss.computeMonikerPath(this.projectRoot, tss.toOutLocation(sourceFile.fileName, this.rootDir!, this.outDir!));

		// Exported symbols.
		let symbol = this.program.getTypeChecker().getSymbolAtLocation(sourceFile);
		if (symbol !== undefined) {
			if (symbol.exports !== undefined && symbol.exports.size > 0) {
				symbol.exports.forEach(item => this.emitExportMonikers(path, undefined, item));
			}
		}
		this._currentExports = undefined;

		// Diagnostics
		let diagnostics: lsp.Diagnostic[] = [];
		let syntactic = this.program.getSyntacticDiagnostics(sourceFile);
		for (let element of syntactic) {
			diagnostics.push(Converter.asDiagnostic(element));
		}
		let semantic = this.program.getSemanticDiagnostics(sourceFile);
		for (let element of semantic) {
			if (element.file !== undefined && element.start !== undefined && element.length !== undefined) {
				diagnostics.push(Converter.asDiagnostic(element as ts.DiagnosticWithLocation));
			}
		}
		if (diagnostics.length > 0) {
			let set = this.vertex.diagnosticResult(diagnostics);
			this.emit(set);
			this.emit(this.edge.diagnostic(this.currentDocument, set));
		}

		// Folding ranges
		let spans = this.languageService.getOutliningSpans(sourceFile.fileName);
		if (ts.textSpanEnd.length > 0) {
			let foldingRanges: lsp.FoldingRange[] = [];
			for (let span of spans) {
				foldingRanges.push(Converter.asFoldingRange(sourceFile,span));
			}
			if (foldingRanges.length > 0) {
				let foldingRangeResult = this.vertex.foldingRangeResult(foldingRanges)
				this.emit(foldingRangeResult);
				this.emit(this.edge.foldingRange(this.currentDocument, foldingRangeResult));
			}
		}

		let values = (this.symbolContainer.pop() as RangeBasedDocumentSymbol).children;
		if (values !== undefined && values.length > 0) {
			let set = this.vertex.documentSymbolResult(values);
			this.emit(set);
			this.emit(this.edge.documentSymbols(this.currentDocument, set));
		}
		this.recordDocumentSymbol.pop();

		this.currentSourceFile = undefined;
		this._currentDocument = undefined;
		if (this.symbolContainer.length !== 0) {
			throw new Error(`Unbalanced begin / end calls`);
		}
	}

	private emitExportMonikers(path: string | undefined, prefix: string | undefined, symbol: ts.Symbol): void  {
		const name  = symbol.getName();
		let symbolItem = this.getSymbolInfo(symbol);
		if (symbolItem !== undefined) {
			let fullName = prefix !== undefined ? `${prefix}.${name}` : name;
			let moniker = this.vertex.moniker(MonikerKind.export, 'tsc', tss.createMonikerIdentifier(path, fullName));
			this.emit(moniker);
			let declarations = symbolItem.declarations;
			if (declarations !== undefined) {
				if (Array.isArray(declarations)) {
					for (let declaration of declarations) {
						this.emit(this.edge.moniker(declaration, moniker));
					}
				} else {
					this.emit(this.edge.moniker(declarations, moniker));
				}
			}
		}
		if (symbol.exports !== undefined && symbol.exports.size > 0) {
			symbol.exports.forEach(item => this.emitExportMonikers(path, name, item));
		}
		if (symbol.members !== undefined && symbol.members.size > 0) {
			symbol.members.forEach(item => {
				if (!SymbolItem.isPrivate(item)) {
					this.emitExportMonikers(path, name, item);
				}
			});
		}

	}

	public isFullContentIgnored(sourceFile: ts.SourceFile): boolean {
		if (sourceFile.isDeclarationFile) {
			return true;
		}
		let fileName = sourceFile.fileName;
		if (path.basename(fileName) === 'index.js') {
			return false;
		}
		if (path.extname(fileName) !== '.js') {
			return false;
		}
		let dirName: string;
		let parent: string = path.dirname(fileName);
		do {
			dirName = parent;
			if (path.basename(dirName) === 'node_modules') {
				return true;
			}
			parent = path.dirname(dirName);
		} while (parent !== dirName)
		return false;
	}

	public isExported(symbol: ts.Symbol): boolean {
		if (this._currentExports === undefined) {
			return false;
		}
		return this._currentExports.has(symbol);
	}

	private visitModuleDeclaration(node: ts.ModuleDeclaration): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitModuleDeclaration(node: ts.ModuleDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitClassOrInterfaceDeclaration(node: ts.ClassDeclaration | ts.InterfaceDeclaration): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitClassOrInterfaceDeclaration(node: ts.ClassDeclaration | ts.InterfaceDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitMethodDeclaration(node: ts.MethodDeclaration): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitMethodDeclaration(node: ts.MethodDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitMethodSignature(node: ts.MethodSignature): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitMethodSignature(node: ts.MethodSignature): void {
		this.endVisitDeclaration(node);
	}

	private visitFunctionDeclaration(node: ts.FunctionDeclaration): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitFunctionDeclaration(node: ts.FunctionDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitParameterDeclaration(node: ts.ParameterDeclaration): boolean {
		this.visitDeclaration(node, false);
		return true;
	}

	private endVisitParameterDeclaration(node: ts.ParameterDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitTypeParameter(node: ts.TypeParameterDeclaration): boolean {
		this.visitDeclaration(node, false);
		return true;
	}

	private endVisitTypeParameter(node: ts.TypeParameterDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitClassExpression(node: ts.ClassExpression): boolean {
		return true;
	}

	private endVisitClassExpression(node: ts.ClassExpression): void {
	}

	private visitDeclaration(node: tss.Declaration, isContainer: boolean): void {
		let recordDocumentSymbol: boolean = this.currentRecordDocumentSymbol && isContainer;
		let didRecord: boolean = recordDocumentSymbol;
		if (recordDocumentSymbol) {
			didRecord = this.addDocumentSymbol(node);
		}
		this.recordDocumentSymbol.push(didRecord);
		return;
	}

	private endVisitDeclaration(node: tss.Declaration): void {
		let didRecord = this.recordDocumentSymbol.pop();
		if (didRecord) {
			this.symbolContainer.pop();
		}
	}

	private addDocumentSymbol(node: tss.Declaration): boolean {
		let rangeNode = node.name !== undefined ? node.name : node;
		let symbol = this.program.getTypeChecker().getSymbolAtLocation(rangeNode);
		let declarations = symbol !== undefined ? symbol.getDeclarations() : undefined;
		if (symbol === undefined || declarations === undefined || declarations.length === 0) {
			return false;
		}
		let symbolInfo = this.getSymbolInfo(symbol);
		if (symbolInfo === undefined) {
			return false;
		}
		let declaration = symbolInfo.getDeclaration(rangeNode);
		if (declaration === undefined) {
			return false;
		}
		let currentContainer = this.symbolContainer[this.symbolContainer.length - 1];
		let child: RangeBasedDocumentSymbol = { id: declaration.id };
		if (currentContainer.children === undefined) {
			currentContainer.children = [ child ];
		} else {
			currentContainer.children.push(child);
		}
		this.symbolContainer.push(child);
		return true;
	}

	private visitIdentifier(node: ts.Identifier): void {
		let symbol = this.program.getTypeChecker().getSymbolAtLocation(node);
		let declarations = symbol !== undefined ? symbol.getDeclarations() : undefined;
		if (symbol === undefined || declarations === undefined || declarations.length === 0) {
			return;
		}
		let symbolInfo = this.getSymbolInfo(symbol);
		if (symbolInfo === undefined) {
			return;
		}
		if (symbolInfo.hasDeclaration(node)) {
			return;
		}

		let sourceFile = this.currentSourceFile!;
		let reference = this.vertex.range(Converter.rangeFromNode(sourceFile, node), { type: RangeTagTypes.reference, text: node.getText() });
		this.emit(reference);
		this.emit(this.edge.contains(this.currentDocument, reference));
		symbolInfo.addReference(reference);
	}

	public getDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined {
		return this.languageService.getDefinitionAtPosition(sourceFile.fileName, node.getStart(sourceFile));
	}

	public getTypeDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined {
		return this.languageService.getTypeDefinitionAtPosition(sourceFile.fileName, node.getStart(sourceFile));
	}

	public getDocumentAndEmitIfNecessary(file: ts.SourceFile): DocumentInformation {
		const computeMonikerPath = (sourceFile: ts.SourceFile): string | undefined => {
			if (!sourceFile.isDeclarationFile) {
				return undefined;
			}
			let fileName = sourceFile.fileName;
			for (let outDir of this.dependentOutDirs) {
				if (fileName.startsWith(outDir)) {
					return tss.computeMonikerPath(this.projectRoot, sourceFile.fileName);
				}
			}
			return undefined;
		}

		let result: DocumentInformation | undefined = this.documents.get(file.fileName);
		if (result !== undefined) {
			return result;
		}

		let document = this.vertex.document(file.fileName, file.text)

		let resolvedModule = this.externalLibraryImports.get(file.fileName);
		let monikerPath: string | undefined;
		let packageInfo: PackageInformation | undefined;
		if (resolvedModule !== undefined) {
			if (resolvedModule.packageId !== undefined) {
				let packageId = resolvedModule.packageId;
				let key: string = JSON.stringify([packageId.name, 'npm', packageId.version]);
				packageInfo = this.packageInfos.get(key);
				if (packageInfo === undefined) {
					packageInfo = this.vertex.packageInformation(packageId.name, 'npm');
					packageInfo.version = packageId.version;
					let modulePart = `node_modules/${packageId.name}`;
					let index = file.fileName.lastIndexOf(modulePart);
					if (index !== -1) {
						let packageFile = path.join(file.fileName.substring(0, index + modulePart.length), 'package.json');
						if (fs.existsSync(packageFile)) {
							packageInfo.uri = URI.file(packageFile).toString(true);
						}
					}
					this.emit(packageInfo);
					this.packageInfos.set(key, packageInfo);
				}
			}
			monikerPath = tss.computeMonikerPath(this.projectRoot, file.fileName);
		} else {
			monikerPath = computeMonikerPath(file);
		}

		result = { document };
		this.emit(document);
		if (monikerPath !== undefined) {
			result.monikerPath = monikerPath;
			result.monikerKind = MonikerKind.import;
		}
		if (packageInfo != undefined) {
			result.packageInfo = packageInfo;
		}
		if (this.project) {
			this.emit(this.edge.contains(this.project, result.document));
		}
		this.documents.set(file.fileName, result);
		return result;
	}

	public getHover(node: ts.DeclarationName, sourceFile?: ts.SourceFile): HoverResult | undefined {
		if (sourceFile === undefined) {
			sourceFile = node.getSourceFile();
		}
		let quickInfo = this.languageService.getQuickInfoAtPosition(sourceFile.fileName, node.getStart());
		if (quickInfo === undefined) {
			return undefined;
		}
		let lspHover = Converter.asHover(sourceFile, quickInfo);
		return this.vertex.hoverResult(lspHover.contents);
	}

	private get program(): ts.Program {
		return this.languageService.getProgram()!;
	}

	public get vertex(): VertexBuilder {
		return this.builder.vertex;
	}

	public get edge(): EdgeBuilder {
		return this.builder.edge;
	}

	public get typeChecker(): ts.TypeChecker {
		return this.languageService.getProgram()!.getTypeChecker();
	}

	public emit(element: Vertex | Edge): void {
		this.emitter.emit(element);
	}

	private get currentDocument(): Document {
		if (this._currentDocument === undefined) {
			throw new Error(`No current document`);
		}
		return this._currentDocument;
	}

	private get currentRecordDocumentSymbol(): boolean {
		return this.recordDocumentSymbol[this.recordDocumentSymbol.length - 1];
	}

	private getSymbolInfo(tsSymbol: ts.Symbol): SymbolItem | undefined {
		return SymbolItem.get(this, tsSymbol);
	}
}


export function lsif(languageService: ts.LanguageService, options: Options, dependsOn: ProjectInfo[], emitter: Emitter, idGenerator: () => Id, tsConfigFile: string | undefined): ProjectInfo {
	return new Visitor(languageService, options, dependsOn, emitter, idGenerator, tsConfigFile).visitProgram();
}