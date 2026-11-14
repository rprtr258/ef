// Bundle entry for the extension's language server: dist/server.cjs runs this
// file as main, which starts the stdio connection. (compiler/lsp.ts stays a
// library — `ef lsp` starts the same server through the CLI.)
import {startLsp} from "../../compiler/lsp.ts";

startLsp();
