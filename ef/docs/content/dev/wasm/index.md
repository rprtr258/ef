# Wasm backend

Same frontend as the interpreter — parse → typecheck → [analysis](../analysis.md)
— different codegen: the program's CPS structure is compiled **explicitly**
into WasmGC. There is no linear memory: every wasm operand value is an
`anyref`.

## Pipeline

`compileWithOps(src)` composes free functions over plain artifact records —
each phase returns a fresh record with its additions, and no phase mutates an
artifact it did not create:

| Phase | Reads | Produces | Job |
|-------|-------|----------|-----|
| [`discover`](discover.md) | `Program` (pre-checked by `compileWithOps`) | `Discovery` | intern effect ops into the op table (returned to the host so both agree on op numbering); handler-presence pre-scan; the scope/slot/literal/split-site walk over the whole program |
| [`optimize`](optimize.md) | `Program` | `Opt` | `OPT_PASSES`: `treeShakeBuiltins` (emit only referenced builtins) and `dropDeadHostImports` (live host-import set — funcref index assignment derives from it) |
| [`assignIndices`](indices.md) | `Discovery`, `Opt` | `Indices` | funcref table indices: helpers, lambdas, builtins, case fns, main; perform/handle spill slots |
| [`layoutStatics`](layout.md) | `Discovery`, `Indices`, `Opt` | `Layout` | static literal globals — nums, strings, bools, `PI`, per-handle case tables — each initialized by a GC constant expression at instantiation |
| [`emit`](emit.md) | all of the above | `Fn[]` | one local `Emit` context; `expr()` + the statement/effect emitters; order: helpers → lambdas → case fns → builtin trampolines → main (+ thunks) |
| [`buildModule`](module.md) | all of the above | bytes | assemble the module incl. `run` + accessor init fns; in-process binaryen shrink (level 2 — matches `-Oz` size at ~⅓ the cost) |

Each phase has its own page under this one in the sidebar.

## Value representation

<svg class="dgm" viewBox="0 0 720 96" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="WasmGC value plane">
  <rect class="box" x="16"  y="20" width="104" height="56" rx="8"/>
  <text x="68"  y="40" text-anchor="middle">unit</text>
  <text x="68"  y="58" text-anchor="middle" class="faint">ref.null</text>
  <rect class="box" x="136" y="20" width="104" height="56" rx="8"/>
  <text x="188" y="40" text-anchor="middle">bool</text>
  <text x="188" y="58" text-anchor="middle" class="faint">i31ref 0/1</text>
  <rect class="box" x="256" y="20" width="128" height="56" rx="8"/>
  <text x="320" y="40" text-anchor="middle">number</text>
  <text x="320" y="58" text-anchor="middle" class="faint">$NUM{f64} ×6 widths</text>
  <rect class="box" x="400" y="20" width="128" height="56" rx="8"/>
  <text x="464" y="40" text-anchor="middle">string</text>
  <text x="464" y="58" text-anchor="middle" class="faint">$STR mut i16[] UTF-16</text>
  <rect class="box" x="544" y="20" width="164" height="56" rx="8"/>
  <text x="626" y="40" text-anchor="middle">array / list · tuple</text>
  <text x="626" y="58" text-anchor="middle" class="faint">$ARR slice {data, off, len} · $TUP</text>
</svg>

| ef value | WasmGC representation |
|----------|------------------------|
| unit | `ref.null any` |
| bool | i31ref `0`/`1` |
| number | `$NUM {f64}` immutable struct — one box shape per width (`$F64 $F32 $I32 $U32 $I64 $U64`) |
| string | `$STR` — mutable i16 array, UTF-16 code units (matches JS `strlen`/`char`/`Out`) |
| array / list | `$ARR` slice fat pointer `{(ref null $ELEMS) data, i32 off, i32 len}` — immutable; **views (`sub`) share the backing with a shifted window**, only backing elements mutate |
| tuple | `$TUP {(ref null $ELEMS)}` — immutable, struct-like: no offset/length, distinct from slices |
| closure | `$CLO {i31 fnIdx, (ref null $FRAME) env, i31 fsize}` — immutable |

## Frames, variables, calls

