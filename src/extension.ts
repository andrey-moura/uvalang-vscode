// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as cp from "child_process";
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { off } from 'process';
import { buffer } from 'stream/consumers';

class Location {
	file: string;
	line: number;
	column: number;
	offset: number;
	length: number;

	constructor(file: string, line: number, column: number, offset: number, length: number = 0) {
		this.file = file;
		this.line = line;
		this.column = column;
		this.offset = offset;
		this.length = length;
	}
}

class Declaration {
	name: string;
	location: Location;
	references: Location[];

	constructor(name: string, location: any, references: any) {
		this.name = name;
		this.location = location;
		this.references = references;
	}
};

class LinterWarning {
	message: string;
	type: string;
	location: Location;

	constructor(message: string, type: string, location: any) {
		this.message = message;
		this.type = type;
		this.location = location;
	}
}

class AnalyzerResult {
	declarations: Declaration[];
	linter:       LinterWarning[];

	constructor(declarations: Declaration[], linter: LinterWarning[] = []) {
		this.declarations = [];
		this.linter = [];
	}
};

class AnalyzerServer {
	private executable?: cp.ChildProcess;
	public onError?: (error: Error) => void;

	constructor() {
	}

	launch() {
		const start = Date.now();

		this.executable = cp.spawn('uvalang-analyzer', ["--server"]);

		if(!this.executable || !this.executable.pid) {
			return false;
		}

		const end = Date.now();

		console.log('uvalang-analyzer server started in ' + (end - start) + 'ms');

		this.executable.on('close', (code) => {
			this.throwErrorAtServer(`Exited with code ${code}`);
		});

		return true;
	}

	analyse(document: vscode.TextDocument) : Promise<AnalyzerResult> {
		if(document.languageId !== 'uva') {
			console.log("anlyse cancel, not uva language");

			return new Promise<AnalyzerResult>((resolve, reject) => {
				resolve(new AnalyzerResult([]));
			});
		}

		const now = Date.now();

		const content = document.getText();

		const tmpFileName = path.join(os.tmpdir(), document.fileName.substring(document.fileName.lastIndexOf(path.sep) + 1));

		fs.writeFileSync(tmpFileName, content);

		var command = [document.fileName, tmpFileName];

		if(!this.writeCommand(command)) {
			return new Promise<AnalyzerResult>((resolve, reject) => {
				this.throwErrorAtServer('unable to write command');
				reject(new Error('unable to write command'));
			});
		}

		return new Promise<AnalyzerResult>((resolve, reject) => {
			const onData = (data: Buffer) => {
				const end = Date.now();
				const elapsed = end - now;

				try {
					var result = JSON.parse(data.toString());
				} catch(e) {
					console.log(`error parsing JSON: ${e}`);
					console.log(`data: ${data.toString()}`);
					return;
				}
			
				console.log(`${command} success in ${elapsed}ms (reported ${result.elapsed})`);

				const analyzerResult = new AnalyzerResult([]);
				
				for(const declaration of result.declarations) {
					const location = new Location(declaration.location.file, declaration.location.line, declaration.location.column, declaration.location.offset);
					const references = declaration.references.map((reference: any) => new Location(reference.file, reference.line, reference.column, reference.offset));
	
					analyzerResult.declarations.push(new Declaration(declaration.name, location, references));
				}

				for(const warning of result.linter) {
					console.log(`warning: ${JSON.stringify(warning)}`);

					const location = new Location(warning.location.file, warning.location.line, warning.location.column, warning.location.offset, warning.location.length);
	
					analyzerResult.linter.push(new LinterWarning(warning.message, warning.type, location));
				}

				this.executable?.stdout?.off('data', onData);

				resolve(analyzerResult);
			}

			const onError = (error: Error) => {
				const end = Date.now();
				console.log(`analyse canceled ${end - now}ms`);

				this.executable?.stdout?.off('error', onError);

				reject(error);
			}

			this.executable?.stdout?.on('data', onData);
			this.executable?.stdout?.on('error', onError);
		});
	}

	private throwErrorAtServer(message: string) {
		if(this.onError) {
			this.onError(new Error(message));
		}
	}

	private writeCommand(command: Array<string>) : Boolean {
		if(!this.executable?.stdin?.writable) {
			this.throwErrorAtServer('stdin is not writable');
			return false;
		}

		this.executable?.stdin?.write(command.join('\n') + '\n');
		return true;
	}
};

class MyDefinitionProvider implements vscode.DefinitionProvider {
	private analyzerServer: AnalyzerServer;

    constructor(analyzerServer: AnalyzerServer) {
		this.analyzerServer = analyzerServer;
    }

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Definition> {
        //console.log('DefinitionProvider called');

        const wordRange = document.getWordRangeAtPosition(position);
		
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);

