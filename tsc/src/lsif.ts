/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';
// In typescript all paths are /. So use the posix layer only
import * as path from 'path';

import { URI } from 'vscode-uri';
import * as ts from 'typescript';

import * as tss from './typescripts';

import {
	lsp, Vertex, Edge, Project, Document, Id, ReferenceResult, RangeTagTypes, RangeBasedDocumentSymbol,
	ResultSet, DefinitionRange, DefinitionResult, MonikerKind, ItemEdgeProperties,
	Version, Range, EventKind
} from 'lsif-protocol';

import { VertexBuilder, EdgeBuilder, Builder } from './graph';

import { Emitter } from './emitters/emitter';
import { LRUCache } from './utils/linkedMap';

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
		let start: ts.LineAndCharacter;
		if (file === node) {
			start = { line: 0, character: 0 };
		} else {
			start = file.getLineAndCharacterOfPosition(node.getStart(file, includeJsDocComment));
		}
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

type SymbolId = string;

interface EmitContext {
	vertex: VertexBuilder;
	edge: EdgeBuilder;
	emit(element: Vertex | Edge): void;
}

interface SymbolDataContext extends EmitContext {
	getDocumentData(fileName: string): DocumentData | undefined;
	getOrCreateSymbolData(symbolId: SymbolId, create: () => SymbolData): SymbolData;
	manageLifeCycle(node: ts.Node, symbolData: SymbolData): void;
}

abstract class LSIFData {
	protected constructor(protected context: SymbolDataContext) {
	}

	public abstract begin(): void;

	public abstract end(): void;

	protected emit(value: Vertex | Edge): void {
		this.context.emit(value);
	}

	protected get vertex(): VertexBuilder {
		return this.context.vertex;
	}

	protected get edge(): EdgeBuilder {
		return this.context.edge;
	}
}

class ProjectData extends LSIFData {

	private documents: Document[];
	private diagnostics: lsp.Diagnostic[];

	public constructor(context: SymbolDataContext, private project: Project) {
		super(context);
		this.documents = [];
		this.diagnostics = [];
	}

	public begin(): void {
		this.emit(this.project);
		this.emit(this.vertex.event(EventKind.begin, this.project));
	}

	public addDocument(document: Document): void {
		this.documents.push(document);
		if (this.documents.length > 32) {
			this.emit(this.edge.contains(this.project, this.documents));
			this.documents = [];
		}
	}

	public addDiagnostic(diagnostic: lsp.Diagnostic): void {
		this.diagnostics.push(diagnostic);
	}

	public end(): void {
		if (this.documents.length > 0) {
			this.emit(this.edge.contains(this.project, this.documents));
			this.documents = [];
		}
		if (this.diagnostics.length > 0) {
			let dr = this.vertex.diagnosticResult(this.diagnostics);
			this.emit(dr);
			this.emit(this.edge.diagnostic(this.project, dr));
		}
		this.emit(this.vertex.event(EventKind.end, this.project));
	}
}

class DocumentData extends LSIFData {

	private ranges: Range[];
	private diagnostics: lsp.Diagnostic[] | undefined;
	private foldingRanges: lsp.FoldingRange[] | undefined;
	private documentSymbols: RangeBasedDocumentSymbol[] | undefined;

	public constructor(context: SymbolDataContext, public document: Document, public monikerPath: string | undefined, public externalLibrary: boolean) {
		super(context);
		this.ranges = [];
	}

	public begin(): void {
		this.emit(this.document);
		this.emit(this.vertex.event(EventKind.begin, this.document));
	}

	public addRange(range: Range): void {
		this.emit(range);
		this.ranges.push(range);
	}

	public addDiagnostics(diagnostics: lsp.Diagnostic[]): void {
		this.diagnostics = diagnostics;
	}

	public addFoldingRanges(foldingRanges: lsp.FoldingRange[]): void {
		this.foldingRanges = foldingRanges;
	}

	public addDocumentSymbols(documentSymbols: RangeBasedDocumentSymbol[]): void {
		this.documentSymbols = documentSymbols;
	}

	public end(): void {
		if (this.ranges.length >= 0) {
			this.emit(this.edge.contains(this.document, this.ranges));
		}
		if (this.diagnostics !== undefined) {
			let dr = this.vertex.diagnosticResult(this.diagnostics);
			this.emit(dr);
			this.emit(this.edge.diagnostic(this.document, dr));
		}
		if (this.foldingRanges !== undefined) {
			const fr = this.vertex.foldingRangeResult(this.foldingRanges);
			this.emit(fr);
			this.emit(this.edge.foldingRange(this.document, fr));
		}
		if (this.documentSymbols !== undefined) {
			const ds = this.vertex.documentSymbolResult(this.documentSymbols);
			this.emit(ds);
			this.emit(this.edge.documentSymbols(this.document, ds));
		}
		this.emit(this.vertex.event(EventKind.end, this.document));
	}
}

abstract class SymbolData extends LSIFData {

	private declarationInfo: tss.DefinitionInfo | tss.DefinitionInfo[] | undefined;

	protected resultSet: ResultSet;

	public constructor(context: SymbolDataContext, private id: SymbolId) {
		super(context);
		this.resultSet = this.vertex.resultSet();
	}

	public getId(): string {
		return this.id;
	}

	public getResultSet(): ResultSet {
		return this.resultSet;
	}

	public begin(): void {
		this.emit(this.resultSet);
	}

