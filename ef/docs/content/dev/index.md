# Compiler pipeline

Everything the compiler does to a program passes through the same **frontend**:
lex → parse → check → analyze. Then a program takes one of two roads: the
**interpreter** evaluates it directly (CPS, effects first-class), or the
**wasm backend** compiles it to a WasmGC module with the same observable
behaviour.

<svg class="dgm" viewBox="0 0 780 404" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ef compiler pipeline">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arrowhead" d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>

  <!-- frontend row (accent border = resource: data, not a process) -->
  <rect class="box acc" x="8"   y="34" width="104" height="44" rx="8"/>
  <text x="60"  y="53" text-anchor="middle">.ef source</text>
  <text x="60"  y="67" text-anchor="middle" class="faint">text</text>
  <rect class="box" x="152" y="34" width="100" height="44" rx="8"/>
  <text x="202" y="53" text-anchor="middle">lex</text>
  <text x="202" y="67" text-anchor="middle" class="faint">tokens</text>
  <rect class="box" x="292" y="34" width="100" height="44" rx="8"/>
  <text x="342" y="53" text-anchor="middle">parse</text>
  <text x="342" y="67" text-anchor="middle" class="faint">AST · items</text>
  <rect class="box" x="432" y="34" width="132" height="44" rx="8"/>
  <text x="498" y="53" text-anchor="middle">check</text>
  <text x="498" y="67" text-anchor="middle" class="faint">HM · effects</text>
  <rect class="box" x="604" y="34" width="120" height="44" rx="8"/>
  <text x="664" y="53" text-anchor="middle">analyze</text>
  <text x="664" y="67" text-anchor="middle" class="faint">surface · refs</text>
  <path class="arrow" marker-end="url(#arr)" d="M112 56 H148"/>
  <path class="arrow" marker-end="url(#arr)" d="M252 56 H288"/>
  <path class="arrow" marker-end="url(#arr)" d="M392 56 H428"/>
  <path class="arrow" marker-end="url(#arr)" d="M564 56 H600"/>

  <!-- Checked — resource: the checker's output artifact (types info) -->
  <rect class="box acc" x="432" y="104" width="132" height="40" rx="8"/>
  <text x="498" y="121" text-anchor="middle">Checked</text>
  <text x="498" y="135" text-anchor="middle" class="faint">env·types·rows</text>
  <path class="arrow" marker-end="url(#arr)" d="M498 78 V100"/>

  <!-- interpreter lane -->
  <rect class="panel" x="20" y="160" width="740" height="86" rx="10"/>
  <text x="748" y="178" text-anchor="end" class="faint">interpreter</text>
  <rect class="box" x="48" y="192" width="128" height="40" rx="8"/>
  <text x="112" y="209" text-anchor="middle">newCtx / exec</text>
  <text x="112" y="223" text-anchor="middle" class="faint">fail-fast·seed</text>
  <rect class="box" x="224" y="192" width="120" height="40" rx="8"/>
  <text x="284" y="209" text-anchor="middle">evalE</text>
  <text x="284" y="223" text-anchor="middle" class="faint">CPS evaluator</text>
  <rect class="box" x="392" y="192" width="150" height="40" rx="8"/>
  <text x="467" y="209" text-anchor="middle">runTop</text>
  <text x="467" y="223" text-anchor="middle" class="faint">residual effects</text>
  <path class="arrow" marker-end="url(#arr)" d="M176 212 H220"/>
  <path class="arrow" marker-end="url(#arr)" d="M344 212 H388"/>
  <text x="640" y="217" class="faint">multi-shot</text>
  <text x="640" y="231" class="faint">resume</text>

  <!-- wasm lane -->
  <rect class="panel" x="20" y="268" width="740" height="120" rx="10"/>
  <text x="748" y="286" text-anchor="end" class="faint">wasm backend</text>
  <rect class="box" x="48"  y="296" width="104" height="36" rx="8"/>
  <text x="100" y="311" text-anchor="middle">discover</text>
  <text x="100" y="324" text-anchor="middle" class="faint">scopes·ops</text>
  <rect class="box" x="178" y="296" width="104" height="36" rx="8"/>
  <text x="230" y="311" text-anchor="middle">optimize</text>
  <text x="230" y="324" text-anchor="middle" class="faint">tree-shake</text>
  <rect class="box" x="308" y="296" width="104" height="36" rx="8"/>
  <text x="360" y="311" text-anchor="middle">assign</text>
  <text x="360" y="324" text-anchor="middle" class="faint">funcref idx</text>
  <rect class="box" x="438" y="296" width="104" height="36" rx="8"/>
  <text x="490" y="311" text-anchor="middle">layout</text>
  <text x="490" y="324" text-anchor="middle" class="faint">statics</text>
  <rect class="box" x="568" y="296" width="104" height="36" rx="8"/>
  <text x="620" y="311" text-anchor="middle">emit</text>
  <text x="620" y="324" text-anchor="middle" class="faint">expr→wasm</text>
  <path class="arrow" marker-end="url(#arr)" d="M152 314 H174"/>
  <path class="arrow" marker-end="url(#arr)" d="M282 314 H304"/>
  <path class="arrow" marker-end="url(#arr)" d="M412 314 H434"/>
  <path class="arrow" marker-end="url(#arr)" d="M542 314 H564"/>
  <rect class="box" x="545" y="346" width="150" height="36" rx="8"/>
  <text x="620" y="361" text-anchor="middle">buildModule</text>
  <text x="620" y="374" text-anchor="middle" class="faint">+ binaryen shrink</text>
  <rect class="box acc" x="430" y="346" width="80" height="36" rx="8"/>
  <text x="470" y="368" text-anchor="middle">.wasm</text>
  <rect class="box" x="240" y="346" width="150" height="36" rx="8"/>
  <text x="315" y="361" text-anchor="middle">runWasm</text>
  <text x="315" y="374" text-anchor="middle" class="faint">host runtime</text>
  <path class="arrow" marker-end="url(#arr)" d="M620 332 V342"/>
  <path class="arrow" marker-end="url(#arr)" d="M541 364 H514"/>
  <path class="arrow" marker-end="url(#arr)" d="M426 364 H394"/>

  <!-- frontend artifacts bus: both lanes consume Program + Checked + analysis
       output (exec seeds builtinRefs; both pipelines run checkProgram once
       before the backend, and the
       OPT_PASSES tree-shake via builtinRefs/builtinValueUses).
       Declared last: SVG paints in document order, so the wires must come
       after the lane panels or the panels cover the lane-entry arrowheads. -->
  <path class="arrow" marker-end="url(#arr)" d="M664 156 H112 V188"/>
  <path class="arrow" d="M664 78 V156"/>
  <path class="arrow" d="M498 144 V156"/>
  <path class="arrow" marker-end="url(#arr)" d="M190 156 V252 H100 V292"/>
  <text x="140" y="150" class="faint">Program · Checked · builtinRefs — both backends</text>
