/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import * as uuid from 'uuid';

import * as minimist from 'minimist';

import * as ts from 'typescript';
import * as tss from './typescripts';

import { Id } from 'lsif-protocol';
import { Emitter, EmitterModule } from './emitters/emitter';
import { TypingsInstaller } from './typings';
import { lsif, ProjectInfo, Options as VisitorOptions } from './lsif';

interface Options {
	help: boolean;
	version: boolean;
	outputFormat: 'json' | 'line' | 'vis' | 'graphSON';
	id: 'number' | 'uuid';
	project: string | undefined;
	noContents: boolean;
	inferTypings: boolean;
}

interface OptionDescription {
	id: keyof Options;
	type: 'boolean' | 'string';
	alias?: string;
	default: any;
	values?: string[];
	description: string;
}

namespace Options {
	export const defaults: Options = {
		help: false,
		version: false,
		outputFormat: 'line',
		id: 'number',
		project: undefined,
		noContents: false,
		inferTypings: false,
	};
	export const descriptions: OptionDescription[] = [
		{ id: 'version', type: 'boolean', alias: 'v', default: false, description: 'output the version number'},
		{ id: 'help', type: 'boolean', alias: 'h', default: false, description: 'output usage information'},
		{ id: 'outputFormat', type: 'string', default: 'line', values: ['line', 'json'], description: 'Specifies the output format. Allowed values are: \'line\' and \'json\'.'},
		{ id: 'id', type: 'string', default: 'number', values: ['number', 'uuid'], description: 'Specifies the id format. Allowed values are: \'number\' and \'uuid\'.'},
		{ id: 'project', type: 'string', alias: 'p', default: undefined, description: 'Specifies the project root. Defaults to the location of the [tj]sconfig.json file.'},
		{ id: 'noContents', type: 'boolean', default: false, description: 'File contents will not be embedded into the dump.'},
		{ id: 'inferTypings', type: 'boolean', default: false, description: 'Infer typings for JavaScript npm modules.'}
	];
}

function loadConfigFile(file: string): ts.ParsedCommandLine {
	let absolute = path.resolve(file);

	let readResult = ts.readConfigFile(absolute, ts.sys.readFile);
	if (readResult.error) {
		throw new Error(ts.formatDiagnostics([readResult.error], ts.createCompilerHost({})));
	}
	let config = readResult.config;
	if (config.compilerOptions !== undefined) {
		config.compilerOptions = Object.assign(config.compilerOptions, tss.getDefaultCompilerOptions(file));
	}
	let result = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(absolute));
	if (result.errors.length > 0) {
		throw new Error(ts.formatDiagnostics(result.errors, ts.createCompilerHost({})));
	}
	return result;
}

function createEmitter(options: Options, idGenerator: () => Id): Emitter {
	let emitterModule: EmitterModule;
	switch (options.outputFormat) {
		case 'json':
			emitterModule = require('./emitters/json');
			break;
		case 'line':
			emitterModule = require('./emitters/line');
			break;
		case 'vis':
			emitterModule = require('./emitters/vis');
			break;
		case 'graphSON':
			emitterModule = require('./emitters/graphSON');
			break;
		default:
			emitterModule = require('./emitters/json');
	}
	return emitterModule.create(idGenerator);
}

function createIdGenerator(options: Options): () => Id {
	switch (options.id) {
		case 'uuid':
			return () => {
				return uuid.v4();
			};
		default:
			let counter = 1;
			return () => {
				return counter++;
			};
	}
}