	public recordDefinitionInfo(info: tss.DefinitionInfo): void {
		if (this.declarationInfo === undefined) {
			this.declarationInfo = info;
		} else if (Array.isArray(this.declarationInfo)) {
			this.declarationInfo.push(info);
		} else {
			this.declarationInfo = [this.declarationInfo];
			this.declarationInfo.push(info);
		}
	}

	public hasDefinitionInfo(info: tss.DefinitionInfo): boolean {
		if (this.declarationInfo === undefined) {
			return false;
		} else if (Array.isArray(this.declarationInfo)) {
			for (let item of this.declarationInfo) {
				if (tss.DefinitionInfo.equals(item, info)) {
					return true;
				}
			}
			return false;
		} else {
			return tss.DefinitionInfo.equals(this.declarationInfo, info);
		}
	}

	public addHover(hover: lsp.Hover) {
		let hr = this.vertex.hoverResult(hover);
		this.emit(hr);
		this.emit(this.edge.hover(this.resultSet, hr));
	}

	public addMoniker(kind: MonikerKind, identifier: string): void {
		let moniker = this.vertex.moniker(kind, 'tsc', identifier);
		this.emit(moniker);
		this.emit(this.edge.moniker(this.resultSet, moniker));
	}

	public abstract getOrCreateDefinitionResult(): DefinitionResult;

	public abstract addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void;
	public abstract findDefinition(sourceFile: ts.SourceFile, range: lsp.Range): DefinitionRange | undefined;

	public abstract getOrCreateReferenceResult(): ReferenceResult;

	public abstract addReference(sourceFile: ts.SourceFile, reference: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public abstract addReference(sourceFile: ts.SourceFile, reference: ReferenceResult): void;

	public abstract getOrCreatePartition(sourceFile: ts.SourceFile): SymbolDataPartition;

	public abstract nodeProcessed(node: ts.Node): boolean;
}

class StandardSymbolData extends SymbolData {

	private definitionResult: DefinitionResult | undefined;
	private referenceResult: ReferenceResult | undefined;

	private partitions: Map<string /* filename */, SymbolDataPartition | null> | null | undefined;

	public constructor(context: SymbolDataContext, id: SymbolId, private scope: ts.Node | undefined = undefined) {
		super(context, id);
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange, recordAsReference: boolean = true): void {
		this.emit(this.edge.next(definition, this.resultSet));
		this.getOrCreatePartition(sourceFile).addDefinition(definition, recordAsReference);
	}

	public findDefinition(sourceFile: ts.SourceFile, range: lsp.Range): DefinitionRange | undefined {
		if (this.partitions === undefined) {
			return undefined;
		}
		if (this.partitions === null) {
			throw new Error(`The symbol data has already been cleared`);
		}
		let partition = this.partitions.get(sourceFile.fileName);
		if (partition === null) {
			throw new Error(`The partition for source file ${sourceFile.fileName}`);
		}
		if (partition === undefined) {
			return undefined;
		}
		return partition.findDefinition(range);
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === 'range') {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		this.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
	}

	public getOrCreateDefinitionResult(): DefinitionResult {
		if (this.definitionResult === undefined ) {
			this.definitionResult = this.vertex.definitionResult();
			this.emit(this.definitionResult);
			this.emit(this.edge.definition(this.resultSet, this.definitionResult));
		}
		return this.definitionResult;
	}

	public getOrCreateReferenceResult(): ReferenceResult {
		if (this.referenceResult === undefined) {
			this.referenceResult = this.vertex.referencesResult();
			this.emit(this.referenceResult);
			this.emit(this.edge.references(this.resultSet, this.referenceResult));
		}
		return this.referenceResult;
	}

	public getOrCreatePartition(sourceFile: ts.SourceFile): SymbolDataPartition {
		let fileName = sourceFile.fileName;
		if (this.partitions === null) {
			throw new Error (`Partition for symbol ${this.getId()} have already been cleared`);
		}
		if (this.partitions === undefined) {
			this.partitions = new Map();
		}
		let result = this.partitions.get(fileName);
		if (result === null) {
			throw new Error (`Partition for file ${fileName} has already been cleared.`);
		}
		if (result === undefined) {
			let documentData = this.context.getDocumentData(fileName);
			if (documentData === undefined) {
				throw new Error(`No document data for ${fileName}`);
			}
			result = new SymbolDataPartition(this.context, this, documentData.document);
			this.context.manageLifeCycle(sourceFile, this);
			result.begin();
			this.partitions.set(fileName, result);
		}
		return result;
	}

	public nodeProcessed(node: ts.Node): boolean {
		if (this.partitions === undefined) {
			return true;
		}
		if (this.partitions === null) {
			throw new Error (`Partition for symbol ${this.getId()} have already been cleared`);
		}
		if (node === this.scope) {
			if (this.partitions.size !== 1) {
				throw new Error(`Local Symbol data has more than one partition.`);
			}
			let parition = this.partitions.values().next().value;
			if (parition !== null) {
				parition.end();
			}
			this.partitions = null;
			return true;
		} else if (ts.isSourceFile(node)) {
			let fileName = node.fileName;
			let partition = this.partitions.get(fileName);
			if (partition === null) {
				throw new Error (`Partition for file ${fileName} has already been cleared.`);
			}
			if (partition === undefined) {
				throw new Error(`Symbol data doesn't manage a partition for ${fileName}`);
			}
			partition.end();
			this.partitions.set(fileName, null);
			return false;
		} else {
			throw new Error(`Node is neither a source file nor does it match the scope`);
		}
	}

