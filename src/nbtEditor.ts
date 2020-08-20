import * as path from 'path';
import * as vscode from 'vscode';
import { Disposable, disposeAll } from './dispose';
import { getNonce, hasGzipHeader, isRegionFile, zlibUnzip } from './util';
const {gzip, ungzip} = require('node-gzip');
const nbt = require('nbt')

interface NbtEdit {
    readonly type: string
    readonly path: (string | number)[]
    readonly value: any
}

interface NbtDocumentDelegate {
    getFileData(): Promise<NbtFile>;
}

type NbtFile = {
    anvil: false,
    gzipped: boolean,
    data: NamedNbtCompound
} | {
    anvil: true,
    chunks: NbtChunk[]
}

type NbtChunk = {
    x: number,
    z: number,
    timestamp: Uint8Array,
    compression: number,
    loaded: boolean
    data?: Uint8Array | NamedNbtCompound
}

type NamedNbtCompound = {
    name: string,
    value: any
}

class NbtDocument extends Disposable implements vscode.CustomDocument {

    static async create(
        uri: vscode.Uri,
        backupId: string | undefined,
        delegate: NbtDocumentDelegate,
    ): Promise<NbtDocument | PromiseLike<NbtDocument>> {
        const dataFile = typeof backupId === 'string' ? vscode.Uri.parse(backupId) : uri;
        const fileData = await NbtDocument.readFile(dataFile);
        return new NbtDocument(uri, fileData, delegate);
    }

    private static async readFile(uri: vscode.Uri): Promise<NbtFile> {
        if (uri.scheme === 'untitled') {
            return {
                anvil: false,
                gzipped: false,
                data: { name: '', value: {} }
            }
        }

        let array = await vscode.workspace.fs.readFile(uri);

        if (isRegionFile(uri)) {
            const chunks = this.readRegionHeader(array)
            return { anvil: true, chunks }
        }

        const gzipped = hasGzipHeader(array)
        if (gzipped) {
            array = await ungzip(array)
        }

        const data = nbt.parseUncompressed(array)
        return {
            anvil: false,
            gzipped,
            data
        }
    }

    private static readRegionHeader(array: Uint8Array): NbtChunk[] {
        const chunks: NbtChunk[] = [];
        for (let x = 0; x < 32; x += 1) {
            for (let z = 0; z < 32; z += 1) {
                const i = 4 * ((x & 31) + (z & 31) * 32);
                const sectors = array[i + 3];
                if (sectors === 0) continue;

                const offset = (array[i] << 16) + (array[i + 1] << 8) + array[i + 2];
                const timestamp = array.slice(i + 4096, i + 4100);

                const j = offset * 4096;
                const length = (array[j] << 24) + (array[j + 1] << 16) + (array[j + 2] << 8) + array[j + 3] 
                const compression = array[j + 4]
                const data = array.slice(j + 5, j + 4 + length)

                chunks.push({ x, z, timestamp, compression, loaded: false, data });
            }
        }
        return chunks;
    }

    private readonly _uri: vscode.Uri;

    private _documentData: NbtFile;
    private _edits: Array<NbtEdit> = [];
    private _savedEdits: Array<NbtEdit> = [];

    private readonly _delegate: NbtDocumentDelegate;

    private constructor(
        uri: vscode.Uri,
        initialContent: NbtFile,
        delegate: NbtDocumentDelegate
    ) {
        super();
        this._uri = uri;
        this._documentData = initialContent;
        this._delegate = delegate;
    }

    public get uri() { return this._uri; }

    public get documentData(): NbtFile { return this._documentData; }

    private readonly _onDidDispose = this._register(new vscode.EventEmitter<void>());

    public readonly onDidDispose = this._onDidDispose.event;

    private readonly _onDidChangeDocument = this._register(new vscode.EventEmitter<{
        readonly content?: NbtFile;
        readonly edits: readonly NbtEdit[];
    }>());

    public readonly onDidChangeContent = this._onDidChangeDocument.event;

