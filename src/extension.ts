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
	location?: Location;
	type?: string;

	constructor(name: string, location: any, type: string = '') {
		this.name = name;
		this.location = location;
	}
};

class Reference {
	name: string;
	type: string;
	location: Location;

	constructor(name: string, type: string, location: any) {
		this.name = name;
		this.type = type;
		this.location = location;
	}
}

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

class LinterError {
	message: string;
	type: string;
	location: Location;

	constructor(message: string, type: string, location: any) {
		this.message = message;
		this.type = type;
		this.location = location;
	}
}

class Token {
	type: string;
	location: Location;

	constructor(type: string, location: any) {
		this.type = type;
		this.location = location;
	}
}

class AnalyzerResult {
	tokens:       Token[];
	declarations: Declaration[];
	references:   Reference[];
	linter:       LinterWarning[];
	linterErrors: LinterError[];
	

	constructor(declarations: Declaration[], references: Reference[] = [], linter: LinterWarning[] = [], linterErrors: LinterError[] = []) {
		this.declarations = [];
		this.linter = [];
		this.tokens = [];
		this.linterErrors = [];
		this.references = references;
	}
};

class AnalyzerServer {
	private executable?: cp.ChildProcess;
	private executablePath = 'andy-analyzer';
	private isDebugMode: boolean; 
	public onError?: (error: Error) => void;

	constructor(
		isDebugMode: boolean = false,
	)
	{
		this.isDebugMode = isDebugMode;

		if (this.isDebugMode) {
			this.executablePath = path.join(__dirname, '../..', 'andy-lang/build/andy-analyzer');
			console.log(`andy-analyzer path: ${this.executablePath}`);
		}
	}

	launch() {
		const start = Date.now();

		this.executable = cp.spawn(this.executablePath, ["--server"]);

		if(!this.executable || !this.executable.pid) {
			return false;
		}

		const end = Date.now();

		console.log('andy-analyzer server started in ' + (end - start) + 'ms');

		this.executable.on('close', (code) => {
			this.throwErrorAtServer(`Exited with code ${code}`);
		});

		return true;
	}

	analyse(document: vscode.TextDocument) : AnalyzerResult {
		if(document.languageId !== 'andy') {
			console.log("anlyse cancel, not andy language");

			return new AnalyzerResult([]);
		}

		const now = Date.now();

		const content = document.getText();

		const tmpFileName = path.join(os.tmpdir(), document.fileName.substring(document.fileName.lastIndexOf(path.sep) + 1));

		fs.writeFileSync(tmpFileName, content);

		var command = [document.fileName, tmpFileName];

		if(!this.writeCommand(command)) {
			this.throwErrorAtServer('unable to write command');
			return new AnalyzerResult([]);
		}

		// Read 4 hexa bytes to get the size of the result
		var len = this.executable?.stdout?.read(8);

		console.log(`len: ${len}`);

		// Parses the size of the result
		if(!len) {
			this.throwErrorAtServer('unable to read size');
			return new AnalyzerResult([]);
		}

		const size = parseInt(len.toString(), 16);

		var data = this.executable?.stdout?.read(size);

		try {
			var result = JSON.parse(data.toString());
		} catch(e) {
			console.log(`error parsing JSON: ${e}`);
			console.log(`data: ${data.toString()}`);
			return new AnalyzerResult([]);
		}

		console.log(`${command} success in ${result.elapsed}`);

		const analyzerResult = new AnalyzerResult([]);

		// for(const token of result.tokens) {
		// 	const location = new Location(token.location.file, token.location.line, token.location.column, token.location.offset, token.location.length);

		// 	analyzerResult.tokens.push(new Token(token.type, location));
		// }
		
		for(const declaration of result.declarations) {
			//console.log(`declaration: ${JSON.stringify(declaration)}`);

			const location = declaration.location ? new Location(declaration.location.file, declaration.location.line, declaration.location.column, declaration.location.offset) : null;
			analyzerResult.declarations.push(new Declaration(declaration.name, location, declaration.type));
		}

		for(const reference of result.references) {
			//console.log(`reference: ${JSON.stringify(reference)}`);

			const location = new Location(reference.location.file, reference.location.line, reference.location.column, reference.location.offset);

			analyzerResult.references.push(new Reference(reference.name, reference.type, location));
		}

		for(const warning of result.linter) {
			//console.log(`warning: ${JSON.stringify(warning)}`);

			const location = new Location(warning.location.file, warning.location.line, warning.location.column, warning.location.offset, warning.location.length);

			analyzerResult.linter.push(new LinterWarning(warning.message, warning.type, location));
		}

		for(const error of result.errors) {
			//console.log(`error: ${JSON.stringify(error)}`);

			const location = new Location(error.location.file, error.location.line, error.location.column, error.location.offset, error.location.length);

			analyzerResult.linterErrors.push(new LinterError(error.message, error.type, location));
		}

		return analyzerResult;
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

		var analyzerResult = this.analyzerServer.analyse(document);

		for(const declaration of analyzerResult.declarations) {
			if(declaration.name === word) {
				if(declaration.location) {
					const startPos = new vscode.Position(declaration.location.line, declaration.location.column);
					const endPos = new vscode.Position(declaration.location.line, declaration.location.column + declaration.name.length);
					const range = new vscode.Range(startPos, endPos);
					const uri = vscode.Uri.file(declaration.location.file);
					
					return new vscode.Location(uri, range);
				}
			}
		}
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
	textDecoration: 'none',
});

