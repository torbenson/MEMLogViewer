import * as vscode from 'vscode';
import {
    LOG_TYPE_ERROR,
    LOG_TYPE_WARNING,
    MESSAGE_START_LENGTH,
    parseDocument,
    subComponentPrefixLength,
} from './parser';

const CMTRACE_FIRST_LINE_RE = /^<!\[LOG\[/;

interface Decorations {
    warning: vscode.TextEditorDecorationType;
    error: vscode.TextEditorDecorationType;
    /** Undefined when `subComponentStyle` is `none`. */
    subComponent: vscode.TextEditorDecorationType | undefined;
}

function applyDecorations(editor: vscode.TextEditor, decorations: Decorations) {
    if (editor.document.languageId !== 'cmtrace') { return; }

    const config = vscode.workspace.getConfiguration('mem-log-viewer');
    const highlight = config.get<boolean>('enableHighlighting', true);

    const text = editor.document.getText();
    const entries = parseDocument(text);

    const warnings: vscode.Range[] = [];
    const errors: vscode.Range[] = [];
    const subComponents: vscode.Range[] = [];

    for (const entry of entries) {
        if (decorations.subComponent) {
            const prefixLength = subComponentPrefixLength(entry.message);
            if (prefixLength > 0) {
                const prefixStart = entry.offset + MESSAGE_START_LENGTH;
                subComponents.push(new vscode.Range(
                    editor.document.positionAt(prefixStart),
                    editor.document.positionAt(prefixStart + prefixLength)
                ));
            }
        }

        if (!highlight) { continue; }
        if (entry.type !== LOG_TYPE_WARNING && entry.type !== LOG_TYPE_ERROR) { continue; }

        // positionAt() converts a raw character offset into a { line, character }
        // position. This is the correct way to map parsed results back to editor
        // locations when the content may span multiple lines.
        const start = editor.document.positionAt(entry.offset);
        const end   = editor.document.positionAt(entry.offset + entry.length);
        const range = new vscode.Range(start, end);

        if (entry.type === LOG_TYPE_WARNING) { warnings.push(range); }
        if (entry.type === LOG_TYPE_ERROR) { errors.push(range); }
    }

    // When highlighting is off these are empty, which clears anything already
    // on screen.
    editor.setDecorations(decorations.warning, warnings);
    editor.setDecorations(decorations.error, errors);
    if (decorations.subComponent) {
        editor.setDecorations(decorations.subComponent, subComponents);
    }
}

function createSubComponentDecoration(styles: string[]): vscode.TextEditorDecorationType | undefined {
    const bold = styles.includes('bold');
    const italic = styles.includes('italic');
    const underline = styles.includes('underline');
    if (!bold && !italic && !underline) { return undefined; }
    return vscode.window.createTextEditorDecorationType({
        fontWeight: bold ? 'bold' : undefined,
        fontStyle: italic ? 'italic' : undefined,
        textDecoration: underline ? 'underline' : undefined,
    });
}

function createDecorationTypes(): Decorations {
    // getConfiguration('mem-log-viewer') reads all settings under that prefix.
    // get<string>('warningColor', fallback) returns the user's value if set,
    // otherwise the declared default from package.json, otherwise the fallback.
    const config = vscode.workspace.getConfiguration('mem-log-viewer');
    return {
        warning: vscode.window.createTextEditorDecorationType({
            backgroundColor: config.get<string>('warningColor', '#ffc80033'),
            isWholeLine: true,
        }),
        error: vscode.window.createTextEditorDecorationType({
            backgroundColor: config.get<string>('errorColor', '#ff000033'),
            isWholeLine: true,
        }),
        subComponent: createSubComponentDecoration(config.get<string[]>('subComponentStyle', ['bold'])),
    };
}

function disposeDecorations(decorations: Decorations) {
    decorations.warning.dispose();
    decorations.error.dispose();
    decorations.subComponent?.dispose();
}

export function activate(context: vscode.ExtensionContext) {

    // Decoration types are mutable state — when the user changes a setting we
    // dispose these and replace them with new ones.
    let decorations = createDecorationTypes();

    // Push a single wrapper disposable rather than the decoration types
    // themselves. This way we always dispose whatever the *current* types are
    // on deactivate, even after config-driven replacements.
    context.subscriptions.push({
        dispose: () => disposeDecorations(decorations)
    });

    const decorate = (editor: vscode.TextEditor | undefined) => {
        if (editor) { applyDecorations(editor, decorations); }
    };

    const ensureCmtraceLanguage = (doc: vscode.TextDocument) => {
        if (doc.languageId === 'cmtrace') { return; }
        if (doc.lineCount === 0) { return; }
        if (CMTRACE_FIRST_LINE_RE.test(doc.lineAt(0).text)) {
            vscode.languages.setTextDocumentLanguage(doc, 'cmtrace').then(
                updatedDoc => {
                    const editor = vscode.window.visibleTextEditors.find(e => e.document === updatedDoc);
                    if (editor) { decorate(editor); }
                },
                () => {}
            );
        }
    };

    for (const doc of vscode.workspace.textDocuments) {
        ensureCmtraceLanguage(doc);
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(ensureCmtraceLanguage)
    );

    decorate(vscode.window.activeTextEditor);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(decorate)
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                decorate(editor);
            }
        })
    );

    // When the user changes a setting, recreate decoration types with the new
    // colors and immediately re-decorate the active editor.
    // affectsConfiguration() is a cheap prefix check — avoids reacting to
    // every settings change in VS Code, only ones under our prefix.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('mem-log-viewer')) {
                disposeDecorations(decorations);
                decorations = createDecorationTypes();
                decorate(vscode.window.activeTextEditor);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mem-log-viewer.parseLogs', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('MEM Log: No active editor.');
                return;
            }

            const entries = parseDocument(editor.document.getText());

            let info = 0, warnings = 0, errors = 0, unparsed = 0;
            const errorMessages: string[] = [];

            for (const entry of entries) {
                // A truncated record carries no trustworthy metadata, so it is
                // reported separately rather than being counted as Info.
                if (entry.malformed) { unparsed++; continue; }

                if (entry.type === LOG_TYPE_WARNING) {
                    warnings++;
                } else if (entry.type === LOG_TYPE_ERROR) {
                    errors++;
                    if (errorMessages.length < 5) {
                        errorMessages.push(`[${entry.date} ${entry.time}] ${entry.message}`);
                    }
                } else {
                    info++;
                }
            }

            let summary = `Parsed ${entries.length} entries — Info: ${info}  Warnings: ${warnings}  Errors: ${errors}`;
            if (unparsed > 0) {
                summary += `  Unparsable: ${unparsed}`;
            }
            if (errorMessages.length > 0) {
                summary += '\n\nFirst errors:\n' + errorMessages.join('\n');
            }

            vscode.window.showInformationMessage(summary, { modal: true });
        })
    );
}

export function deactivate() {}