    private readonly _onDidChange = this._register(new vscode.EventEmitter<{
        readonly label: string,
        undo(): void,
        redo(): void,
    }>());

    public readonly onDidChange = this._onDidChange.event;

    dispose(): void {
        this._onDidDispose.fire();
        super.dispose();
    }

    async getChunkData(index: number): Promise<NbtChunk> {
        if (!this._documentData.anvil) {
            throw {};
        }

        const chunk = this._documentData.chunks[index];
        if (chunk.loaded) return chunk;

        let data = chunk.data as Uint8Array;
        if (chunk.compression === 1) {
            data = await ungzip(data);
        } else if (chunk.compression === 2) {
            data = await zlibUnzip(data);
        }

        chunk.data = nbt.parseUncompressed(data);
        chunk.loaded = true;
        return chunk;
    }

    makeEdit(edit: NbtEdit) {
        this._edits.push(edit);

        this._onDidChange.fire({
            label: 'Stroke',
            undo: async () => {
                this._edits.pop();
                this._onDidChangeDocument.fire({
                    edits: this._edits,
                });
            },
            redo: async () => {
                this._edits.push(edit);
                this._onDidChangeDocument.fire({
                    edits: this._edits,
                });
            }
        });
    }

    async save(cancellation: vscode.CancellationToken): Promise<void> {
        await this.saveAs(this.uri, cancellation);
        this._savedEdits = Array.from(this._edits);
    }

    async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        const nbtFile = await this._delegate.getFileData();
        if (cancellation.isCancellationRequested) {
            return;
        }
        if (nbtFile.anvil) {
            return
        }
        const buffer = nbt.writeUncompressed(nbtFile.data)
        const fileData = new Uint8Array(nbtFile.gzipped ? await gzip(buffer) : buffer)
        await vscode.workspace.fs.writeFile(targetResource, fileData);
    }

    async revert(_cancellation: vscode.CancellationToken): Promise<void> {
        const diskContent = await NbtDocument.readFile(this.uri);
        this._documentData = diskContent;
        this._edits = this._savedEdits;
        this._onDidChangeDocument.fire({
            content: diskContent,
            edits: this._edits,
        });
    }

    async backup(destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        await this.saveAs(destination, cancellation);

        return {
            id: destination.toString(),
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(destination);
                } catch { }
            }
        };
    }
}

export class NbtEditorProvider implements vscode.CustomEditorProvider<NbtDocument> {

    private static newNbtFileId = 1;

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        vscode.commands.registerCommand('nbtEditor.nbt.new', () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage("Creating new NBT files currently requires opening a workspace");
                return;
            }

            const uri = vscode.Uri.joinPath(workspaceFolders[0].uri, `new-${NbtEditorProvider.newNbtFileId++}.nbt`)
                .with({ scheme: 'untitled' });

