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
type Diag = {range: {start: {line: number, character: number}, end: {line: number, character: number}}, message: string, severity?: number, source?: string};
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

  async definition(line: number, character: number): Promise<{uri: string, range: {start: {line: number, character: number}, end: {line: number, character: number}}} | null> {
    const r = await this.request("textDocument/definition", {textDocument: {uri: URI}, position: {line, character}}) as {result: {uri: string, range: {start: {line: number, character: number}, end: {line: number, character: number}}} | null};
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
    const r = await s.request("initialize", {processId: null, rootUri: null, capabilities: {}}) as {result: {capabilities: {textDocumentSync: number, hoverProvider: boolean, definitionProvider: boolean}}};
    expect(r.result.capabilities.textDocumentSync).toBe(1); // Full
    expect(r.result.capabilities.hoverProvider).toBe(true);
    expect(r.result.capabilities.definitionProvider).toBe(true);
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

  test("unused-arg warning underlines the parameter name", async () => {
    const p = await s.change("f :: fn(x: i64, y: i64): i64 { x };\n");
    expect(p.diagnostics).toEqual([{
      severity: 2, // Warning
      range: {start: {line: 0, character: 16}, end: {line: 0, character: 17}},
      message: "function `f` has unused argument y",
      source: "ef",
    }]);
  });

  test("derived-any warning underlines the binding name", async () => {
    const p = await s.change("pull :: fn(x: any): any { x };\ny := pull(1);\n");
    expect(p.diagnostics).toEqual([{
      severity: 2, // Warning
      range: {start: {line: 1, character: 0}, end: {line: 1, character: 1}},
      message: "`y` is inferred as any (contains `any`); add an explicit annotation to silence",
      source: "ef",
    }]);
  });

  test("fixing the finding clears the warnings", async () => {
    const p = await s.change("f :: fn(x: i64, y: i64): i64 { x };\n");
    expect(p.diagnostics).toHaveLength(1);
    const q = await s.change("f :: fn(x: i64, y: i64): i64 { x + y };\n");
    expect(q.diagnostics).toEqual([]);
  });

  test("a type error suppresses the lint warnings", async () => {
    const p = await s.change("f :: fn(x: i64, y: i64): i64 { x };\nf(1) + \"a\";\n");
    expect(p.diagnostics).toHaveLength(1);
    expect(p.diagnostics[0].severity).toBe(1); // Error
  });

  test("hover on a top-level binding shows its type", async () => {
    await s.change("n :: 42;\n");
    const h = await s.hover(0, 0);
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nn : i64\n```");
  });

  test("hover on a builtin shows its type", async () => {
    await s.change("sub([1, 2, 3], 0, 2);\n");
    const h = await s.hover(0, 1);
    expect(h).not.toBeNull();
    expect(h!.contents.value.startsWith("```ef\nsub : ")).toBe(true);
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
    expect(h1!.contents.value).toBe("```ef\nid : (x: i64) -> i64\n```");
    const h2 = await s.hover(0, 6); // the lambda itself
    expect(h2!.contents.value).toBe("```ef\n(x: a) -> a\n```");
  });

  test("hover on an effect op shows its signature like a function", async () => {
    await s.change("Choose :: effect(): bool;\nn :: Choose!();\n");
    const h1 = await s.hover(1, 5); // over `Choose` in the perform
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\nChoose : () -> bool\n```");
    const h2 = await s.hover(1, 11); // over `!`
    expect(h2!.contents.value).toBe("```ef\nChoose : () -> bool\n```");
  });

  test("hover on an effect op with params shows them resolved", async () => {
    await s.change("Get :: effect(v: i64): i64;\nm :: Get!(42);\n");
    const h = await s.hover(1, 5); // over `Get`
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nGet : (v: i64) -> i64\n```");
  });

  test("hover on a builtin effect op shows its signature", async () => {
    await s.change("n :: Read!(\"x.txt\");\n");
    const h = await s.hover(0, 5); // over `Read`
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nRead : (path: string) -> string\n```");
  });

  test("hover on a fn shows its param names", async () => {
    await s.change("f :: fn(x: i64, y: i64): i64 { x + y };\n");
    const h1 = await s.hover(0, 0); // the binder name
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\nf : (x: i64, y: i64) -> i64\n```");
    const h2 = await s.hover(0, 6); // the lambda itself, over `fn`
    expect(h2!.contents.value).toBe("```ef\n(x: i64, y: i64) -> i64\n```");
  });

  test("hover on a builtin fn shows its param names", async () => {
    await s.change("xs :: [1, 2, 3];\nn :: get(xs, 0);\n");
    const h = await s.hover(1, 5); // over `get`
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nget : (xs: [i64], i: i64) -> i64\n```");
  });

  test("hover on an alias name shows its definition", async () => {
    await s.change("Point :: [x: i64, y: i64];\np: Point : [1, 2];\n");
    const h1 = await s.hover(0, 0); // the decl name
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\nPoint = [x: i64, y: i64]\n```");
    const h2 = await s.hover(1, 3); // a type use
    expect(h2!.contents.value).toBe("```ef\nPoint = [x: i64, y: i64]\n```");
  });

  test("hover on a parametric alias shows its tparams", async () => {
    await s.change("Pair :: fn(a: type, b: type): type { [fst: a, snd: b] };\nq: Pair(i64, string) : [1, \"s\"];\n");
    const h1 = await s.hover(0, 0); // the decl name
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\nPair(a, b) = [fst: a, snd: b]\n```");
    const h2 = await s.hover(1, 3); // a type use
    expect(h2!.contents.value).toBe("```ef\nPair(a, b) = [fst: a, snd: b]\n```");
  });

  test("hover on a handler case label shows the op's signature", async () => {
    await s.change("Get :: effect(): i64;\nn :: handle { Get!(); } case Get() => k { k(42) };\n");
    const h = await s.hover(1, 29); // over `Get` in the case label
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nGet : () -> i64\n```");
  });

  test("hover on an effect decl or row name shows the op's signature", async () => {
    await s.change("Get :: effect(): i64;\nf :: fn(): i64 ! { Get } { Get!() };\n");
    const h1 = await s.hover(0, 0); // the decl name
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\nGet : () -> i64\n```");
    const h2 = await s.hover(1, 19); // the `! { … }` row name
    expect(h2!.contents.value).toBe("```ef\nGet : () -> i64\n```");
  });

  test("hover on a handler resume binder shows the resume type", async () => {
    await s.change("Get :: effect(): i64;\nn :: handle { Get!(); } case Get() => k { k(42) };\n");
    const h = await s.hover(1, 38); // the resume binder `k` after `=>`
    expect(h).not.toBeNull();
    expect(h!.contents.value).toBe("```ef\nk : (i64) -> a\n```");
  });

  test("hover on a resume binder shows the resolved result type", async () => {
    await s.change("Get :: effect(): i64;\nm :: handle { Get!() } case Get() => k { k(42); unit } case Return(v) => k { unit };\n");
    const h1 = await s.hover(1, 37); // Get's resume
    expect(h1).not.toBeNull();
    expect(h1!.contents.value).toBe("```ef\nk : (i64) -> unit\n```");
    const h2 = await s.hover(1, 73); // Return's resume: (body type) -> result
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
    const src = "Read :: effect(): i32;\nf :: fn(): i32 ! { Read } { Read!() };\nh :: fn(): i32 ! { Read } { handle { Read!() } case Read(x) => k { x } };\n";
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

  test("definition on a sym use jumps to its binding", async () => {
    await s.change("n :: 42;\nm :: n + n;\n");
    expect(await s.definition(1, 5)).toEqual({uri: URI, range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}}});
  });

  test("definition on a lambda param use jumps to the param", async () => {
    await s.change("f :: fn(x: i64): i64 { x };\n");
    expect(await s.definition(0, 23)).toEqual({uri: URI, range: {start: {line: 0, character: 8}, end: {line: 0, character: 9}}});
  });

  test("definition on an effect row and perform jumps to the decl", async () => {
    await s.change("Get :: effect(): i64;\nf :: fn(): i64 ! { Get } { Get!() };\n");
    const want = {uri: URI, range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}}};
    expect(await s.definition(1, 19)).toEqual(want); // the `! { … }` row name
    expect(await s.definition(1, 27)).toEqual(want); // the perform
  });

  test("definition works from an effect use above its hoisted decl", async () => {
    await s.change("f :: fn(): i64 ! { Get } { Get!() };\nGet :: effect(): i64;\n");
    expect(await s.definition(0, 19)).toEqual({uri: URI, range: {start: {line: 1, character: 0}, end: {line: 1, character: 3}}});
  });

  test("definition on handler case param and resume binder is self-targeted", async () => {
    await s.change("Get :: effect(): i64;\nn :: handle { Get!(); } case Get(x) => k { x };\n");
    const want = {uri: URI, range: {start: {line: 1, character: 33}, end: {line: 1, character: 34}}};
    expect(await s.definition(1, 33)).toEqual(want); // the case param binder
    expect(await s.definition(1, 43)).toEqual(want); // the use in the body
  });

  test("definition on an assign target jumps to the binding", async () => {
    await s.change("n := 1;\nn = n + 1;\n");
    expect(await s.definition(1, 0)).toEqual({uri: URI, range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}}});
  });

  test("definition on a destructured field jumps to the field binder", async () => {
    await s.change("[a, b] := [1, 2];\nc :: a + b;\n");
    expect(await s.definition(1, 5)).toEqual({uri: URI, range: {start: {line: 0, character: 1}, end: {line: 0, character: 2}}});
  });

  test("definition on an alias use jumps to the alias decl", async () => {
    await s.change("Pair :: [i32, i32];\np: Pair = [1, 2];\n");
    expect(await s.definition(1, 3)).toEqual({uri: URI, range: {start: {line: 0, character: 0}, end: {line: 0, character: 4}}});
    expect(await s.definition(0, 1)).toEqual({uri: URI, range: {start: {line: 0, character: 0}, end: {line: 0, character: 4}}});
  });

  test("definition on a builtin value and a builtin effect returns nothing", async () => {
    await s.change("n :: Read!(\"x.txt\");\nm :: len;\n");
    expect(await s.definition(0, 5)).toBeNull();
    expect(await s.definition(1, 5)).toBeNull();
  });

  test("definition on a document that fails to parse returns nothing", async () => {
    await s.change("n :: ;\n");
    expect(await s.definition(0, 0)).toBeNull();
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