</svg>

## Frontend (shared)

| # | Phase | Page | Produces |
|---|-------|------|----------|
| 1 | Lex | [Lexer](lexer.md) | `Tok[]` — flat token stream with 1-indexed positions |
| 2 | Parse | [Parser](parser.md) | `Program` — items + a flat `Expr[]` node slice |
| 3 | Check | [Type checker](types.md) | `Checked` — resolved types, effect rows, node stamps |
| 4 | Analyze | [Analysis](analysis.md) | builtin surface tables, op discovery, builtin refs |

The frontend is strictly layered: each phase consumes the previous phase's
output and nothing else. The analysis layer depends only on parser types, so
both backends consume it without pulling in the evaluator.

## Backend: the interpreter

[Interpreter (CPS) →](eval.md)

`newCtx(interp?)` seeds state; the caller checks the program
(`checkProgram(prog, ctx.checked)`), then `exec(prog, ctx, checked)` fails
fast on statically-unhandled non-builtin ops (frontend/pipeline.ts's `rejectUnhandled`
— the same gate the wasm pipeline applies before codegen), seeds the
referenced builtins into the runtime env, then evaluates under the CPS
evaluator (`evalE`/`apply`). Multi-shot `resume` is a plain JS closure. Effects with no
matching handler reach `runTop`, which interprets them through the builtin
table (or an injected override — tests inject fake fs/time/randomness there).

## Backend: WebAssembly

[Wasm backend →](wasm/index.md)

`compileWithOps` runs the same frontend, then a five-phase pipeline
(discover → optimize → assignIndices → layoutStatics → emit) over plain
artifact records, assembles the module (`buildModule`, including an in-process
binaryen shrink pass), and hands the bytes to the host runtime, which
instantiates the module and rebuilds JS values across the WasmGC boundary.
CPS is compiled explicitly: frames, continuation cells, and
resume-as-value. Each phase has its own page under [Wasm backend](wasm/index.md)
in the sidebar.

## The REPL protocol

The REPL and `ef run` share one pipeline; the REPL just calls it per line with
an accumulating context — bindings (both value and type environments) persist
across lines.

<svg class="dgm" viewBox="0 0 720 140" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="REPL loop">
  <defs>
    <marker id="arr2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arrowhead" d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>
  <rect class="box" x="16"  y="30" width="110" height="44" rx="8"/>
  <text x="71"  y="49" text-anchor="middle">REPL line</text>
  <text x="71"  y="63" text-anchor="middle" class="faint">line loop</text>
  <rect class="box" x="166" y="30" width="110" height="44" rx="8"/>
  <text x="221" y="49" text-anchor="middle">parse</text>
  <text x="221" y="63" text-anchor="middle" class="faint">own node slice</text>
  <rect class="box" x="316" y="30" width="150" height="44" rx="8"/>
  <text x="391" y="49" text-anchor="middle">checkProgram</text>
  <text x="391" y="63" text-anchor="middle" class="faint">acc: shared Unifier</text>
  <rect class="box" x="506" y="30" width="190" height="44" rx="8"/>
  <text x="601" y="49" text-anchor="middle">exec</text>
  <text x="601" y="63" text-anchor="middle" class="faint">seed · evalE · print</text>
  <path class="arrow" marker-end="url(#arr2)" d="M126 52 H162"/>
  <path class="arrow" marker-end="url(#arr2)" d="M276 52 H312"/>
  <path class="arrow" marker-end="url(#arr2)" d="M466 52 H502"/>
  <path class="arrow" marker-end="url(#arr2)" d="M601 74 V112 H71 V78"/>
  <text x="336" y="127" class="faint">acc grows — bindings persist across lines</text>
</svg>

Details per phase: [Parser](parser.md) (closures carry their own node slice, so
REPL lines never alias), [Type checker](types.md) (one `Unifier` carried inside
`Checked`), [Interpreter](eval.md) (`newCtx`/`exec` semantics).

## Usage

Commands, REPL behaviour, and the wasm target: [CLI & REPL](../spec/cli.md).
Lint rules: [Linter](../spec/lint.md).