            vscode.commands.executeCommand('vscode.openWith', uri, NbtEditorProvider.viewType);
        });

        return vscode.window.registerCustomEditorProvider(
            NbtEditorProvider.viewType,
            new NbtEditorProvider(context),
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                },
                supportsMultipleEditorsPerDocument: false,
            });
    }

    private static readonly viewType = 'nbtEditor.nbt';

    private readonly webviews = new WebviewCollection();

    constructor(
        private readonly _context: vscode.ExtensionContext
    ) { }

    //#region CustomEditorProvider

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: { backupId?: string },
        _token: vscode.CancellationToken
    ): Promise<NbtDocument> {
        const document: NbtDocument = await NbtDocument.create(uri, openContext.backupId, {
            getFileData: async () => {
                const webviewsForDocument = Array.from(this.webviews.get(document.uri));
                if (!webviewsForDocument.length) {
                    throw new Error('Could not find webview to save for');
                }
                const panel = webviewsForDocument[0];
                const response = await this.postMessageWithResponse<NbtFile>(panel, 'getFileData', {});
                return response;
            }
        });

        const listeners: vscode.Disposable[] = [];

        listeners.push(document.onDidChange(e => {
            this._onDidChangeCustomDocument.fire({ document, ...e, });
        }));

        listeners.push(document.onDidChangeContent(e => {
            for (const webviewPanel of this.webviews.get(document.uri)) {
                this.postMessage(webviewPanel, 'update', { edits: e.edits, content: e.content, });
            }
        }));

        document.onDidDispose(() => disposeAll(listeners));

        return document;
    }

    async resolveCustomEditor(
        document: NbtDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        this.webviews.add(document.uri, webviewPanel);

        webviewPanel.webview.options = {
            enableScripts: true,
        };
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        webviewPanel.webview.onDidReceiveMessage(e => this.onMessage(document, e));

        webviewPanel.webview.onDidReceiveMessage(e => {
            if (e.type === 'ready') {
                if (document.uri.scheme === 'untitled') {
                    this.postMessage(webviewPanel, 'init', {
                        untitled: true
                    });
                } else {
                    if (document.documentData.anvil) {
                        const chunks: NbtChunk[] = document.documentData.chunks.map(c => ({
                            x: c.x,
                            z: c.z,
                            timestamp: c.timestamp,
                            compression: c.compression,
                            loaded: c.loaded,
                            data: c.loaded ? c.data : undefined
                        }))
                        this.postMessage(webviewPanel, 'init', {
                            value: { anvil: true, chunks }
                        });
                    } else {
                        this.postMessage(webviewPanel, 'init', {
                            value: document.documentData
                        });
                    }
                }
            }
        });
    }

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<NbtDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    public saveCustomDocument(document: NbtDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return document.save(cancellation);
    }

    public saveCustomDocumentAs(document: NbtDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
        return document.saveAs(destination, cancellation);
    }

    public revertCustomDocument(document: NbtDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return document.revert(cancellation);
    }

    public backupCustomDocument(document: NbtDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
        return document.backup(context.destination, cancellation);
    }

    //#endregion

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.file(
            path.join(this._context.extensionPath, 'media', 'nbt.js')
        ));
        const styleUri = webview.asWebviewUri(vscode.Uri.file(
            path.join(this._context.extensionPath, 'media', 'nbt.css')
        ));

        const nonce = getNonce();

        return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
				Use a content security policy to only allow loading images from https or from our extension directory,
				and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleUri}" rel="stylesheet" />

				<title>NBT Editor</title>
			</head>
            <body>
                <div class="nbt-editor"></div>

				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
    }

    private _requestId = 1;
    private readonly _callbacks = new Map<number, (response: any) => void>();

    private postMessageWithResponse<R = unknown>(panel: vscode.WebviewPanel, type: string, body: any): Promise<R> {
        const requestId = this._requestId++;
        const p = new Promise<R>(resolve => this._callbacks.set(requestId, resolve));
        panel.webview.postMessage({ type, requestId, body });
        return p;
    }

    private postMessage(panel: vscode.WebviewPanel, type: string, body: any): void {
        panel.webview.postMessage({ type, body });
    }

    private onMessage(document: NbtDocument, message: any) {
        switch (message.type) {
            case 'stroke':
                document.makeEdit(message as NbtEdit);
                return;

            case 'getChunkData':
                document.getChunkData(message.index as number).then(data => {
                    for (const webviewPanel of this.webviews.get(document.uri)) {
                        this.postMessage(webviewPanel, 'chunk', data);
                    }
                });

            case 'response':
                {
                    const callback = this._callbacks.get(message.requestId);
                    callback?.(message.body);
                    return;
                }
        }
    }
}

class WebviewCollection {

    private readonly _webviews = new Set<{
        readonly resource: string;
        readonly webviewPanel: vscode.WebviewPanel;
    }>();

    public *get(uri: vscode.Uri): Iterable<vscode.WebviewPanel> {
        const key = uri.toString();
        for (const entry of this._webviews) {
            if (entry.resource === key) {
                yield entry.webviewPanel;
            }
        }
    }

    public add(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel) {
        const entry = { resource: uri.toString(), webviewPanel };
        this._webviews.add(entry);

        webviewPanel.onDidDispose(() => {
            this._webviews.delete(entry);
        });
    }
}