Every call frame is a `$FRAME {mut parent, mut slots}` with slot array length
`max(fsize, argc)`. Closures capture their defining frame, so escaping and
mutable capture work exactly like the interpreter's env chain; variables
resolve statically to `(frame depth, slot)` — a read is `struct.get $FRAME 1`
+ `array.get`.

All ef functions share one uniform signature
`T_KABI = (($FRAME), ($K)) -> anyref` and dispatch through a single funcref
table via `call_indirect`. Builtins are trampolines; `map`/`each`/`flatmap`
are compiled CPS loops that call callbacks the same way. Tail positions keep
`return_call`/`return_call_indirect` (O(1) wasm stack).

## Continuations and effects

Continuations are `$K` cells `{mut kind, mut a, mut b, mut next}`:

<svg class="dgm" viewBox="0 0 720 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="continuation cell chain">
  <defs>
    <marker id="arrw" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="arrowhead" d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>
  <rect class="box acc" x="16"  y="24" width="190" height="70" rx="8"/>
  <text x="111" y="44" text-anchor="middle" class="acc">K_HDL</text>
  <text x="111" y="62" text-anchor="middle" class="faint">a: case table (opids)</text>
  <text x="111" y="78" text-anchor="middle" class="faint">b: hframe</text>
  <rect class="box" x="266" y="24" width="170" height="70" rx="8"/>
  <text x="351" y="44" text-anchor="middle">K_RET</text>
  <text x="351" y="62" text-anchor="middle" class="faint">a: thunk funcref idx</text>
  <text x="351" y="78" text-anchor="middle" class="faint">b: frame</text>
  <rect class="box" x="496" y="24" width="120" height="70" rx="8"/>
  <text x="556" y="44" text-anchor="middle">K_RET …</text>
  <text x="556" y="66" text-anchor="middle" class="faint">→ next</text>
  <text x="640" y="66" class="faint">ref.null = final return</text>
  <path class="arrow" marker-end="url(#arrw)" d="M206 59 H262"/>
  <path class="arrow" marker-end="url(#arrw)" d="M436 59 H492"/>
</svg>

| Kind | `a` | `b` |
|------|-----|-----|
| `K_RET` | i31 thunk funcref index | frame |
| `K_HDL` | `$ELEMS` case table of flat `[opid, fnIdx, fsize, nparams]` quadruples (`Return` = opid −1) | hframe shared by the case fns |
| `K_SPILL` | frozen `$FRAME` snapshot | unused |

The mechanics of a perform:

1. Box the args into an `$ELEMS` array, spill the args cell to a frame slot.
2. Walk the continuation chain for a `K_HDL` whose case table contains the op.
3. On a match, dispatch to the per-case `T_KABI` function over the handler's
   shared hframe. On no match, the effect reaches the **host** through
   `ef_perform` and is interpreted there (op table from `compileWithOps` →
   `builtinEffectHosts`), and the rest-of-site fragment continues with the
   resumed value.
4. **Resume as a value:** the `resume` binder is a `$CLO` closure over the
   shared resume fn plus a per-perform-site capture record. Every call copies
   the captured slice afresh, re-chains the copy's bottom to a *fresh* HDL
   whose `next` is the `k` the closure was invoked with, and dispatches the
   resumed value through that chain — that is multi-shot resume, GC-style.

Every perform/handle site ends the inline body and reifies the code after it
as a rest-of-site fragment — the compile-time **split protocol**.

**Subset restriction:** no perform/handle site inside an `if` branch or
`while` body — suspension across those control-flow blocks is rejected at
compile time.

## Deviations vs the interpreter

Known and pinned by tests — degenerate programs only:

| Deviation | Note |
|-----------|------|
| Arithmetic on non-numbers traps (`ref.cast` failure) instead of producing a garbage number | the checker rejects non-numeric arithmetic statically, so well-typed programs never hit it |
| Closures always display as `[fn]` | interpreter may show an inferred type |
| Stack overflow is a wasm `RuntimeError`, not a JS `RangeError` | |
| Heap reclamation is the host GC's job | recursion depth no longer costs O(N) unreclaimed bytes |

Next: [Discover](discover.md).
