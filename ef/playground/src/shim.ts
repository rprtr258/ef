// Browser shims for node-flavored globals that compiler modules touch at
// module-init time (builtins.ts reads process.env at the top level). The
// actual node-only paths (node:fs, `bun`'s sleepSync, process.stdout/exit)
// are stubbed at bundle time (see scripts/build.ts); the playground's
// EffectInterp preempts them for the streaming effects.
const g = globalThis as {process?: unknown};
if (g.process === undefined)
  g.process = {
    env: {},
    argv: ["ef", "playground"],
    stdout: {write: () => {}},
    exit: () => {
      throw new Error("Exit! reached the node shim — Exit! should be interpreted by the playground");
    },
  };
