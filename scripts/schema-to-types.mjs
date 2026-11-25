// Writes lib/database.types.ts from supabase/schema.snapshot.json, in the same
// shape `supabase gen types typescript` writes, so createClient<Database> keeps
// working. It needs no login, no network and no database: the snapshot is the
// structure as data (see scripts/schema-to-migration.mjs).
//
//   npm run schema:types                 # write lib/database.types.ts
//   npm run schema:types -- --check      # exit 1 if the committed file is not what this would write
//   node scripts/schema-to-types.mjs --snapshot <file> --out <file> [--check]
//
// Re-run it whenever the snapshot changes. The output is sorted and holds no
// date, so the same snapshot always gives the same bytes.
//
// What it does, and where it differs from Supabase's own generator:
//   - Column types: text, varchar, uuid, dates and times -> string; integer,
//     bigint, numeric, real, double -> number (as Supabase does); boolean;
//     json/jsonb -> Json; inet and any type it does not know -> unknown; arrays
//     -> T[]; an enum -> Database["public"]["Enums"][name].
//   - Insert: a column is optional when it is nullable, has a default or is an
//     identity column. A generated column is left out of Insert and Update.
//     Update: every column optional.
//   - Relationships: read from FOREIGN KEY constraints. isOneToOne is true when
//     the key's columns are exactly a primary key or unique constraint.
//   - Functions: Args from the argument list in the function's own definition
//     (so DEFAULT arguments are optional); OUT arguments are not arguments.
//     Returns: void -> undefined; trigger and event_trigger functions are left
//     out; SETOF <table> -> that table's Row[]; SETOF <scalar> -> scalar[];
//     TABLE(...) -> an array of objects. A SETOF or a bare row type this
//     script cannot resolve is typed unknown with a comment.
//     Overloads become a union of { Args, Returns } objects.
//   - Views: the snapshot holds a view's SQL, not its columns, so each view's
//     Row is Record<string, unknown> with a comment. The app has none today.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const POSTGREST_VERSION = "14.5";

const NUMBER = new Set(["smallint", "integer", "int", "int2", "int4", "int8", "bigint", "numeric", "decimal", "real", "float4", "float8", "double precision", "float", "oid", "serial", "bigserial"]);
const STRING = new Set(["text", "varchar", "character varying", "character", "char", "bpchar", "name", "citext", "uuid", "date", "time", "timetz", "time with time zone", "time without time zone", "timestamp", "timestamptz", "timestamp with time zone", "timestamp without time zone", "interval", "bytea", "money", "xml", "tsvector"]);

const bare = (name) => String(name).trim().replace(/^public\./, "").replace(/^"|"$/g, "").replace(/""/g, '"');
const key = (name) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Split on commas that are not inside brackets or quotes. */
function splitTop(text) {
  const parts = []; let depth = 0, quote = "", cur = "";
  for (const ch of text) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** The text between the first "(" at or after `from` and its matching ")". */
function balanced(text, from) {
  const start = text.indexOf("(", from);
  if (start < 0) return null;
  let depth = 0, quote = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) return { inner: text.slice(start + 1, i), end: i + 1 };
  }
  return null;
}

/** Map a Postgres type name to TypeScript. `enums` is the set of enum names. */
export function tsType(pgType, enums) {
  let t = String(pgType).trim().toLowerCase().replace(/\s+/g, " ");
  let arrays = 0;
  while (/\[\d*\]$/.test(t)) { t = t.replace(/\[\d*\]$/, ""); arrays++; }
  if (t.startsWith("_")) { t = t.slice(1); arrays++; }
  t = t.replace(/\(.*\)/, "").replace(/^public\./, "").replace(/^"|"$/g, "").trim();
  let base;
  if (t === "boolean" || t === "bool") base = "boolean";
  else if (NUMBER.has(t)) base = "number";
  else if (STRING.has(t)) base = "string";
  else if (t === "json" || t === "jsonb") base = "Json";
  else if (enums.has(t)) base = `Database["public"]["Enums"][${JSON.stringify(t)}]`;
  else base = "unknown"; // inet and every type not listed, as Supabase does for inet
  return base + "[]".repeat(arrays);
}

