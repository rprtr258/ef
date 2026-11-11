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
type Diag = {range: {start: {line: number, character: number}, end: {line: number, character: number}}, message: string, source?: string};
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

  async semanticTokens(): Promise<{data: number[]}> {
    const r = await this.request("textDocument/semanticTokens/full", {textDocument: {uri: URI}}) as {result: {data: number[]} | null};
    return r.result ?? {data: []};
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
    // The lambda is stamped at line 1, col 6 (1-based) — 0-based (0, 5).
    expect(d.range.start).toEqual({line: 0, character: 5});
    expect(d.message.startsWith("Type mismatch:")).toBe(true);
  });

  test("type error anchors at the offending expression", async () => {
    const p = await s.change("x :: 1;\nx + \"a\";\n");
    expect(p.diagnostics).toHaveLength(1);
    const d = p.diagnostics[0];
    // The `+` app starts at its left operand, line 2 col 1 — 0-based (1, 0).
    expect(d.range.start).toEqual({line: 1, character: 0});
    expect(d.message).toBe("+: i64 and string are not both numeric or both string");
  });

  test("corrected document clears diagnostics", async () => {
    const p = await s.change("f :: fn(): i64 {1};\n");
    expect(p.diagnostics).toHaveLength(0);
  });

  test("parse error underlines the offending token", async () => {
    const p = await s.change("x :: 1\ny :: 2;\n");
    expect(p.diagnostics).toHaveLength(1);
    const d = p.diagnostics[0];
    // The missing `;` is discovered at `y`, line 2 col 1 — 0-based (1, 0).
    expect(d.range.start).toEqual({line: 1, character: 0});
    expect(d.range.end).toEqual({line: 1, character: 1});
    expect(d.message).toBe(`Expected ";", got "y"`);
  });

  test("parse error at EOF anchors at the last token's end", async () => {
    const p = await s.change("fn\n");
    expect(p.diagnostics).toHaveLength(1);
    const d = p.diagnostics[0];
    // `fn` spans 1:1–1:3; input ran out after it — 0-based (0, 2).
    expect(d.range.start).toEqual({line: 0, character: 2});
    expect(d.message.length).toBeGreaterThan(0);
  });

  test("hover on a top-level binding shows its type", async () => {
    await s.change("n :: 42;\n");
    const h = await s.hover(0, 0);
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nn : i64\n```");
  });

  test("hover on a builtin shows its type", async () => {
    await s.change("list(1);\n");
    const h = await s.hover(0, 1);
    expect(h).not.toBeNull();
    expect(h!.contents.value.startsWith("```ef\nlist : ")).toBe(true);
  });

  test("hover on a subexpression shows its type", async () => {
    await s.change("n :: 1 + 2 * 3;\n");
    const h1 = await s.hover(0, 9); // over `2`
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\ni64\n```");
    const h2 = await s.hover(0, 11); // over `*`
    expect(h2!.contents.value).toBe("```ef\ni64\n```");
  });

  test("hover on a lambda shows its function type", async () => {
    await s.change("f :: fn(): i64 {1};\n");
    const h = await s.hover(0, 6); // over `fn`
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\n() -> i64\n```");
  });

  test("hover on a sym use shows the instantiated polymorphic type", async () => {
    await s.change("id :: fn(x) { x };\nm :: id(42);\n");
    const h1 = await s.hover(1, 5); // the call site
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\nid : (i64) -> i64\n```");
    const h2 = await s.hover(0, 6); // the lambda itself
    expect(h2!.contents.value).toBe("```ef\n(a) -> a\n```");
  });

  test("hover on an effect op shows its signature like a function", async () => {
    await s.change("effect Choose(): bool;\nn :: Choose!();\n");
    const h1 = await s.hover(1, 5); // over `Choose` in the perform
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\nChoose : () -> bool\n```");
    const h2 = await s.hover(1, 11); // over `!`
    expect(h2!.contents.value).toBe("```ef\nChoose : () -> bool\n```");
  });

  test("hover on an effect op with params shows them resolved", async () => {
    await s.change("effect Get(v: i64): i64;\nm :: Get!(42);\n");
    const h = await s.hover(1, 5); // over `Get`
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nGet : (i64) -> i64\n```");
  });

  test("hover on a builtin effect op shows its signature", async () => {
    await s.change("n :: Read!(\"x.txt\");\n");
    const h = await s.hover(0, 5); // over `Read`
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nRead : (string) -> string\n```");
  });

  test("hover on a handler case label shows the op's signature", async () => {
    await s.change("effect Get(): i64;\nn :: handle { Get!(); } case Get() => k { k(42) };\n");
    const h = await s.hover(1, 29); // over `Get` in the case label
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nGet : () -> i64\n```");
  });

  test("hover on an effect decl or row name shows the op's signature", async () => {
    await s.change("effect Get(): i64;\nf :: fn(): i64 ! { Get } { Get!() };\n");
    const h1 = await s.hover(0, 7); // the decl name
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\nGet : () -> i64\n```");
    const h2 = await s.hover(1, 19); // the `! { … }` row name
    expect(h2!.contents.value).toBe("```ef\nGet : () -> i64\n```");
  });

  test("hover on a handler resume binder shows the resume type", async () => {
    await s.change("effect Get(): i64;\nn :: handle { Get!(); } case Get() => k { k(42) };\n");
    const h = await s.hover(1, 38); // the resume binder `k` after `=>`
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nk : (i64) -> a\n```");
  });

  test("hover on a resume binder shows the resolved result type", async () => {
    await s.change("effect Get(): i64;\nm :: handle { Get!(); } case Get() => k { k(42); unit } case Return(v) => k { unit };\n");
    const h1 = await s.hover(1, 38); // Get's resume
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\nk : (i64) -> unit\n```");
    const h2 = await s.hover(1, 74); // Return's resume: (body type) -> result
    expect(h2!.contents.value).toBe("```ef\nk : (i64) -> unit\n```");
  });

  test("hover outside any expression returns nothing", async () => {
    await s.change("f :: fn(): i64 {1};\n");
    const h = await s.hover(0, 18); // over the trailing `;`
    expect(h).toBeNull();
  });

  test("semantic tokens: legend is a single constant shared with encoding (spec AC-007)", async () => {
    const r = await s.request("initialize", {processId: null, rootUri: null, capabilities: {}}) as {result: {capabilities: {semanticTokensProvider: {legend: {tokenTypes: string[], tokenModifiers: string[]}, full: boolean}}}};
    expect(r.result.capabilities.semanticTokensProvider.legend.tokenTypes).toEqual(["type", "typeParameter", "macro", "function", "variable"]);
    expect(r.result.capabilities.semanticTokensProvider.legend.tokenModifiers).toEqual([]);
    expect(r.result.capabilities.semanticTokensProvider.full).toBe(true);
  });

  // Decode LSP delta-encoded tokens back to absolute positions and the source
  // text they cover — asserts extent + kind without hand-counted columns.
  const decode = (src: string, data: number[]): {text: string, kind: number}[] => {
    const lines = src.split("\n");
    const out: {text: string, kind: number}[] = [];
    let line = 0, col = 0;
    for (let i = 0; i < data.length; i += 5) {
      line += data[i];
      col = data[i] === 0 ? col + data[i + 1] : data[i + 1];
      out.push({text: (lines[line] ?? "").slice(col, col + data[i + 2]), kind: data[i + 3]});
    }
    return out;
  };

  test("semantic tokens cover alias decls, uses, and prims (spec AC-002)", async () => {
    const src = "Pair :: [i32, i32]; p :: Pair;\n";
    await s.change(src);
    expect(decode(src, (await s.semanticTokens()).data)).toEqual([
      {text: "Pair", kind: 0}, // type
      {text: "i32", kind: 0},
      {text: "i32", kind: 0},
      {text: "p", kind: 0},
      {text: "Pair", kind: 0},
    ]);
  });

  test("semantic tokens cover effect decls, rows, performs, and case labels (spec AC-004)", async () => {
    const src = "effect Read(): i32;\nf :: fn(): i32 ! { Read } { Read!() };\nh :: fn(): i32 ! { Read } { handle { Read!() } case Read(x) => k { x } };\n";
    await s.change(src);
    expect(decode(src, (await s.semanticTokens()).data)).toEqual([
      {text: "Read", kind: 2}, // macro
      {text: "i32", kind: 0},
      {text: "f", kind: 3}, // function binder
      {text: "i32", kind: 0},
      {text: "Read", kind: 2},
      {text: "Read", kind: 2},
      {text: "h", kind: 3}, // function binder
      {text: "i32", kind: 0},
      {text: "Read", kind: 2},
      {text: "Read", kind: 2},
      {text: "Read", kind: 2}, // case label
      {text: "x", kind: 4}, // case-param binder
      {text: "x", kind: 4}, // resumed value
    ]);
  });

  test("semantic tokens cover value identifiers by inferred type (spec AC-008)", async () => {
    const src = "collect :: fn(x: i64): [[i64]] { [[x]] };\ncollect(1);\n";
    await s.change(src);
    expect(decode(src, (await s.semanticTokens()).data)).toEqual([
      {text: "collect", kind: 3}, // function
      {text: "x", kind: 4}, // variable (binder)
      {text: "i64", kind: 0},
      {text: "i64", kind: 0},
      {text: "x", kind: 4}, // use
      {text: "collect", kind: 3}, // use
    ]);
  });

  test("document that fails the check yields empty tokens (spec AC-005)", async () => {
    await s.change("x :: Foo;\n");
    expect((await s.semanticTokens()).data).toEqual([]);
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
