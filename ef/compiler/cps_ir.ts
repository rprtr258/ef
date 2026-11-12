// Higher-order CPS IR: the single intermediate representation both backends
// consume. Produced by cps.ts from a checked program (checker stamps on the
// AST nodes — numKind/div/idx/arrKind/asKind — are read during conversion and
// carried into the term).
//
// Term shape: every value flows through an explicit continuation. `letk`
// binds a continuation λv.body; tail positions name their continuation as a
// var reference (call/perform/jump k operands). `letk` bodies may jump their
// own name — that is how `while` becomes a recursive continuation. Effects:
// `perform` names the continuation reified for the handler (the converter
// wraps it in a letk when it is not already a named tail); `handle` names the
// two runtime-bound continuations ($ret: handled-body exit → done;
// $xit: handler-case exit → the handle's own continuation).
//
// Multi-shot discipline (pinned here, once): every operand computed before a
// possible suspension and needed after it is let-bound before the perform
// (ANF), so a resume never recomputes — the continuation parameters and
// in-scope let bindings are exactly the "frozen accs" both backends must
// honor. Named variables stay live in the (shared, mutable) frame: re-resuming
// after an assignment sees the new value.
//
// The transform is selective: a function whose resolved effect row is empty
// and whose body has no checker-stamped suspending call in its tail chain
// converts direct-style — its boundary delivers with `dret` instead of
// jumping `$ret`, and calls to classified-pure callees are `dcall`s that
// bind results in-frame. An empty row vouches that every perform in the
// body is lexically under a covering handler, so a function whose body is
// (or ends in) a `handle` — a mixed function — still converts direct: its
// islands run over the ambient chain like any CPS region, and the tail
// handle's k operand (the never-set `$ret`) is resolved to a terminal
// return-cell by the backends. The tail guard closes the row's blind spot:
// a resume binder's type performs nothing (contCall stamps an empty row)
// and an `any` callee's row is unread, so a tail call to either would flow
// the never-set `$ret` into a callee that can suspend. Direct regions
// contain no suspension points, so nothing in them is ever captured or
// frozen; the freeze discipline above applies only inside CPS regions.
// `dcall` itself never suspends (its operands and result need no freezing),
// but a dcall inside a CPS function can still sit after a suspension — its
// operand reads flow through the freeze machinery like any other value
// read.
//
// `$`-prefixed names are converter-generated and can never collide with
// source identifiers (the lexer only allows [A-Za-z0-9_]).

import type {FunT} from "./types.ts";
import type {Value} from "./env.ts";

// Operand: literal or variable read. `stamp` = the checker's numeric-width
// stamp (numKind): the interpreter normalizes the materialized/loaded value to
// that width's runtime representation (i32 |0, u32 >>>0, f32 fround,
// i64/u64 BigInt asIntN/asUintN) exactly like eval.ts's per-node evalE wrap.
// Literals keep `raw` (the source lexeme): i64/u64 literals evaluate from it
// because a JS number loses bits beyond 2^53.
export type CAtom =
  | {t: "lit", v: Value, raw?: string, stamp?: string}
  | {t: "var", name: string, stamp?: string};

// Pure computations (no suspension inside): width-stamped operator, array/
// tuple literal, @as conversion, field access. Operator prims carry two
// width marks: `stamp` decides the computation representation (widthOp's
// operand coercion; for `/`/`%` this is the node's numKind or its div stamp,
// else "f64"), `norm` re-normalizes the result to the app node's own stamp
// (eval.ts's evalE wrap — identity except i64/u64 wrap and f32 round).
export type CPrim =
  | {t: "op", op: string, args: CAtom[], stamp: string, norm?: string}
  | {t: "arr", args: CAtom[], kind: "arr" | "tup"}
  | {t: "as", arg: CAtom, asKind?: "trunc" | "boolnum", stamp?: string}
  | {t: "field", obj: CAtom, idx: number, name: string};