const functionCallDecorationType = vscode.window.createTextEditorDecorationType({
	color: '#DCDCAA',
	textDecoration: 'none',
});

const variableDecorationType = vscode.window.createTextEditorDecorationType({
	color: '#9CDCFE',
	textDecoration: 'none',
});

const diagnosticCollection = vscode.languages.createDiagnosticCollection('meuLinter');

function updateDecorations(analyzerServer: AnalyzerServer) {
	console.log('updateDecorations8...');

	const editor = vscode.window.activeTextEditor;

	if(!editor) {
		console.log('no active editor');
		return;
	}

	var analyzerResult = analyzerServer.analyse(editor.document);

	//console.log('analyze result: ' + JSON.stringify(analyzerResult));
	var classesRanges = [];
	var functionCallsRanges = [];
	var variableRanges = [];

	for(const declaration of analyzerResult.declarations) {
		// console.log(`decoring declaration for ${declaration.name} at ${JSON.stringify(declaration.location)}...`);

		if(declaration.location) {
			if(editor.document.fileName == declaration.location.file) {
				var range = referenceRange(editor, declaration.location, declaration.name);
				if(declaration.type === 'class') {
					classesRanges.push(range);
				} else if(declaration.type === 'function') {
					functionCallsRanges.push(range);
				}
			}
		}
	}

	for(const reference of analyzerResult.references) {
		console.log(`decorating reference ${JSON.stringify(reference)}...`);

		if(editor.document.fileName == reference.location.file) {
			var range = referenceRange(editor, reference.location, reference.name);
			if(reference.type === 'class') {
				classesRanges.push(range);
			} else if(reference.type === 'function') {
				functionCallsRanges.push(range);
			} else if(reference.type === 'variable') {
				variableRanges.push(range);
			}
		}
	}

	editor.setDecorations(classDecorationType, classesRanges);
	editor.setDecorations(functionCallDecorationType, functionCallsRanges);
	editor.setDecorations(variableDecorationType, variableRanges);

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
	console.log(`errors: ${analyzerResult.linterErrors.length}`);
	for(let i = 0; i < analyzerResult.linterErrors.length; i++) {
		var error = analyzerResult.linterErrors[i];
		const range = new vscode.Range(
			new vscode.Position(error.location.line, error.location.column), // Início do aviso
			new vscode.Position(error.location.line, error.location.column + error.location.length) // Fim do aviso
		);
		const diagnostic = new vscode.Diagnostic(
			range,
			error.message,
			vscode.DiagnosticSeverity.Error
		);

		var array = diagnostics.get(error.location.file);

		if(!array) {
			array = [];
			//console.log(`new array for ${error.location.file}`);
		}

		array.push(diagnostic);

		diagnostics.set(error.location.file, array);
	};

	//console.log(`diagnostics: ${diagnostics.size}`);

	diagnostics.forEach((value, key) => {
		//console.log(`diagnostics for ${key}: ${value.length}`);
		diagnosticCollection.set(vscode.Uri.file(key), value);
	});
};

function setIntervalToUpdateDecorations(analyzerServer: AnalyzerServer) {
	setTimeout(() => {
		if(analyzerServer) {
			updateDecorations(analyzerServer);
		}
		setIntervalToUpdateDecorations(analyzerServer);
	}, 1000);
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('andy-analyzer extension activated 5');
	var analyzerServer = new AnalyzerServer(context.extensionMode === vscode.ExtensionMode.Development);

	var onError = (error: Error) => {

		vscode.window.showErrorMessage(`${error.message}. The server will be restarted.`);

		setTimeout(() => {
			analyzerServer = new AnalyzerServer(context.extensionMode === vscode.ExtensionMode.Development);
			analyzerServer.onError = onError;
			analyzerServer.launch();
		}, 3000);
	};
	
	if(!analyzerServer.launch()) {
		const message = "Unable to start analyzer server. Make sure andy-analyzer is installed and is in your PATH. If you have just installed it, you may need to restart Visual Studio Code or your computer.";
		
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

	console.log('andy-analyzer server started');

	// const onDidChangeActiveTextEditor = vscode.window.onDidChangeActiveTextEditor((editor) => {
	// 	updateCurrentDocumentDecorations();
	// });

	// const onDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument((event) => {
	// 	updateCurrentDocumentDecorations();
	// });

	//context.subscriptions.push(onDidChangeActiveTextEditor, onDidChangeTextDocument, registerDefinitionProvider);

	setIntervalToUpdateDecorations(analyzerServer);

	const registerDefinitionProvider = vscode.languages.registerDefinitionProvider({ scheme: 'file', language: 'andy' }, new MyDefinitionProvider(analyzerServer));

	// const legend = new vscode.SemanticTokensLegend(
    //     ['comment', 'preprocessor', 'literal', 'keyword' ]
    // );
	// const disposable = vscode.languages.registerDocumentSemanticTokensProvider(
	// 	{ scheme: 'file', language: 'andy' },
	// 	{
	// 		provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.ProviderResult<vscode.SemanticTokens> {
	// 			console.log('provideDocumentSemanticTokens2');
	// 			return analyzerServer.analyse(document).then((analyzerResult) => {
	// 				const builder = new vscode.SemanticTokensBuilder();

	// 				for(const token of analyzerResult.tokens) {
	// 					builder.push(token.location.line, token.location.column, token.location.length, legend.tokenTypes.indexOf(token.type));
	// 				}

	// 				return builder.build();
	// 			});
	// 		}
	// 	},
	// 	legend
	// );

	// context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
