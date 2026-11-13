// project.ts — the Project type and the default welcome project (leaf
// module: pure data, nothing else may sit below it).

export type File = {
  name: string,
  code: string,
};

export type Project = {
  name: string,
  files: File[],
};

export const DEFAULT_PROJECT: Project = {
  name: "welcome",
  files: [
    {
      name: "effects.ef",
      code: `# Algebraic effects in ef: declare with \`effect\`, perform with Op!(...),
# interpret with handle ... case Op(...) => k { ... }.
effect Choose(lo: i64, hi: i64): i64;
effect Emit(t: [i64]): unit;

# Nondeterministic search: the Choose handler resumes the continuation once
# per option, so pyth branches into every path (examples/amb.ef has the tour).
pyth :: fn(n: i64): unit ! { Choose, Emit } {
  a :: Choose!(1, n);
  b :: Choose!(a + 1, n);
  c :: Choose!(b + 1, n);
  if (a * a + b * b == c * c) {
    Emit!([a, b, c])
  } else {
    unit
  }
};

# Interprets nondeterminism only; emitted solutions propagate outward.
solutions :: fn(n: i64): unit ! { Emit } {
  handle {
    pyth(n)
  } case Choose(lo, hi) => k {
    each(fn(x, _) { k(x) }, range(lo, hi + 1, 1))
  }
};

# Gathers every value emitted across all branches.
triples :: fn(n: i64): [[i64]] {
  handle {
    solutions(n)
  } case Emit(t) => k {
    concat([t], k(unit))
  } case Return(v) => k {
    []
  }
};

# Run it: Choose! branches, Emit! collects — the handlers live in
# solutions/triples above.
each(fn(t: [i64], _) { Println!(t) }, triples(14));`,
    },
    {
      name: "state.ef",
      code: `# Builtin effects interpreted by handlers instead of the host:
# Tick! performs, the handler owns the count in a cell and resumes with
# the next value. Resume k is multi-shot, so map over Tick! just works.
effect Tick(): i64;

counter :: fn(steps: i64): [i64] {
  cell :: [0];
  set(cell, 0, 0);
  handle {
    map(fn(_) { Tick!() }, range(0, steps, 1))
  } case Tick() => r {
    set(cell, 0, get(cell, 0) + 1);
    r(get(cell, 0))
  }
};

# Random! interpreted deterministically: every draw resumes with 0.42.
deterministic :: fn(n: i64): [f64] {
  handle {
    map(fn(_) { Random!() }, range(0, n, 1))
  } case Random() => r {
    r(0.42)
  }
};

# Run it: Tick! is resumed with 1..5; every Random! draw resumes with 0.42.
Println!(counter(5));
Println!(deterministic(8));`,
    },
    {
      name: "main.ef",
      code: `# Each file in this project is its own runnable program: Run acts on the
# open file, and ef has no imports yet — files share nothing. effects.ef and
# state.ef are standalone demos of effects and state; this one keeps to
# builtins.
squares :: fn(n: i64): [i64] {
  map(fn(i: i64): i64 { i * i }, range(0, n, 1))
};
each(fn(s: i64, _) { Println!(s) }, squares(6));
Out!("welcome to ef\\n");`,
    },
  ],
};
