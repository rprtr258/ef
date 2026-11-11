// LSP protocol tests: spawn the built server bundle with process.execPath
// (bun under `bun test`; VS Code's Electron node in production — the bundle
// is plain CJS) and speak raw LSP over stdio, driving the same paths the
// extension client drives: initialize handshake, full-sync didChange
// diagnostics, hover, shutdown/exit.
import {beforeAll, afterAll, describe, expect, test} from "bun:test";
import {spawn, type ChildProcess} from "child_process";
import {buildServer} from "../scripts/build.ts";

const URI = "file:///test.ef";

type Msg = {id?: number, method?: string, params?: unknown, result?: unknown, error?: unknown};
type Diag = {range: {start: {line: number, character: number}}, message: string, source?: string};
type DiagParams = {uri: string, diagnostics: Diag[]};

class Server {
  proc: ChildProcess;
  private acc = Buffer.alloc(0);
  private idNext = 1;
  private respWaiters = new Map<number, (r: Msg) => void>();
  private diagWaiters: Array<(p: DiagParams) => void> = [];

  constructor() {
    this.proc = spawn(process.execPath, [import.meta.dir + "/../dist/server.cjs"], {stdio: ["pipe", "pipe", "pipe"]});
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.acc = Buffer.concat([this.acc, chunk]);
    for (;;) {
      const headEnd = this.acc.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = this.acc.subarray(0, headEnd).toString();
      const m = /Content-Length: (\d+)/.exec(head);
      if (m === null) throw new Error("malformed LSP header: " + head);
      const len = Number(m[1]);
      const total = headEnd + 4 + len;
      if (this.acc.length < total) return;
      const msg = JSON.parse(this.acc.subarray(headEnd + 4, total).toString()) as Msg;
      this.acc = this.acc.subarray(total);
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Msg): void {
    if (typeof msg.id === "number") {
      const w = this.respWaiters.get(msg.id);
      if (w !== undefined) {
        this.respWaiters.delete(msg.id);
        w(msg);
      }
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const w = this.diagWaiters.shift();
      if (w !== undefined) w(msg.params as DiagParams);
    }
  }

  private write(msg: object): void {
    const body = JSON.stringify(msg);
    this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.idNext++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 4000);
      this.respWaiters.set(id, r => {
        clearTimeout(t);
        resolve(r);
      });
      this.write({jsonrpc: "2.0", id, method, params});
    });
  }

  notify(method: string, params: unknown): void {
    this.write({jsonrpc: "2.0", method, params});
  }

  // didOpen + didChange each trigger exactly one publishDiagnostics; awaiting
  // it keeps the shared-document tests ordered.
  async open(src: string): Promise<DiagParams> {
    const wait = this.waitDiagnostics();
    this.notify("textDocument/didOpen", {textDocument: {uri: URI, languageId: "ef", version: 1, text: src}});
    return wait;
  }

  async change(src: string): Promise<DiagParams> {
    const wait = this.waitDiagnostics();
    this.notify("textDocument/didChange", {textDocument: {uri: URI, version: 2}, contentChanges: [{text: src}]});
    return wait;
  }

  async hover(line: number, character: number): Promise<{contents: {value: string}} | null> {
    const r = await this.request("textDocument/hover", {textDocument: {uri: URI}, position: {line, character}}) as {result: {contents: {value: string}} | null};
    return r.result;
  }

  private waitDiagnostics(): Promise<DiagParams> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for publishDiagnostics")), 4000);
      this.diagWaiters.push(p => {
        clearTimeout(t);
        resolve(p);
      });
    });
  }

  kill(): void {
    this.proc.kill();
  }
}

describe("ef language server", () => {
  let s: Server;

  beforeAll(async () => {
    await buildServer();
    s = new Server();
    const r = await s.request("initialize", {processId: null, rootUri: null, capabilities: {}}) as {result: {capabilities: {textDocumentSync: number, hoverProvider: boolean}}};
    expect(r.result.capabilities.textDocumentSync).toBe(1); // Full
    expect(r.result.capabilities.hoverProvider).toBe(true);
    s.notify("initialized", {});
  });

  afterAll(() => {
    s.kill();
  });

  test("located type error anchors at the checker's position", async () => {
    const p = await s.open("f :: fn(): i64 {\"s\"};\n");
    expect(p.diagnostics).toHaveLength(1);
    const d = p.diagnostics[0];
    expect(d.source).toBe("ef");
    // Checker stamps `at line 1, col 6: ` (1-based, the lambda) — 0-based (0, 5).
    expect(d.range.start).toEqual({line: 0, character: 5});
    expect(d.message.startsWith("Type mismatch:")).toBe(true);
  });

  test("unlocated type error anchors at 0:0", async () => {
    const p = await s.change("x :: 1;\nx + \"a\";\n");
    expect(p.diagnostics).toHaveLength(1);
    const d = p.diagnostics[0];
    expect(d.range.start).toEqual({line: 0, character: 0});
    expect(d.message).toBe("+: i64 and string are not both numeric or both string");
  });

  test("corrected document clears diagnostics", async () => {
    const p = await s.change("f :: fn(): i64 {1};\n");
    expect(p.diagnostics).toHaveLength(0);
  });

  test("parse error anchors at 0:0 with the parser message", async () => {
    const p = await s.change("fn\n");
    expect(p.diagnostics).toHaveLength(1);
    const d = p.diagnostics[0];
    expect(d.range.start).toEqual({line: 0, character: 0});
    expect(d.message.length).toBeGreaterThan(0);
  });

  test("hover on a top-level binding shows its type", async () => {
    await s.change("n :: 42;\n");
    const h = await s.hover(0, 0);
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("n : i64");
  });

  test("hover on a builtin shows its type", async () => {
    await s.change("list(1);\n");
    const h = await s.hover(0, 1);
    expect(h).not.toBeNull();
    expect(h!.contents.value.startsWith("list : ")).toBe(true);
  });

  test("hover on a non-binding word returns nothing", async () => {
    await s.change("f :: fn(): i64 {1};\n");
    const h = await s.hover(0, 6); // over `fn`
    expect(h).toBeNull();
  });

  test("shutdown then exit terminates with code 0", async () => {
    const r = await s.request("shutdown", null) as {result: unknown};
    expect(r.result).toBeNull();
    const code = await new Promise<number | null>(resolve => {
      s.proc.on("exit", resolve);
      s.notify("exit", null);
    });
    expect(code).toBe(0);
  });
});