// One handler case: op "Return" is the distinguished body-completion case.
// `resume` names a native the runtime binds when the case runs (the captured
// continuation wrapped to re-enter this handler); it is an ordinary callable
// value in the term (reached via call).
export type CCase = {op: string, params: string[], resume: string, body: CTerm};

export type CTerm =
  // Bind continuation λparam.body to name; body may jump `name` (loops rely
  // on this self-reference). `norm` normalizes the incoming value (a call or
  // perform site's numKind) before the body sees it. `freeze` lists the
  // converter-generated value temps the body reads that were bound before a
  // possible suspension: their current values are captured when the letk
  // executes and restored into the frame on every continuation entry, so a
  // resume never sees a later activation's re-binding of the same temp
  // (multi-shot frozen accs; source named variables stay live by design).
  | {t: "letk", name: string, param: string, norm?: string, freeze?: {name: string, val: CAtom}[], body: CTerm, rest: CTerm}
  // Bind a primitive result (never suspends, may throw: ÷0, index OOB).
  | {t: "let", name: string, rhs: CPrim, rest: CTerm}
  // Bind an already-computed atom to a name (source `let`, block temps).
  | {t: "bind", name: string, val: CAtom, rest: CTerm}
  // Create a closure over funcs[fun]; capts = free value vars (wasm's
  // captured-frame-slot set; the closure interpreter just uses env chains).
  | {t: "mkfn", name: string, params: string[], capts: string[], fun: number, rest: CTerm}
  // Tail call; k names the callee's continuation (a letk/`$ret`/handle binding).
  | {t: "call", fn: CAtom, args: CAtom[], k: CAtom}
  // Direct call to a classified-pure callee: evaluates fn/args, binds the
  // result to `name` (normalized by `norm`, the site's numKind) and runs
  // rest in the same frame. Never suspends: the callee's boundary delivers
  // with `dret`, so no continuation operand exists and no wrapper letk is
  // built at the site.
  | {t: "dcall", fn: CAtom, args: CAtom[], name: string, norm?: string, rest: CTerm}
  // Raise op; k names the reified continuation handed to the handler's resume.
  | {t: "perform", op: string, args: CAtom[], k: CAtom}
  // Install handler. `ret` is bound by the runtime to the done-wrapper (the
  // handled body's exit), `exit` per run() to the handle's own continuation
  // (case completions deliver there; it differs between the first run and
  // resume re-entries). `k` names the handle's own continuation — resolved
  // as run()'s initial kOuter; like call/perform it is explicit because the
  // completion paths are runtime-driven, not lexically a jump in the term.
  | {t: "handle", ret: string, exit: string, k: CAtom, cases: CCase[], body: CTerm}
  // Branch; arm terms are in tail position (shared joins are letk-bound by
  // the converter, so arms end in jump/call referencing the join).
  | {t: "if", c: CAtom, a: CTerm, b: CTerm}
  // New frame (source block).
  | {t: "scope", rest: CTerm}
  // Destructure a tuple/array-window value into the current frame.
  | {t: "dlet", val: CAtom, fields: string[], rest: CTerm}
  | {t: "assign", name: string, val: CAtom, rest: CTerm}
  // Deliver arg to the named continuation (tail jump; resolves at runtime,
  // which is what makes recursive letk loops and multi-shot resume work).
  | {t: "jump", k: CAtom, arg: CAtom}
  // Direct-function boundary: deliver the return value to the ambient
  // continuation. A tail like jump/halt; direct bodies never reference `$ret`.
  | {t: "dret", v: CAtom}
  // Program boundary: deliver the program result to the top continuation.
  | {t: "halt", v: CAtom};

// funcs[fun]: one per source lambda. CPS functions' `$ret` is the function's
// continuation, bound by apply at entry (the body's tails jump/call it — a
// tail call passes its own k operand, which is how CPS keeps calls in tail
// position). Direct functions (`direct: true`) deliver with `dret` instead
// and never reference `$ret`.
export type CFn = {
  params: string[],
  capts: string[],
  body: CTerm,
  typ?: FunT,
  direct?: boolean,
};

export type CIr = {
  funcs: CFn[],
  term: CTerm,
};