	public end(): void {
		if (this.partitions === undefined) {
			return;
		}
		if (this.partitions === null) {
			throw new Error (`Partition for symbol ${this.getId()} have already been cleared`);
		}
		for (let entry of this.partitions.entries()) {
			if (entry[1] !== null) {
				entry[1].end();
				this.partitions.set(entry[0], null);
			}
		}
	}
}

class AliasedSymbolData extends StandardSymbolData {

	constructor(context: SymbolDataContext, id: string, private aliased: SymbolData, scope: ts.Node | undefined = undefined, private rename: boolean = false) {
		super(context, id, scope);
	}

	public begin(): void {
		super.begin();
		this.emit(this.edge.next(this.resultSet, this.aliased.getResultSet()));
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void {
		if (this.rename) {
			super.addDefinition(sourceFile, definition, false);
		} else {
			this.emit(this.edge.next(definition, this.resultSet));
			this.aliased.getOrCreatePartition(sourceFile).addReference(definition, ItemEdgeProperties.references);
		}
	}

	public findDefinition(sourceFile: ts.SourceFile, range: lsp.Range): DefinitionRange | undefined {
		if (this.rename) {
			return super.findDefinition(sourceFile, range);
		} else {
			return this.aliased.findDefinition(sourceFile, range);
		}
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === 'range') {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		this.aliased.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
	}

	public getOrCreateReferenceResult(): ReferenceResult {
		throw new Error(`Shouldn't be called`);
	}
}

class MethodSymbolData extends StandardSymbolData {

	private sourceFile: ts.SourceFile | undefined;
	private bases: SymbolData[] | undefined;

	constructor(context: SymbolDataContext, id: string, sourceFile: ts.SourceFile, bases: SymbolData[] | undefined, scope: ts.Node | undefined = undefined) {
		super(context, id, scope);
		this.sourceFile = sourceFile;
		if (bases !== undefined && bases.length === 0) {
			this.bases = undefined;
		} else {
			this.bases = bases;
		}
	}

	public begin(): void {
		super.begin();
		if (this.bases !== undefined) {
			for (let base of this.bases) {
				// We take the first source file to cluster this. We might want to find a source
				// file that has already changed to make the diff minimal.
				super.addReference(this.sourceFile!, base.getOrCreateReferenceResult());
			}
		}
		this.sourceFile = undefined;
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void {
		super.addDefinition(sourceFile, definition, this.bases === undefined);
		if (this.bases !== undefined) {
			for (let base of this.bases) {
				base.getOrCreatePartition(sourceFile).addReference(definition, ItemEdgeProperties.definitions);
			}
		}
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (this.bases !== undefined) {
			if (reference.label === 'range') {
				this.emit(this.edge.next(reference, this.resultSet));
			}
			for (let base of this.bases) {
				base.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
			}
		} else {
			super.addReference(sourceFile, reference as any, property as any);
		}
	}
}

class UnionOrIntersectionSymbolData extends StandardSymbolData {

	private sourceFile: ts.SourceFile | undefined;
	private elements: SymbolData[];

	constructor(context: SymbolDataContext, id: string, sourceFile: ts.SourceFile, elements: SymbolData[]) {
		super(context, id, undefined);
		this.elements = elements;
		this.sourceFile = sourceFile;
	}

	public begin(): void {
		super.begin();
		for (let element of this.elements) {
			// We take the first source file to cluster this. We might want to find a source
			// file that has already changed to make the diff minimal.
			super.addReference(this.sourceFile!, element.getOrCreateReferenceResult());
		}
		this.sourceFile = undefined;
	}

	public recordDefinitionInfo(info: tss.DefinitionInfo): void {
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void {
		// We don't do anoything for definitions since they a transient anyways.
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === 'range') {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		for (let element of this.elements) {
			element.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
		}
	}
}

class SymbolDataPartition extends LSIFData {

	private definitionRanges: DefinitionRange[] | undefined;

	private referenceRanges: Map<ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references, Range[]> | undefined;
	private referenceResults: ReferenceResult[] | undefined;

	public constructor(context: SymbolDataContext, private symbolData: SymbolData, private document: Document) {
		super(context);
	}

	public begin(): void {
		// Do nothing.
	}

	public addDefinition(value: DefinitionRange, recordAsReference: boolean = true): void {
		if (this.definitionRanges === undefined) {
			this.definitionRanges = [];
		}
		this.definitionRanges.push(value);
		if (recordAsReference) {
			this.addReference(value, ItemEdgeProperties.definitions);
		}
	}

	public findDefinition(range: lsp.Range): DefinitionRange | undefined {
		if (this.definitionRanges === undefined) {
			return undefined;
		}
		for (let definitionRange of this.definitionRanges) {
			if (definitionRange.start.line === range.start.line && definitionRange.start.character === range.start.character &&
				definitionRange.end.line === range.end.line && definitionRange.end.character === range.end.character) {
					return definitionRange;
			}
		}
		return undefined;
	}

