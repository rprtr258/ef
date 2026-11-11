// ef extension entry: starts the language client that spawns the bundled ef
// language server (compiler/lsp.ts — the same file `ef lsp` serves, bundled
// to dist/server.cjs by scripts/build.ts). Activation is automatic on .ef
// documents via the manifest's languages contribution.
import {LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions} from "vscode-languageclient/node";
import {type ExtensionContext} from "vscode";

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  const serverModule = context.asAbsolutePath("dist/server.cjs");
  const serverOptions: ServerOptions = {
    run: {module: serverModule, transport: TransportKind.stdio},
    debug: {module: serverModule, transport: TransportKind.stdio, options: {execArgv: ["--nolazy", "--inspect=6009"]}},
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      {language: "ef", scheme: "file"},
      {language: "ef", scheme: "untitled"},
    ],
  };
  client = new LanguageClient("ef", "ef Language Server", serverOptions, clientOptions);
  void client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
