// Stand-in for bun's `sleepSync` when the compiler's import graph is bundled
// for plain node (the extension's dist/server.cjs). builtins.ts imports it for
// the `Wait` effect's busy-wait host; the language server only parses and
// typechecks — it never evaluates — so this stub must never run.
export function sleepSync(_secs: number): never {
  throw new Error("sleepSync unavailable: the ef language server does not evaluate programs");
}