	public addReference(value: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public addReference(value: ReferenceResult): void;
	public addReference(value: Range | ReferenceResult, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (value.label === 'range' && property !== undefined) {
			if (this.referenceRanges === undefined) {
				this.referenceRanges = new Map();
			}
			let values = this.referenceRanges.get(property);
			if (values === undefined) {
				values = [];
				this.referenceRanges.set(property, values);
			}
			values.push(value);
		} else if (value.label === 'referenceResult') {
			if (this.referenceResults === undefined) {
				this.referenceResults = [];
			}
			this.referenceResults.push(value);
		}
	}

	public end(): void {
		if (this.definitionRanges !== undefined) {
			let definitionResult = this.symbolData.getOrCreateDefinitionResult();
			this.emit(this.edge.item(definitionResult, this.definitionRanges, this.document));
		}
		if (this.referenceRanges !== undefined) {
			let referenceResult = this.symbolData.getOrCreateReferenceResult();
			for (let property of this.referenceRanges.keys()) {
				let values = this.referenceRanges.get(property)!;
				this.emit(this.edge.item(referenceResult, values, this.document, property))
			}
		}
		if (this.referenceResults !== undefined) {
			let referenceResult = this.symbolData.getOrCreateReferenceResult();
			this.emit(this.edge.item(referenceResult, this.referenceResults, this.document));
		}
	}
}

class Symbols {

	private baseSymbolCache: LRUCache<string, ts.Symbol[]>;
	private baseMemberCache: LRUCache<string, LRUCache<string, ts.Symbol[]>>;
	private exportedPaths: LRUCache<ts.Symbol, string | null>;

	constructor(private typeChecker: ts.TypeChecker) {
		this.baseSymbolCache = new LRUCache(2048);
		this.baseMemberCache = new LRUCache(2048);
		this.exportedPaths = new LRUCache(2048);
	}

	public getBaseSymbols(symbol: ts.Symbol): ts.Symbol[] | undefined {
		let key = tss.createSymbolKey(this.typeChecker, symbol);
		let result = this.baseSymbolCache.get(key);
		if (result === undefined) {
			if (tss.isTypeLiteral(symbol)) {
				return undefined;
			} else if (tss.isInterface(symbol)) {
				result = this.computeBaseSymbolsForInterface(symbol);
			} else if (tss.isClass(symbol)) {
				result = this.computeBaseSymbolsForClass(symbol);
			}
			if (result !== undefined) {
				this.baseSymbolCache.set(key, result);
			}
		}
		return result;
	}

