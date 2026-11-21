import {Loc} from "../lexer.ts";
import {ExprID, Program} from "../parser.ts";
import {Checked} from "../types.ts";
import {showT} from "../type_display.ts";
import {Type} from "../unify.ts";
import {uniContainsAny, uniDeepResAny} from "../unify.ts";

type Issue = {who: string, ty: string, pos?: Loc};

// derived-any: an unannotated binding whose inferred type contains `any` —
// the absorbing escape type propagating silently (from an `any`-typed param,
// an `[any]` element, a call through an `any`-typed function). An explicit
// annotation on the binding (or the `_` discard) silences it; a lambda-valued
// `::` binding is skipped too — its signature spells out the full type, so no
// any there is derived.
export default function*(prog: Program, checked: Checked | undefined): Generator<Issue> {
  if (checked === undefined)
    return;

  // The inferred type of `id` when it contains `any`, displayed via
  // deepResAny (any-absorbed unbound vars render as any — a call through an
  // any-typed function leaves its result var unbound; see Unifier.anyVars).
  const anyTypeOf = (id: ExprID): Type | null => {
    const t = checked.nodeTypes[id];
    return t !== undefined && uniContainsAny(checked.uni, t) ? uniDeepResAny(checked.uni, t) : null;
  };
  for (let id = 0; id < prog.nodes.length; id++) {
    const e = prog.nodes[id];
    if (e.t === "let") {
      if (e.typ !== null || e.name === "_" || prog.nodes[e.val].t === "lambda")
        continue;
      const ty = anyTypeOf(e.val);
      if (ty !== null)
        yield {
          who: `\`${e.name}\``, ty: showT(ty),
          pos: prog.locs[id]?.start,
        };
    } else if (e.t === "dlet") {
      const vt = anyTypeOf(e.val);
      if (vt === null)
        continue;
      for (const [i, f] of e.fields.entries()) {
        if (f.typ !== null || f.name === "_") continue;
        const ft = (vt.tag === "tup" ? vt.fields[i]?.type
          : vt.tag === "arr" ? vt.elem
          : null) ?? null;
        if (ft !== null && uniContainsAny(checked.uni, ft))
          yield {
            who: `field \`${f.name}\``, ty: showT(uniDeepResAny(checked.uni, ft)),
            pos: f.pos,
          };
      }
    }
  }
}