		return this.analyzerServer.analyse(document).then((analyzerResult) => {
			//console.log(`analyzerResult: ${JSON.stringify(analyzerResult)}`);

			for(const declaration of analyzerResult.declarations) {
				if(declaration.name === word) {
					const startPos = new vscode.Position(declaration.location.line, declaration.location.column);
					const endPos = new vscode.Position(declaration.location.line, declaration.location.column + declaration.name.length);
					const range = new vscode.Range(startPos, endPos);
					const uri = vscode.Uri.file(declaration.location.file);

					return new vscode.Location(uri, range);
				}
			}

		});
    }
}

function referenceRange(editor: vscode.TextEditor, reference: any, name: string) : vscode.Range{
	const startPos = editor.document.positionAt(reference.offset);
	const endPos = editor.document.positionAt(reference.offset + name.length);
	const range = new vscode.Range(startPos, endPos);

	return range;
}

const classDecorationType = vscode.window.createTextEditorDecorationType({
	color: '#4EC9B0',
	fontWeight: 'bold',
	textDecoration: 'none',
});

const diagnosticCollection = vscode.languages.createDiagnosticCollection('meuLinter');

function updateDecorations(analyzerServer: AnalyzerServer) {
	console.log('updateDecorations4...');

	const editor = vscode.window.activeTextEditor;

	if(!editor) return;

	analyzerServer.analyse(editor.document).then((analyzerResult) => {
		var ranges = [];

		for(const declaration of analyzerResult.declarations) {
			console.log(`decoring declaration for ${declaration.name} at ${JSON.stringify(declaration.location)}...`);

			if(editor.document.fileName == declaration.location.file) {
				ranges.push(referenceRange(editor, declaration.location, declaration.name));
			}

			for(const reference of declaration.references) {
				//console.log(`decorating reference ${JSON.stringify(reference)}...`);

				if(editor.document.fileName == reference.file) {
					ranges.push(referenceRange(editor, reference, declaration.name));
				}
			}
		}

		editor.setDecorations(classDecorationType, ranges);

		diagnosticCollection.clear();
		var diagnostics = new Map<string, vscode.Diagnostic[]>();

		for(let i = 0; i < analyzerResult.linter.length; i++) {
			var warning = analyzerResult.linter[i];
			const range = new vscode.Range(
				new vscode.Position(warning.location.line, warning.location.column), // Início do aviso
				new vscode.Position(warning.location.line, warning.location.column + warning.location.length) // Fim do aviso
			);
			const diagnostic = new vscode.Diagnostic(
				range,
				warning.message,
				vscode.DiagnosticSeverity.Information
			);

			var array = diagnostics.get(warning.location.file);

			if(!array) {
				array = [];
				console.log(`new array for ${warning.location.file}`);
			}

			array.push(diagnostic);

			diagnostics.set(warning.location.file, array);
		};

		console.log(`diagnostics: ${diagnostics.size}`);

		diagnostics.forEach((value, key) => {
			console.log(`diagnostics for ${key}: ${value.length}`);
			diagnosticCollection.set(vscode.Uri.file(key), value);
		});
	});
};

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('uvalang-analyzer extension activated');

	var analyzerServer = new AnalyzerServer();

	var onError = (error: Error) => {

		vscode.window.showErrorMessage(`${error.message}. The server will be restarted.`);

		setTimeout(() => {
		analyzerServer = new AnalyzerServer();
			analyzerServer.onError = onError;
		analyzerServer.launch();
		}, 3000);
	};

	if(!analyzerServer.launch()) {
		const message = "Unable to start analyzer server. Make sure uvalang-analyzer is installed and is in your PATH. If you have just installed it, you may need to restart Visual Studio Code or your computer.";
		
		vscode.window.showErrorMessage(message, 'Retry').then((value) => {
			if(value === 'Retry') {
				activate(context);
			} else {
				return;
			}
		});

		return;
	}

	// Note: Error is only handled if the server could be started
	analyzerServer.onError = onError;

	const updateCurrentDocumentDecorations = () => {
		if(analyzerServer) {
			updateDecorations(analyzerServer);
		}
	}

	const onDidChangeActiveTextEditor = vscode.window.onDidChangeActiveTextEditor((editor) => {
		updateCurrentDocumentDecorations();
	});

	const onDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument((event) => {
		updateCurrentDocumentDecorations();
	});

	const registerDefinitionProvider = vscode.languages.registerDefinitionProvider({ scheme: 'file', language: 'uva' }, new MyDefinitionProvider(analyzerServer));

	context.subscriptions.push(onDidChangeActiveTextEditor, onDidChangeTextDocument, registerDefinitionProvider);

	updateCurrentDocumentDecorations();
}

// This method is called when your extension is deactivated
export function deactivate() {}
