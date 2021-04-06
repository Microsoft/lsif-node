/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fse from 'fs-extra';
import * as LSIF from 'lsif-protocol';
import * as readline from 'readline';
import * as yargs from 'yargs';
import { getFilteredIds, IFilter } from './filter';
import { visualize } from './visualize';

function readInput(format: string, inputPath: string, callback: (input: LSIF.Element[]) => void): void {
	let inputStream: NodeJS.ReadStream | fse.ReadStream = process.stdin;

	if (inputPath !== '--stdin') {
		inputStream = fse.createReadStream(inputPath);
	}

	let input: LSIF.Element[] = [];
	const invalidLines: string[] = [];
	const buffer: string[] = [];
	const rd: readline.Interface = readline.createInterface(inputStream);

	rd.on('line', (line: string) => {
		if (line === '') {
			return;
		}

		switch (format) {
			case 'json':
				buffer.push(line);
				break;
			case 'line': default:
				try {
					const element: LSIF.Element = JSON.parse(line);
					input.push(element);
				} catch {
					invalidLines.push(line);
				}
		}
	});

	rd.on('close', () => {
		if (invalidLines.length > 0) {
			yargs.showHelp('log');
			console.error('\nError: The following lines failed to parse. Did you forget --inputFormat=json?');
			console.error(invalidLines.join('\n'));
			process.exitCode = 1;
			return;
		}

		if (buffer.length > 0) {
			input = JSON.parse(buffer.join('\n'));
		}

		callback(input);
	});
}

export function main(): void {
	yargs
		.usage('Usage: $0 [validate|visualize] [file] --inputFormat=[line|json] [filters]')

		// Validation tool
		.command('validate [file]', '',
			{
				file: {
					describe: 'Path to input file or --stdin',
					type: 'string',
				},
			}, () => {
				console.error(`The validate command got removed. Please use lsif validate instead.`);
				process.exitCode = -1;
			})

		// Visualization tool
		.command('visualize [file]', '',
			{
				distance: {
					default: 1,
					demandOption: false,
					describe: 'Max distance between any vertex and the filtered input',
					type: 'number',
				},
				file: {
					describe: 'Path to input file or --stdin',
					type: 'string',
				},
			}, (argv: yargs.Arguments) => {
				if (!argv.stdin && argv.file === undefined) {
					yargs.showHelp('log');
					console.error('\nError: Missing input file. Did you forget --stdin?');
					process.exitCode = 1;
				} else {
					readInput(argv.inputFormat as string, argv.stdin ? '--stdin' : argv.file as string, (input: LSIF.Element[]) => {
						const filter: IFilter = argv as unknown as IFilter;
						process.exitCode = visualize(input, getFilteredIds(filter, input), argv.distance as number);
					});
				}
			})

		// One and only one command should be specified
		.demandCommand(1, 1)

		// Common options between tools
		.option('inputFormat', { default: 'line', choices: ['line', 'json'], description: 'Specify input format' })
		.boolean('stdin')
		.option('id', { default: [], type: 'string', array: true, description: 'Filter by id' })
		.option('inV', { default: [], type: 'string', array: true, description: 'Filter by inV' })
		.option('outV', { default: [], type: 'string', array: true, description: 'Filter by outV' })
		.option('type', { default: [], type: 'string', array: true, description: 'Filter by type' })
		.option('label', { default: [], type: 'string', array: true, description: 'Filter by label' })
		.option('property', { default: [], type: 'string', array: true, description: 'Filter by property' })
		.option('regex', { type: 'string', description: 'Filter by regex' })

		// Error handler
		.fail((message: string, error: Error) => {
			if (error !== undefined) {
				throw error;
			}
			yargs.showHelp('log');
			console.error(`\nError: ${message}`);
			process.exitCode = 1;
		})

		// Auto-generated help
		.help('info', 'Show usage information')
		.argv;
}

if (require.main === module) {
	main();
}
