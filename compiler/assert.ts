// assertNever: exhaustive-switch guard. A `default: return assertNever(e)`
// in a switch over a discriminated union stops typechecking the moment a
// new union member appears without a matching case — the guarantee that
// adding an Expr variant forces every walker/emitter to handle it.
export function assertNever(x: never): never {
  throw new Error("internal: unhandled variant " + JSON.stringify(x));
}