const unionOf = (t, nullable) => (nullable ? `${t} | null` : t);

function parseKey(def) {
  // FOREIGN KEY (a, b) REFERENCES public.tbl(x, y) ON DELETE ...
  const m = /FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]*)\)/i.exec(def);
  if (!m) return null;
  const list = (s) => s.split(",").map(bare).filter(Boolean);
  return { columns: list(m[1]), table: bare(m[2]), refColumns: list(m[3]) };
}

function uniqueSets(table) {
  const out = [];
  for (const k of table.constraints) {
    if (k.type !== "p" && k.type !== "u") continue;
    const m = /(?:PRIMARY KEY|UNIQUE)\s*\(([^)]*)\)/i.exec(k.def);
    if (m) out.push(m[1].split(",").map(bare).sort().join("\0"));
  }
  return out;
}

function tableBlock(table, enums) {
  const cols = [...table.columns].sort((a, b) => byName(a.name, b.name));
  const row = [], ins = [], upd = [];
  for (const c of cols) {
    const t = tsType(c.type, enums), nullable = !c.not_null;
    row.push(`${key(c.name)}: ${unionOf(t, nullable)}`);
    if (c.generated) continue; // the database computes it: not writable
    const optional = nullable || c.default != null || Boolean(c.identity);
    ins.push(`${key(c.name)}${optional ? "?" : ""}: ${unionOf(t, nullable)}`);
    upd.push(`${key(c.name)}?: ${unionOf(t, nullable)}`);
  }
  const uniques = uniqueSets(table);
  const rels = table.constraints.filter((k) => k.type === "f").map((k) => ({ name: k.name, fk: parseKey(k.def) })).filter((r) => r.fk)
    .sort((a, b) => byName(a.name, b.name));
  const o = [];
  const fields = (name, lines) => { o.push(`        ${name}: {`); for (const l of lines) o.push(`          ${l}`); o.push("        }"); };
  o.push(`      ${key(table.name)}: {`);
  fields("Row", row); fields("Insert", ins); fields("Update", upd);
  if (rels.length === 0) o.push("        Relationships: []");
  else {
    o.push("        Relationships: [");
    for (const { name, fk } of rels) {
      const one = uniques.includes([...fk.columns].sort().join("\0"));
      o.push("          {", `            foreignKeyName: ${JSON.stringify(name)}`, `            columns: ${JSON.stringify(fk.columns)}`,
        `            isOneToOne: ${one}`, `            referencedRelation: ${JSON.stringify(fk.table)}`, `            referencedColumns: ${JSON.stringify(fk.refColumns)}`, "          },");
    }
    o.push("        ]");
  }
  o.push("      }");
  return o;
}

/** Parse one function's arguments (from its definition, which carries the DEFAULTs) and its RETURNS clause. */
function parseFunction(f) {
  const def = f.def;
  const head = /FUNCTION\s+(?:public\.)?"?[\w$]+"?\s*/i.exec(def);
  const paren = head ? balanced(def, head.index + head[0].length - 1) : null;
  const argText = paren ? paren.inner : f.args || "";
  const args = [];
  for (const raw of splitTop(argText)) {
    let s = raw, hasDefault = false;
    const d = /\s+(?:DEFAULT|=)\s+/i.exec(s);
    if (d) { hasDefault = true; s = s.slice(0, d.index); }
    let mode = "IN";
    const m = /^(IN OUT|INOUT|IN|OUT|VARIADIC)\s+/i.exec(s);
    if (m) { mode = m[1].toUpperCase().replace(" ", ""); s = s.slice(m[0].length); }
    const sp = /^("[^"]+"|\S+)\s+(.+)$/.exec(s.trim());
    if (!sp) continue; // an unnamed argument cannot be passed by name through PostgREST
    args.push({ name: bare(sp[1]), type: sp[2], hasDefault, mode });
  }
  const after = paren ? def.slice(paren.end) : def;
  const r = /^\s*RETURNS\s+([\s\S]*?)(?=\n\s*(?:LANGUAGE|AS|IMMUTABLE|STABLE|VOLATILE|SECURITY|STRICT|PARALLEL|COST|ROWS|SET)\b|\s+LANGUAGE\b|$)/i.exec(after);
  return { name: f.name, args: args.filter((a) => a.mode !== "OUT"), returns: r ? r[1].trim() : null };
}