async function processProject(config: ts.ParsedCommandLine, options: Options, emitter: Emitter, idGenerator: () => Id, typingsInstaller: TypingsInstaller): Promise<ProjectInfo | undefined> {
	let tsconfigFileName: string | undefined;
	if (config.options.project) {
		const projectPath = path.resolve(config.options.project);
		if (ts.sys.directoryExists(projectPath)) {
			tsconfigFileName = path.join(projectPath, 'tsconfig.json');
		} else {
			tsconfigFileName = projectPath;
		}
		if (!ts.sys.fileExists(tsconfigFileName)) {
			console.error(`Project configuration file ${tsconfigFileName} does not exist`);
			process.exitCode = 1;
			return undefined;
		}
		config = loadConfigFile(tsconfigFileName);
	}

	if (config.fileNames.length === 0) {
		console.error(`No input files specified.`);
		process.exitCode = 1;
		return undefined;
	}

	if (options.project === undefined) {
		options.project = tsconfigFileName !== undefined ? path.dirname(tsconfigFileName) : process.cwd();
	}
	options.project = tss.normalizePath(options.project);

	if (options.inferTypings) {
		if (config.options.types !== undefined) {
			const start = tsconfigFileName !== undefined ? tsconfigFileName : process.cwd();
			await typingsInstaller.installTypings(options.project, start, config.options.types);
		} else {
			await typingsInstaller.guessTypings(options.project, tsconfigFileName !== undefined ? path.dirname(tsconfigFileName) : process.cwd());
		}
	}

	// Bind all symbols

	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => {
			return config.fileNames;
		},
		getCompilationSettings: () => {
			return config.options;
		},
		getProjectReferences: () => {
			return config.projectReferences;
		},
		getScriptVersion: (fileName: string): string => {
			// The files are immutable.
			return "0";
		},
		// The project is immutable
		getProjectVersion: () => "0",
		getScriptSnapshot: (fileName: string): ts.IScriptSnapshot | undefined => {
			if (!ts.sys.fileExists(fileName)) {
				return undefined;
			}
			let content = ts.sys.readFile(fileName);
			if (content === undefined) {
				return undefined;
			}
			return ts.ScriptSnapshot.fromString(content);
		},
		getCurrentDirectory: () => {
			if (tsconfigFileName !== undefined) {
				return path.dirname(tsconfigFileName);
			} else {
				return process.cwd();
			}
		},
		getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory
	}
	const languageService = ts.createLanguageService(host);
	const program = languageService.getProgram();
	if (program === undefined) {
		console.error('Couldn\'t create language service with underlying program.');
		process.exitCode = -1;
		return undefined;
	}
	const dependsOn: ProjectInfo[] = [];
	const references = program.getResolvedProjectReferences();
	if (references) {
		for (let reference of references) {
			if (reference) {
				const projectInfo = await processProject(reference.commandLine, options, emitter, idGenerator, typingsInstaller);
				if (projectInfo !== undefined) {
					dependsOn.push(projectInfo);
				}
			}
		}
	}

	program.getTypeChecker();
	return lsif(languageService, options as VisitorOptions, dependsOn, emitter, idGenerator, tsconfigFileName);
}

async function run(this: void, args: string[]): Promise<void> {

	let minOpts: minimist.Opts = {
		string: [],
		boolean: [],
		default: Object.create(null),
		alias: Object.create(null)
	};

	let longestId: number = 0;
	for (let description of Options.descriptions) {
		longestId = Math.max(longestId, description.id.length);
		minOpts[description.type] = description.id;
		minOpts.default![description.id] = description.default;
		if (description.alias !== undefined) {
			minOpts.alias![description.id] = [description.alias];
		}
	}

	const options: Options = Object.assign(Options.defaults, minimist(process.argv.slice(2), minOpts));

	if (options.version) {
		console.log(require('../package.json').version);
		return;
	}

	let buffer: string[] = [];
	if (options.help) {
		buffer.push(`Languag Server Index Format tool for TypeScript`);
		buffer.push(`Version: ${require('../package.json').version}`);
		buffer.push('');
		buffer.push(`Usage: lsif-tsc [options][tsc options]`);
		buffer.push('');
		buffer.push(`Options`);
		for (let description of Options.descriptions) {
			if (description.alias !== undefined) {
				buffer.push(`  -${description.alias} --${description.id}${' '.repeat(longestId - description.id.length)} ${description.description}`);
			} else {
				buffer.push(`  --${description.id}   ${' '.repeat(longestId - description.id.length)} ${description.description}`);
			}
		}
		console.log(buffer.join('\n'));
		return;
	}

	const config: ts.ParsedCommandLine = ts.parseCommandLine(args);
	const idGenerator = createIdGenerator(options);
	const emitter = createEmitter(options, idGenerator);
	let projectRoot = options.project;
	if (projectRoot !== undefined && !path.isAbsolute(projectRoot)) {
		projectRoot = path.join(process.cwd(), projectRoot);
	}
	emitter.start();
	await processProject(config, options, emitter, idGenerator, new TypingsInstaller());
	emitter.end();
}

export async function main(): Promise<void> {
	return run(ts.sys.args);
}

if (require.main === module) {
	run(ts.sys.args).then(undefined, console.error);
}