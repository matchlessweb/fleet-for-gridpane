// One shape for a structure capture, so two captures can be compared: the one a
// working database gave, and the one the baseline migration builds. It drops
// what differs for reasons that are not structure (the server's version, the
// platform's own functions and extensions) and sorts everything by name.

/** Functions a Supabase project adds by itself. They are not the app's, so the baseline does not write them. */
export const PLATFORM_FUNCTIONS = new Set(["rls_auto_enable"]);

const by = (key) => (a, b) => String(a[key]).localeCompare(String(b[key]));
const acl = (text) => text == null ? null
  : text.replace(/^\{|\}$/g, "").split(",").map((e) => e.split("=")[0].replace(/^"|"$/g, "") || "PUBLIC").filter((r) => r !== "postgres").sort();

export function normalize(d) {
  return {
    tables: d.tables.map((t) => ({
      name: t.name,
      rls: t.rls,
      rls_forced: t.rls_forced,
      comment: t.comment ?? null,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, not_null: c.not_null, default: c.default ?? null, identity: c.identity || "", generated: c.generated || "", comment: c.comment ?? null })),
      // Postgres 18 lists every NOT NULL as a constraint of its own; earlier versions do not. The column's own flag covers it.
      constraints: t.constraints.filter((k) => k.type !== "n").map((k) => ({ name: k.name, type: k.type, def: k.def })).sort(by("name")),
      indexes: t.indexes.map((i) => ({ name: i.name, def: i.def })).sort(by("name")),
      triggers: t.triggers.map((x) => ({ name: x.name, def: x.def })).sort(by("name")),
      policies: t.policies.map((p) => ({ name: p.name, cmd: p.cmd, permissive: p.permissive, roles: [...p.roles].sort(), using: p.using ?? null, check: p.check ?? null })).sort(by("name")),
      grants: t.grants.map((g) => `${g.role}:${g.privilege}`).sort(),
    })).sort(by("name")),
    functions: d.functions.filter((f) => !PLATFORM_FUNCTIONS.has(f.name))
      .map((f) => ({ name: f.name, args: f.args, security_definer: f.security_definer, may_run: acl(f.acl), def: f.def.trimEnd() })).sort((a, b) => (a.name + a.args).localeCompare(b.name + b.args)),
    views: (d.views || []).map((v) => ({ name: v.name, kind: v.kind, def: v.def })).sort(by("name")),
    enums: (d.enums || []).map((e) => ({ name: e.name, labels: e.labels })).sort(by("name")),
    sequences: (d.sequences || []).map((s) => ({ name: s.name, type: s.type, increment: Number(s.increment) })).sort(by("name")),
    outside_triggers: (d.outside_triggers || []).map((x) => ({ table: x.table, name: x.name, def: x.def })).sort(by("name")),
    publications: (d.publications || []).map((p) => `${p.publication}:${p.table}`).sort(),
    cron_jobs: (d.cron_jobs || []).map((j) => ({ name: j.name, schedule: j.schedule, command: j.command.trim(), active: j.active })).sort(by("name")),
  };
}

/** Every place two normalized captures differ, as short lines a person can read. */
export function differences(want, got, path = "") {
  if (JSON.stringify(want) === JSON.stringify(got)) return [];
  if (Array.isArray(want) && Array.isArray(got)) {
    const named = [...want, ...got].every((x) => x && typeof x === "object" && "name" in x);
    if (named) {
      const key = (x) => x.name + (x.args ?? "");
      const w = new Map(want.map((x) => [key(x), x])), g = new Map(got.map((x) => [key(x), x]));
      const out = [];
      for (const k of w.keys()) if (!g.has(k)) out.push(`${path}/${k}: missing`);
      for (const k of g.keys()) if (!w.has(k)) out.push(`${path}/${k}: extra`);
      for (const [k, x] of w) if (g.has(k)) out.push(...differences(x, g.get(k), `${path}/${k}`));
      return out;
    }
  }
  if (want && got && typeof want === "object" && typeof got === "object" && !Array.isArray(want) && !Array.isArray(got)) {
    const out = [];
    for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) out.push(...differences(want[k], got[k], `${path}.${k}`));
    return out;
  }
  const show = (v) => { const s = JSON.stringify(v); return s && s.length > 110 ? s.slice(0, 107) + "…" : s; };
  return [`${path}: wanted ${show(want)}, got ${show(got)}`];
}