function returnsType(text, tables, enums) {
  if (text == null) return { ts: "unknown", note: "no RETURNS clause found" };
  const t = text.trim();
  if (/^void$/i.test(t)) return { ts: "undefined" };
  const tbl = /^TABLE\s*\(/i.exec(t);
  if (tbl) {
    const inner = balanced(t, 0).inner;
    const fields = splitTop(inner).map((p) => { const m = /^("[^"]+"|\S+)\s+(.+)$/.exec(p); return m ? `${key(bare(m[1]))}: ${tsType(m[2], enums)}` : null; });
    if (fields.some((x) => x == null)) return { ts: "unknown[]", note: "TABLE(...) could not be parsed" };
    return { ts: `{ ${fields.join("; ")} }[]` };
  }
  const setof = /^SETOF\s+(.+)$/i.exec(t);
  const one = (setof ? setof[1] : t).trim();
  const suffix = setof ? "[]" : "";
  const name = bare(one);
  if (tables.has(name)) return { ts: `Database["public"]["Tables"][${JSON.stringify(name)}]["Row"]${suffix}` };
  const scalar = tsType(one, enums);
  if (scalar !== "unknown") return { ts: scalar + suffix };
  if (/^record$/i.test(one)) return { ts: `unknown${suffix}`, note: "RETURNS record: the columns are not in the snapshot" };
  return { ts: `unknown${suffix}`, note: `RETURNS ${t}: type not mapped` };
}

function functionLines(funcs, tables, enums) {
  const byFn = new Map();
  for (const f of funcs) {
    const p = parseFunction(f);
    if (/^(trigger|event_trigger)$/i.test(p.returns || "")) continue;
    if (!byFn.has(p.name)) byFn.set(p.name, []);
    byFn.get(p.name).push(p);
  }
  const o = [];
  for (const name of [...byFn.keys()].sort(byName)) {
    const variants = byFn.get(name).map((p) => {
      const args = [...p.args].sort((a, b) => byName(a.name, b.name));
      const argLine = args.length === 0 ? "never" : `{ ${args.map((a) => `${key(a.name)}${a.hasDefault ? "?" : ""}: ${tsType(a.type, enums)}`).join("; ")} }`;
      return { argLine, args, ret: returnsType(p.returns, tables, enums) };
    }).sort((a, b) => byName(a.argLine, b.argLine));
    const render = (v, pad) => {
      const lines = [];
      if (v.ret.note) lines.push(`${pad}// ${v.ret.note}`);
      if (v.args.length === 0) lines.push(`${pad}Args: never`);
      else if (v.argLine.length <= 60) lines.push(`${pad}Args: ${v.argLine}`);
      else {
        lines.push(`${pad}Args: {`);
        for (const a of v.args) lines.push(`${pad}  ${key(a.name)}${a.hasDefault ? "?" : ""}: ${tsType(a.type, enums)}`);
        lines.push(`${pad}}`);
      }
      lines.push(`${pad}Returns: ${v.ret.ts}`);
      return lines;
    };
    if (variants.length === 1) { o.push(`      ${key(name)}: {`, ...render(variants[0], "        "), "      }"); continue; }
    o.push(`      ${key(name)}:`);
    variants.forEach((v) => { o.push("        | {", ...render(v, "            "), "          }"); });
  }
  return o;
}

/** The whole file, from a parsed snapshot and the helper block. */
export function generate(snapshot, helpers = HELPERS) {
  const enumsList = [...(snapshot.enums || [])].sort((a, b) => byName(a.name, b.name));
  const enums = new Set(enumsList.map((e) => e.name.toLowerCase()));
  const tables = [...snapshot.tables].sort((a, b) => byName(a.name, b.name));
  const tableNames = new Set(tables.map((t) => t.name));
  const views = [...(snapshot.views || [])].sort((a, b) => byName(a.name, b.name));
  const funcs = [...(snapshot.functions || [])];
  const o = [];
  o.push(
    "// GENERATED FILE. Do not edit by hand.",
    "// Written by scripts/schema-to-types.mjs from supabase/schema.snapshot.json.",
    "// Regenerate with:  npm run schema:types      Check it is current with:  npm run schema:types -- --check",
    "// Same shape as `supabase gen types typescript`, so createClient<Database> works the same.",
    "",
    "export type Json =", "  | string", "  | number", "  | boolean", "  | null", "  | { [key: string]: Json | undefined }", "  | Json[]", "",
    "export type Database = {",
    "  // Allows to automatically instantiate createClient with right options",
    "  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)",
    "  __InternalSupabase: {", `    PostgrestVersion: "${POSTGREST_VERSION}"`, "  }",
    "  public: {", "    Tables: {",
  );
  for (const t of tables) o.push(...tableBlock(t, enums));
  o.push("    }", "    Views: {");
  if (views.length === 0) o.push("      [_ in never]: never");
  for (const v of views) {
    o.push(`      ${key(v.name)}: {`, `        // TODO(schema): the snapshot holds this ${v.kind || "view"}'s SQL, not its columns, so Row is untyped.`,
      "        Row: Record<string, unknown>", "        Relationships: []", "      }");
  }
  o.push("    }", "    Functions: {");
  const fl = functionLines(funcs, tableNames, enums);
  if (fl.length === 0) o.push("      [_ in never]: never"); else o.push(...fl);
  o.push("    }", "    Enums: {");
  if (enumsList.length === 0) o.push("      [_ in never]: never");
  for (const e of enumsList) o.push(`      ${key(e.name)}: ${e.labels.length ? e.labels.map((l) => JSON.stringify(l)).join(" | ") : "never"}`);
  o.push("    }", "    CompositeTypes: {", "      [_ in never]: never", "    }", "  }", "}", "");
  o.push(helpers.trimEnd(), "", "export const Constants = {", "  public: {");
  if (enumsList.length === 0) o.push("    Enums: {},");
  else {
    o.push("    Enums: {");
    for (const e of enumsList) o.push(`      ${key(e.name)}: [${e.labels.map((l) => JSON.stringify(l)).join(", ")}],`);
    o.push("    },");
  }
  o.push("  },", "} as const", "");
  return o.join("\n");
}

const HELPERS = `type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never`;

// ---- command line ----
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > -1 ? resolve(process.argv[i + 1]) : fallback; };
  const snapshotFile = arg("--snapshot", join(root, "supabase/schema.snapshot.json"));
  const outFile = arg("--out", join(root, "lib/database.types.ts"));
  const check = process.argv.includes("--check");
  if (!existsSync(snapshotFile)) { console.error(`No snapshot at ${snapshotFile}.`); process.exit(2); }
  const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
  if (!Array.isArray(snapshot.tables) || snapshot.tables.length === 0) { console.error("The snapshot holds no tables. Nothing was written."); process.exit(2); }
  const text = generate(snapshot);
  if (check) {
    const have = existsSync(outFile) ? readFileSync(outFile, "utf8") : null;
    if (have === text) { console.log(`${outFile} is current.`); process.exit(0); }
    console.error(`${outFile} is ${have == null ? "missing" : "out of date"}. Run: npm run schema:types`);
    process.exit(1);
  }
  writeFileSync(outFile, text);
  console.log(`Wrote ${outFile}: ${snapshot.tables.length} tables, ${(snapshot.functions || []).length} functions.`);
}