	private computeBaseSymbolsForClass(symbol: ts.Symbol): ts.Symbol[] | undefined {
		let result: ts.Symbol[] = [];
		let declarations = symbol.getDeclarations();
		if (declarations === undefined) {
			return undefined;
		}
		let typeChecker = this.typeChecker;
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

	private computeBaseSymbolsForInterface(symbol: ts.Symbol): ts.Symbol[] | undefined {
		let result: ts.Symbol[] = [];
		let tsType = this.typeChecker.getDeclaredTypeOfSymbol(symbol);
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


	public findBaseMembers(symbol: ts.Symbol, memberName: string): ts.Symbol[] | undefined {
		let key = tss.createSymbolKey(this.typeChecker, symbol);
		let cache = this.baseMemberCache.get(key);
		if (cache === undefined) {
			cache = new LRUCache(64);
			this.baseMemberCache.set(key, cache);
		}
		let result: ts.Symbol[] | undefined = cache.get(memberName);
		if (result === undefined) {
			let baseSymbols = this.getBaseSymbols(symbol);
			if (baseSymbols !== undefined) {
				for (let base of baseSymbols) {
					if (!base.members) {
						continue;
					}
					let method = base.members.get(memberName as ts.__String);
					if (method !== undefined) {
						if (result === undefined) {
							result = [method];
						} else {
							result.push(method);
						}
					} else {
						let baseResult = this.findBaseMembers(base, memberName);
						if (baseResult !== undefined) {
							if (result === undefined) {
								result = baseResult;
							} else {
								result.push(...baseResult);
							}
						}
					}
				}
			}
			if (result !== undefined) {
				cache.set(memberName, result);
			} else {
				cache.set(memberName, []);
			}
		} else if (result.length === 0) {
			return undefined;
		}
		return result;
	}

	public getExportPath(symbol: ts.Symbol): string | null {
		let result = this.exportedPaths.get(symbol);
		if (result !== undefined) {
			return result;
		}
		if (tss.isSourceFile(symbol)) {
			this.exportedPaths.set(symbol, '');
			return '';
		}
		let parent = tss.getSymbolParent(symbol);
		if (parent === undefined) {
			this.exportedPaths.set(symbol, null);
			return null;
		} else {
			let parentValue = this.getExportPath(parent);
			// The parent is not exported so any member isn't either
			if (parentValue === null) {
				this.exportedPaths.set(symbol, null);
				return null;
			} else {
				if (tss.isInterface(parent) || tss.isClass(parent)) {
					result = `${parentValue}.${symbol.getName()}`;
					this.exportedPaths.set(symbol, result);
					return result;
				} else if (parent.exports !== undefined) {
					if (parent.exports.has(symbol.getName() as ts.__String)) {
						result = parentValue.length > 0 ? `${parentValue}.${symbol.getName()}` : symbol.getName();
						this.exportedPaths.set(symbol, result);
						return result;
					} else {
						this.exportedPaths.set(symbol, null);
						return null;
					}
				} else {
					this.exportedPaths.set(symbol, null);
					return null;
				}
			}
		}
	}
}

interface ResolverContext {
	getOrCreateSymbolData(symbol: ts.Symbol, location?: ts.Node): SymbolData;
}

abstract class SymbolDataResolver {

	constructor(protected typeChecker: ts.TypeChecker, protected symbols: Symbols, protected resolverContext: ResolverContext, protected symbolDataContext: SymbolDataContext) {
	}

	public abstract requiresSourceFile: boolean;

	public getDeclarationNodes(symbol: ts.Symbol, location?: ts.Node): ts.Node[] | undefined {
		return symbol.getDeclarations();
	}

	public getSourceFiles(symbol: ts.Symbol, location?: ts.Node): ts.SourceFile[] {
		let sourceFiles = tss.getUniqueSourceFiles(symbol.getDeclarations());
		if (sourceFiles.size === 0) {
			return [];
		}
		return Array.from(sourceFiles.values());
	}

	public getPartitionScope(sourceFiles: ts.SourceFile[]): ts.SourceFile {
		if (sourceFiles.length === 0) {
			throw new Error(`No soure file selection provided`);
		}
		return sourceFiles[0];
	}

	public abstract resolve(sourceFile: ts.SourceFile | undefined, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData;
}

class StandardResolver extends SymbolDataResolver {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: ResolverContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public get requiresSourceFile(): boolean {
		return false;
	}

	public resolve(sourceFile: ts.SourceFile | undefined, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData {
		return new StandardSymbolData(this.symbolDataContext, id, scope);
	}
}

class TypeAliasResolver extends SymbolDataResolver {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: ResolverContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public get requiresSourceFile(): boolean {
		return false;
	}

	public resolve(sourceFile: ts.SourceFile | undefined, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData {
		let aliased = this.typeChecker.getAliasedSymbol(symbol);
		if (aliased !== undefined) {
			let aliasedSymbolData = this.resolverContext.getOrCreateSymbolData(aliased);
			if (aliasedSymbolData !== undefined) {
				return new AliasedSymbolData(this.symbolDataContext, id, aliasedSymbolData, scope, symbol.getName() !== aliased.getName());
			}
		}
		return new StandardSymbolData(this.symbolDataContext, id);
	}
}

class MethodResolver extends SymbolDataResolver {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: ResolverContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public get requiresSourceFile(): boolean {
		return true;
	}

	public resolve(sourceFile: ts.SourceFile, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData {
		let container = tss.getSymbolParent(symbol);
		if (container === undefined) {
			return new MethodSymbolData(this.symbolDataContext, id, sourceFile, undefined, scope);
		}
		let baseMembers = this.symbols.findBaseMembers(container, symbol.getName());
		if (baseMembers === undefined || baseMembers.length === 0) {
			return new MethodSymbolData(this.symbolDataContext, id, sourceFile, undefined, scope);
		}
		let baseSymbolData = baseMembers.map(member => this.resolverContext.getOrCreateSymbolData(member));
		return new MethodSymbolData(this.symbolDataContext, id, sourceFile, baseSymbolData, scope);
	}
}

class TransientResolver extends SymbolDataResolver {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: ResolverContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public get requiresSourceFile(): boolean {
		return true;
	}

	public getDeclarationNodes(symbol: ts.Symbol, location?: ts.Node): ts.Node[] | undefined {
		if (location === undefined) {
			throw new Error(`Transient resolver needs declaration node`);
		}

		return [location];
	}

	public getSourceFiles(symbol: ts.Symbol, location?: ts.Node): ts.SourceFile[] {
		if (location === undefined) {
			throw new Error(`Transient resolver needs declaration node`);
		}
		return [location.getSourceFile()];
	}

	public resolve(sourceFile: ts.SourceFile, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData {
		if (location === undefined) {
			throw new Error(`Transient resolver needs declaration node`);
		}
		let type = this.typeChecker.getTypeOfSymbolAtLocation(symbol, location);
		if (type.isUnionOrIntersection() && type.types.length > 0) {
			let datas: SymbolData[] = [];
			for (let typeElem of type.types) {
				let symbol = typeElem.symbol;
				// This happens for base types like undefined, number, ....
				if (symbol !== undefined) {
					datas.push(this.resolverContext.getOrCreateSymbolData(symbol));
				}
			}
			return new UnionOrIntersectionSymbolData(this.symbolDataContext, id, sourceFile, datas);
		} else {
			return new StandardSymbolData(this.symbolDataContext, id, undefined);
		}
	}
}

export class DataManager implements SymbolDataContext {

	private projectData: ProjectData;
	private documentDatas: Map<string, DocumentData | null>;
	private symbolDatas: Map<string, SymbolData | null>;
	private clearOnNode: Map<ts.Node, SymbolData[]>;

	public constructor(private context: EmitContext, project: Project) {
		this.projectData = new ProjectData(this, project);
		this.projectData.begin();
		this.documentDatas = new Map();
		this.symbolDatas = new Map();
		this.clearOnNode = new Map();
	}

	public get vertex(): VertexBuilder {
		return this.context.vertex;
	}

	public get edge(): EdgeBuilder {
		return this.context.edge;
	}

	public emit(element: Vertex | Edge): void {
		this.context.emit(element);
	}

	public getProjectData(): ProjectData {
		return this.projectData;
	}

	public projectProcessed(): void {
		for (let entry of this.symbolDatas.entries()) {
			if (entry[1]) {
				entry[1].end();
				this.symbolDatas.set(entry[0], null);
			}
		}
		for (let entry of this.documentDatas.entries()) {
			if (entry[1]) {
				entry[1].end();
			}
		}
		this.projectData.end();
	}

	public getDocumentData(fileName: string): DocumentData | undefined {
		let result = this.documentDatas.get(fileName);
		if (result === null) {
			throw new Error(`There was already a managed document data for file: ${fileName}`);
		}
		return result;
	}

	public getOrCreateDocumentData(fileName: string, document: Document, monikerPath: string | undefined, externalLibrary: boolean): DocumentData {
		let result = this.getDocumentData(fileName);
		if (result === undefined) {
			result = new DocumentData(this, document, monikerPath, externalLibrary);
			this.documentDatas.set(fileName, result);
			result.begin();
			this.projectData.addDocument(document);
		}
		return result;
	}

	public documemntProcessed(fileName: string): void {
		let data = this.getDocumentData(fileName);
		if (data === undefined) {
			throw new Error(`No document data for file ${fileName}`);
		}
		data.end();
		this.documentDatas.set(fileName, null);
	}

	public getSymbolData(symbolId: SymbolId): SymbolData | undefined {
		let result = this.symbolDatas.get(symbolId);
		if (result === null) {
			throw new Error(`There was already a managed symbol data for id: ${symbolId}`);
		}
		return result;
	}

	public getOrCreateSymbolData(symbolId: SymbolId, create: () => SymbolData): SymbolData {
		let result = this.getSymbolData(symbolId);
		if (result === undefined) {
			result = create();
			this.symbolDatas.set(result.getId(), result);
			result.begin();
		}
		return result;
	}

	public manageLifeCycle(node: ts.Node, symbolData: SymbolData): void {
		let datas = this.clearOnNode.get(node);
		if (datas === undefined) {
			datas = [];
			this.clearOnNode.set(node, datas);
		}
		datas.push(symbolData);
	}

	public nodeProcessed(node: ts.Node): void {
		let datas = this.clearOnNode.get(node);
		if (datas !== undefined) {
			for (let symbolData of datas) {
				if (symbolData.nodeProcessed(node)) {
					this.symbolDatas.delete(symbolData.getId());
				}
			}
			this.clearOnNode.delete(node);
		}
	}
}

export interface ProjectInfo {
	rootDir: string;
	outDir: string;
}

export interface Options {
	projectRoot: string;
	noContents: boolean;
}

class Visitor implements ResolverContext {

	private builder: Builder;
	private project: Project;
	private projectRoot: string;
	private rootDir: string | undefined;
	private outDir: string | undefined;
	private dependentOutDirs: string[];
	private currentSourceFile: ts.SourceFile | undefined;
	private _currentDocumentData: DocumentData | undefined;
	private symbols: Symbols;
	private symbolContainer: RangeBasedDocumentSymbol[];
	private recordDocumentSymbol: boolean[];
	private dataManager: DataManager;
	private symbolDataResolvers: Map<number, SymbolDataResolver>;
	private externalLibraryImports: Map<string, ts.ResolvedModuleFull>;

	constructor(private languageService: ts.LanguageService, options: Options, dependsOn: ProjectInfo[], private emitter: Emitter, idGenerator: () => Id, tsConfigFile: string | undefined) {
		this.builder = new Builder({
			idGenerator,
			emitSource: !options.noContents
		});
		this.symbolContainer = [];
		this.recordDocumentSymbol = [];
		this.externalLibraryImports = new Map();
		this.dependentOutDirs = [];
		for (let info of dependsOn) {
			this.dependentOutDirs.push(info.outDir);
		}
		this.dependentOutDirs.sort((a, b) => {
			return b.length - a.length;
		})
		this.projectRoot = options.projectRoot;
		this.emit(this.vertex.metaData(Version, URI.file(this.projectRoot).toString(true)));
		this.project = this.vertex.project();
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
		this.dataManager = new DataManager(this, this.project);
		this.symbols = new Symbols(this.typeChecker);
		this.symbolDataResolvers = new Map();
		this.symbolDataResolvers.set(0, new StandardResolver(this.typeChecker, this.symbols, this, this.dataManager));
		this.symbolDataResolvers.set(ts.SymbolFlags.Alias, new TypeAliasResolver(this.typeChecker, this.symbols, this, this.dataManager));
		this.symbolDataResolvers.set(ts.SymbolFlags.Method, new MethodResolver(this.typeChecker, this.symbols, this, this.dataManager));
		this.symbolDataResolvers.set(ts.SymbolFlags.Transient, new TransientResolver(this.typeChecker, this.symbols, this, this.dataManager));
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

	public endVisitProgram(): void {
		this.dataManager.projectProcessed();
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
		this.dataManager.nodeProcessed(node);
		endVisit.call(this, node);
	}

	private visitSourceFile(sourceFile: ts.SourceFile): boolean {
		if (this.isFullContentIgnored(sourceFile)) {
			return false;
		}
		// process.stderr.write('.');

		this.currentSourceFile = sourceFile;
		let documentData = this.getOrCreateDocumentData(sourceFile);
		this._currentDocumentData = documentData;
		this.symbolContainer.push({ id: documentData.document.id, children: [] });
		this.recordDocumentSymbol.push(true);

		return true;
	}

	private endVisitSourceFile(sourceFile: ts.SourceFile): void {
		if (this.isFullContentIgnored(sourceFile)) {
			return;
		}

		let documentData = this.currentDocumentData;
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
			documentData.addDiagnostics(diagnostics);
		}

		// Folding ranges
		let spans = this.languageService.getOutliningSpans(sourceFile.fileName);
		if (ts.textSpanEnd.length > 0) {
			let foldingRanges: lsp.FoldingRange[] = [];
			for (let span of spans) {
				foldingRanges.push(Converter.asFoldingRange(sourceFile,span));
			}
			if (foldingRanges.length > 0) {
				documentData.addFoldingRanges(foldingRanges);
			}
		}

		// Document symbols.
		let values = (this.symbolContainer.pop() as RangeBasedDocumentSymbol).children;
		if (values !== undefined && values.length > 0) {
			documentData.addDocumentSymbols(values);
		}
		this.recordDocumentSymbol.pop();

		this.currentSourceFile = undefined;
		this._currentDocumentData = undefined;
		this.dataManager.documemntProcessed(sourceFile.fileName);
		if (this.symbolContainer.length !== 0) {
			throw new Error(`Unbalanced begin / end calls`);
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
		let symbolData = this.getOrCreateSymbolData(symbol, rangeNode);
		if (symbolData === undefined) {
			return false;
		}
		let sourceFile = this.currentSourceFile!;
		let definition = symbolData.findDefinition(sourceFile, Converter.rangeFromNode(sourceFile, rangeNode));
		if (definition === undefined) {
			return false;
		}
		let currentContainer = this.symbolContainer[this.symbolContainer.length - 1];
		let child: RangeBasedDocumentSymbol = { id: definition.id };
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
		if (symbol === undefined) {
			return;
		}
		let symbolData = this.getOrCreateSymbolData(symbol, node);
		if (symbolData === undefined) {
			return;
		}
		let sourceFile = this.currentSourceFile!;
		if (symbolData.hasDefinitionInfo(tss.createDefinitionInfo(sourceFile, node))) {
			return;
		}

		let reference = this.vertex.range(Converter.rangeFromNode(sourceFile, node), { type: RangeTagTypes.reference, text: node.getText() });
		this.currentDocumentData.addRange(reference);
		symbolData.addReference(sourceFile, reference, ItemEdgeProperties.references);
	}

	public getDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined {
		return this.languageService.getDefinitionAtPosition(sourceFile.fileName, node.getStart(sourceFile));
	}

	public getTypeDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined {
		return this.languageService.getTypeDefinitionAtPosition(sourceFile.fileName, node.getStart(sourceFile));
	}

	public getOrCreateDocumentData(sourceFile: ts.SourceFile): DocumentData {
		const computeMonikerPath = (sourceFile: ts.SourceFile): string | undefined => {
			// A real source file inside this project.
			if (!sourceFile.isDeclarationFile) {
				return tss.computeMonikerPath(this.projectRoot, tss.toOutLocation(sourceFile.fileName, this.rootDir!, this.outDir!));
			}
			// This can come from a dependent project.
			let fileName = sourceFile.fileName;
			for (let outDir of this.dependentOutDirs) {
				if (fileName.startsWith(outDir)) {
					return tss.computeMonikerPath(this.projectRoot, sourceFile.fileName);
				}
			}
			return undefined;
		}

		let result = this.dataManager.getDocumentData(sourceFile.fileName);
		if (result !== undefined) {
			return result;
		}

		let document = this.vertex.document(sourceFile.fileName, sourceFile.text)

		let resolvedModule = this.externalLibraryImports.get(sourceFile.fileName);
		let monikerPath: string | undefined;
		let library: boolean = false;
		if (resolvedModule !== undefined) {
			library = true;
			monikerPath = tss.computeMonikerPath(this.projectRoot, sourceFile.fileName);
		} else {
			monikerPath = computeMonikerPath(sourceFile);
		}

		result = this.dataManager.getOrCreateDocumentData(sourceFile.fileName, document, monikerPath, library);
		return result;
	}

	public getOrCreateSymbolData(symbol: ts.Symbol, location?: ts.Node): SymbolData {
		let id: SymbolId = tss.createSymbolKey(this.typeChecker, symbol);
		let result = this.dataManager.getSymbolData(id);
		if (result !== undefined) {
			return result;
		}
		let resolver = this.getResolver(symbol);
		let scope =  this.resolveEmittingNode(symbol);
		let declarations: ts.Node[] | undefined = resolver.getDeclarationNodes(symbol, location);
		let sourceFiles: ts.SourceFile[] = resolver.getSourceFiles(symbol, location);
		if (resolver.requiresSourceFile && sourceFiles.length === 0) {
			throw new Error(`Resolver requires source file but no source file can be found.`);
		}
		// Make sure we create all document data before we create the symbol.
		let monikerPath: string | undefined | null;
		let externalLibrary: boolean = false;
		for (let sourceFile of sourceFiles.values()) {
			let documentData = this.getOrCreateDocumentData(sourceFile);
			if (monikerPath === undefined) {
				monikerPath = documentData.monikerPath;
				externalLibrary = documentData.externalLibrary;
			} else if (monikerPath !== documentData.monikerPath) {
				monikerPath = null;
			}
		}
		if (monikerPath === null) {
			monikerPath = undefined;
			externalLibrary = false;
		}
		result = this.dataManager.getOrCreateSymbolData(id, () => {
			return resolver.requiresSourceFile ? resolver.resolve(resolver.getPartitionScope(sourceFiles), id, symbol, location, scope) : resolver.resolve(undefined, id, symbol, location, scope);
		});
		if (declarations === undefined || declarations.length === 0) {
			return result;
		}
		// The symbol represents a source file
		let monikerIdentifer: string | undefined;
		if (tss.isSourceFile(symbol) && monikerPath !== undefined) {
			monikerIdentifer = tss.createMonikerIdentifier(monikerPath, undefined);
		} else {
			const monikerName = this.symbols.getExportPath(symbol);
			if (monikerName !== null) {
				monikerIdentifer = tss.createMonikerIdentifier(monikerPath, monikerName);
			}
		}
		if (monikerIdentifer !== undefined) {
			if (externalLibrary === true) {
				result.addMoniker(MonikerKind.import, monikerIdentifer);
			} else {
				result.addMoniker(MonikerKind.export, monikerIdentifer);
			}
		}

		let hover: lsp.Hover | undefined;
		for (let declaration of declarations) {
			let sourceFile = declaration.getSourceFile();
			let [identifierNode, identifierText] = this.getIdentifierInformation(sourceFile, symbol, declaration);
			if (identifierNode !== undefined && identifierText !== undefined) {
				let documentData = this.getOrCreateDocumentData(sourceFile);
				let definition = this.vertex.range(Converter.rangeFromNode(sourceFile, identifierNode), {
					type: RangeTagTypes.definition,
					text: identifierText,
					kind: Converter.asSymbolKind(declaration),
					fullRange: Converter.rangeFromNode(sourceFile, declaration),
				});
				documentData.addRange(definition);
				result.addDefinition(sourceFile, definition);
				result.recordDefinitionInfo(tss.createDefinitionInfo(sourceFile, identifierNode));
				if (hover === undefined && tss.isNamedDeclaration(declaration)) {
					hover = this.getHover(declaration.name, sourceFile);
					if (hover) {
						result.addHover(hover);
					}
				}
			}
		}
		// if (SymbolItem.isBlockScopedVariable(this.tsSymbol) && declarations.length === 1) {
		// 	let type = this.context.typeChecker.getTypeOfSymbolAtLocation(this.tsSymbol, declarations[0]);
		// 	if (type.symbol) {
		// 		let typeSymbol = SymbolItem.get(this.context, type.symbol);
		// 		let result: TypeDefinitionResult | undefined;
		// 		if (Array.isArray(typeSymbol.declarations)) {
		// 			result = this.context.vertex.typeDefinitionResult(typeSymbol.declarations.map(declaration => declaration.id));
		// 		} else if (typeSymbol.declarations !== undefined) {
		// 			result = this.context.vertex.typeDefinitionResult([typeSymbol.declarations.id]);
		// 		}
		// 		if (result !== undefined) {
		// 			this.context.emit(result);
		// 			this.context.emit(this.context.edge.typeDefinition(this.resultSet, result));
		// 		}
		// 	}
		// }
		return result;
	}

	private getIdentifierInformation(sourceFile: ts.SourceFile, symbol: ts.Symbol, declaration: ts.Node): [ts.Node, string] | [undefined, undefined] {
		if (tss.isNamedDeclaration(declaration)) {
			let name = declaration.name;
			return [name, name.getText()];
		}
		if (tss.isValueModule(symbol) && ts.isSourceFile(declaration)) {
			return [declaration, ''];
		}
		return [undefined, undefined];
	}

	private resolveEmittingNode(symbol: ts.Symbol): ts.Node | undefined {
		// The symbol has a export path so we can't bind this to a node
		// Note that we even treat private class members like this. Reason being
		// is that they can be referenced but it would only be a compile error
		// since JS in fact has not visibility.
		if (this.symbols.getExportPath(symbol) !== null) {
			return undefined;
		}
		let declarations = symbol.getDeclarations();
		if (declarations === undefined || declarations.length !== 1) {
			return undefined;
		}
		let declaration = declarations[0];
		if (tss.isValueModule(symbol) && declaration.kind === ts.SyntaxKind.SourceFile) {
			return undefined;
		}
		if (tss.isAliasSymbol(symbol)) {
			let sourceFile = declaration.getSourceFile();
			return this.isFullContentIgnored(sourceFile) ? undefined : sourceFile;
		}
		if (ts.isSourceFile(declaration)) {
			return this.isFullContentIgnored(declaration) ? undefined : declaration;
		}
		let result = declaration.parent;
		while (result !== undefined && !tss.EmitBoundaries.has(result.kind)) {
			result = result.parent;
		}
		if (result !== undefined && this.isFullContentIgnored(result.getSourceFile())) {
			return undefined;
		}
		return result;
	}

	private getResolver(symbol: ts.Symbol): SymbolDataResolver {
		if (tss.isAliasSymbol(symbol)) {
			return this.symbolDataResolvers.get(ts.SymbolFlags.Alias)!;
		}
		if (tss.isMethodSymbol(symbol)) {
			return this.symbolDataResolvers.get(ts.SymbolFlags.Method)!;
		}
		if (tss.isTransient(symbol)) {
			return this.symbolDataResolvers.get(ts.SymbolFlags.Transient)!;
		}
		return this.symbolDataResolvers.get(0)!;
	}

	private getHover(node: ts.DeclarationName, sourceFile?: ts.SourceFile): lsp.Hover | undefined {
		if (sourceFile === undefined) {
			sourceFile = node.getSourceFile();
		}
		let quickInfo = this.languageService.getQuickInfoAtPosition(sourceFile.fileName, node.getStart());
		if (quickInfo === undefined) {
			return undefined;
		}
		return Converter.asHover(sourceFile, quickInfo);
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

	private get currentDocumentData(): DocumentData {
		if (this._currentDocumentData === undefined) {
			throw new Error(`No current document partition`);
		}
		return this._currentDocumentData;
	}

	private get currentRecordDocumentSymbol(): boolean {
		return this.recordDocumentSymbol[this.recordDocumentSymbol.length - 1];
	}
}


export function lsif(languageService: ts.LanguageService, options: Options, dependsOn: ProjectInfo[], emitter: Emitter, idGenerator: () => Id, tsConfigFile: string | undefined): ProjectInfo {
	let visitor = new Visitor(languageService, options, dependsOn, emitter, idGenerator, tsConfigFile);
	let result = visitor.visitProgram();
	visitor.endVisitProgram();
	return result;
}