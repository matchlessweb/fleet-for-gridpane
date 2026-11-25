// Proves scripts/schema-to-types.mjs. It runs the generator on a small made-up
// snapshot that holds one object of every kind, checks the text it writes,
// checks that --check passes on a fresh file and fails on a stale or missing
// one, and then runs controls: it breaks a copy of the generator in several
// ways and shows that each break is caught by the same checks.
//
//   npm run types:test
//
// Needs no database and no network. It also asks the real committed
// lib/database.types.ts to be current (the same thing CI's --check does).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const generatorFile = join(here, "schema-to-types.mjs");
const work = mkdtempSync(join(tmpdir(), "schema-types-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

const col = (name, type, o = {}) => ({ name, type, not_null: o.nn ?? false, default: o.def ?? null, identity: o.id ?? "", generated: o.gen ?? "", comment: null });
const con = (name, type, def) => ({ name, type, def });
const fn = (name, args, def) => ({ name, args, security_definer: false, acl: null, def });
const snapshot = {
  tables: [
    { name: "widgets", rls: true, rls_forced: false, comment: null,
      columns: [
        col("id", "bigint", { nn: true, id: "d" }),
        col("label", "text", { nn: true }),
        col("note", "text"),
        col("settings", "jsonb", { nn: true, def: "'{}'::jsonb" }),
        col("addr", "inet"),
        col("tags", "text[]"),
        col("mood", "mood", { nn: true }),
        col("ratio", "numeric(5,2)"),
        col("active", "boolean", { nn: true, def: "true" }),
        col("made_at", "timestamp with time zone", { nn: true, def: "now()" }),
        col("label_len", "integer", { gen: "s" }),
      ],
      constraints: [con("widgets_pkey", "p", "PRIMARY KEY (id)")], indexes: [], triggers: [], policies: [], grants: [] },
    { name: "parts", rls: true, rls_forced: false, comment: null,
      columns: [col("id", "uuid", { nn: true, def: "gen_random_uuid()" }), col("widget_id", "bigint", { nn: true }), col("owner_id", "bigint")],
      constraints: [
        con("parts_pkey", "p", "PRIMARY KEY (id)"),
        con("parts_widget_id_fkey", "f", "FOREIGN KEY (widget_id) REFERENCES widgets(id) ON DELETE CASCADE"),
        con("parts_owner_id_fkey", "f", "FOREIGN KEY (owner_id) REFERENCES public.widgets(id)"),
        con("parts_owner_id_key", "u", "UNIQUE (owner_id)"),
      ], indexes: [], triggers: [], policies: [], grants: [] },
  ],
  functions: [
    fn("do_nothing", "p_id bigint, p_token text", "CREATE OR REPLACE FUNCTION public.do_nothing(p_id bigint, p_token text DEFAULT NULL::text)\n RETURNS void\n LANGUAGE plpgsql\nAS $$ begin end $$"),
    fn("is_ok", "p_id bigint", "CREATE OR REPLACE FUNCTION public.is_ok(p_id bigint)\n RETURNS boolean\n LANGUAGE sql\nAS $$ select true $$"),
    fn("get_json", "p_ids bigint[]", "CREATE OR REPLACE FUNCTION public.get_json(p_ids bigint[])\n RETURNS jsonb\n LANGUAGE sql\nAS $$ select '{}'::jsonb $$"),
    fn("set_stamp", "", "CREATE OR REPLACE FUNCTION public.set_stamp()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $$ begin return new; end $$"),
    fn("list_widgets", "p_mood mood", "CREATE OR REPLACE FUNCTION public.list_widgets(p_mood mood)\n RETURNS SETOF widgets\n LANGUAGE sql\nAS $$ select * from widgets $$"),
    fn("list_ids", "", "CREATE OR REPLACE FUNCTION public.list_ids()\n RETURNS SETOF bigint\n LANGUAGE sql\nAS $$ select cast(1 as bigint) $$"),
    fn("pairs", "", "CREATE OR REPLACE FUNCTION public.pairs()\n RETURNS TABLE(a integer, b text)\n LANGUAGE sql\nAS $$ select 1, 'x' $$"),
    fn("mystery", "", "CREATE OR REPLACE FUNCTION public.mystery()\n RETURNS SETOF record\n LANGUAGE sql\nAS $$ select 1 $$"),
    fn("twice", "p_a bigint", "CREATE OR REPLACE FUNCTION public.twice(p_a bigint)\n RETURNS integer\n LANGUAGE sql\nAS $$ select 1 $$"),
    fn("twice", "p_a text", "CREATE OR REPLACE FUNCTION public.twice(p_a text)\n RETURNS integer\n LANGUAGE sql\nAS $$ select 1 $$"),
  ],
  views: [{ name: "widget_summary", kind: "v", def: "SELECT id FROM widgets" }],
  enums: [{ name: "mood", labels: ["calm", "angry"] }],
};

const squash = (s) => s.replace(/\s+/g, " ");
// Each check: a name and a snippet the output must contain (whitespace-insensitive).
const wanted = [
  ["header says generated and how to regenerate", "GENERATED FILE. Do not edit by hand. // Written by scripts/schema-to-types.mjs"],
  ["header names the regenerate command", "npm run schema:types"],
  ["no date in the file", (t) => !/\b20\d\d-\d\d-\d\d\b|GMT|Generated at/i.test(t)],
  ["exports Json", "export type Json = | string | number | boolean | null"],
  ["exports Database with public.Tables", "export type Database = { // Allows"],
  ["keeps __InternalSupabase", '__InternalSupabase: { PostgrestVersion: "14.5" }'],
  ["tables sorted: parts before widgets", (t) => t.indexOf("      parts: {") > 0 && t.indexOf("      parts: {") < t.indexOf("      widgets: {")],
  ["columns sorted inside Row", (t) => /Row: \{\s+active: boolean\s+addr: unknown/.test(t)],
  ["Row: not null stays plain", "Row: { active: boolean addr: unknown | null"],
  ["Row: nullable text gets | null", "note: string | null"],
  ["Row: jsonb -> Json", "settings: Json tags: string[] | null"],
  ["Row: nullable inet -> unknown | null", "addr: unknown | null"],
  ["Row: array -> string[] | null", "tags: string[] | null"],
  ["Row: enum -> union through Enums", 'mood: Database["public"]["Enums"]["mood"] note:'],
  ["Row: numeric(5,2) -> number | null", "ratio: number | null"],
  ["Row: bigint -> number", "id: number label: string"],
  ["Row: timestamptz -> string", "made_at: string"],
  ["Row: generated column is present", "label_len: number | null"],
  ["Insert: not null, no default is required", "Insert: { active?: boolean addr?: unknown | null id?: number label: string"],
  ["Insert: default makes it optional", "made_at?: string"],
  ["Insert: jsonb default is optional", "settings?: Json"],
  ["Insert: identity is optional", "id?: number"],
  ["Insert: nullable is optional and keeps | null", "note?: string | null"],
  ["Insert: enum required when not null and no default", 'mood: Database["public"]["Enums"]["mood"] note?'],
  ["Insert: generated column is left out", (t) => { const i = t.indexOf("Insert:", t.indexOf("widgets: {")); return !t.slice(i, t.indexOf("Update:", i)).includes("label_len"); }],
  ["Update: generated column is left out", (t) => { const i = t.indexOf("Update:", t.indexOf("widgets: {")); return !t.slice(i, t.indexOf("Relationships", i)).includes("label_len"); }],
  ["Update: everything optional", "Update: { active?: boolean addr?: unknown | null id?: number label?: string"],
  ["Relationships: empty table has []", "Relationships: [] }"],
  ["Relationships: foreign key parsed", 'foreignKeyName: "parts_widget_id_fkey" columns: ["widget_id"] isOneToOne: false referencedRelation: "widgets" referencedColumns: ["id"]'],
  ["Relationships: schema prefix removed, unique key is one-to-one", 'foreignKeyName: "parts_owner_id_fkey" columns: ["owner_id"] isOneToOne: true referencedRelation: "widgets"'],
  ["Relationships: sorted by constraint name", (t) => t.indexOf("parts_owner_id_fkey") < t.indexOf("parts_widget_id_fkey")],
  ["Views: untyped Row with a TODO", "TODO(schema)"],
  ["Views: Row is Record<string, unknown>", "widget_summary: { // TODO(schema): the snapshot holds this v's SQL, not its columns, so Row is untyped. Row: Record<string, unknown>"],
  ["Functions: default argument is optional", "do_nothing: { Args: { p_id: number; p_token?: string } Returns: undefined }"],
  ["Functions: void -> undefined", "Returns: undefined"],
  ["Functions: boolean", "is_ok: { Args: { p_id: number } Returns: boolean }"],
  ["Functions: jsonb return -> Json, bigint[] argument", "get_json: { Args: { p_ids: number[] } Returns: Json }"],
  ["Functions: trigger function is left out", (t) => !t.includes("set_stamp")],
  ["Functions: SETOF table -> Row[], enum argument", 'list_widgets: { Args: { p_mood: Database["public"]["Enums"]["mood"] } Returns: Database["public"]["Tables"]["widgets"]["Row"][] }'],
  ["Functions: SETOF scalar -> scalar[], no args -> never", "list_ids: { Args: never Returns: number[] }"],
  ["Functions: TABLE(...) -> array of objects", "pairs: { Args: never Returns: { a: number; b: string }[] }"],
  ["Functions: SETOF record -> unknown[] with a note", "// RETURNS record: the columns are not in the snapshot Args: never Returns: unknown[]"],
  ["Functions: overloads become a union", "twice: | { Args: { p_a: number } Returns: number } | { Args: { p_a: string } Returns: number }"],
  ["Functions: sorted by name", (t) => t.indexOf("      do_nothing:") < t.indexOf("      get_json:") && t.indexOf("      get_json:") < t.indexOf("      twice:")],
  ["Enums: union of labels", 'Enums: { mood: "calm" | "angry" }'],
  ["CompositeTypes: empty", "CompositeTypes: { [_ in never]: never }"],
  ["Helpers: Tables, TablesInsert, TablesUpdate, Enums, CompositeTypes still exported", (t) => ["Tables<", "TablesInsert<", "TablesUpdate<", "Enums<", "CompositeTypes<"].every((n) => t.includes(`export type ${n}`))],
  ["Constants carries the enum labels", 'export const Constants = { public: { Enums: { mood: ["calm", "angry"], }, }, } as const'],
  ["output ends with one newline", (t) => t.endsWith("as const\n") && !t.endsWith("\n\n")],
];

function runChecks(text) {
  return wanted.filter(([, w]) => !(typeof w === "function" ? w(text) : squash(text).includes(squash(w)))).map(([name]) => name);
}

let ran = 0, failed = 0, controls = 0;
const ok = (name, pass, detail = "") => { ran++; if (!pass) failed++; console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : "\n       " + detail}`); };

const snapFile = join(work, "snapshot.json");
writeFileSync(snapFile, JSON.stringify(snapshot));
const cli = (gen, ...args) => spawnSync(process.execPath, [gen, "--snapshot", snapFile, ...args], { encoding: "utf8" });
const load = async (file) => (await import(pathToFileURL(file).href + "?v=" + Math.random())).generate;

console.log("Output of the real generator:");
const generate = await load(generatorFile);
const text = generate(snapshot);
const missed = runChecks(text);
for (const [name] of wanted) ok(name, !missed.includes(name));
ok("same input gives the same bytes twice", generate(snapshot) === generate(JSON.parse(JSON.stringify(snapshot))));
ok("tables given in another order give the same bytes", generate({ ...snapshot, tables: [...snapshot.tables].reverse(), functions: [...snapshot.functions].reverse() }) === text);

console.log("The output is valid TypeScript (Node strips the types and runs it):");
const outTs = join(work, "fixture.types.ts");
writeFileSync(outTs, text);
const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(outTs).href)}); console.log(JSON.stringify(m.Constants))`], { encoding: "utf8" });
ok("the generated file loads", run.status === 0 && run.stdout.includes('"mood":["calm","angry"]'), run.stderr);

console.log("--check mode:");
const outFile = join(work, "out.types.ts");
let r = cli(generatorFile, "--out", outFile);
ok("writing exits 0", r.status === 0, r.stderr);
ok("the written file is exactly the generated text", readFileSync(outFile, "utf8") === text);
r = cli(generatorFile, "--out", outFile, "--check");
ok("--check passes on a fresh file", r.status === 0, r.stderr);
writeFileSync(outFile, text.replace("label: string", "label: string | null"));
r = cli(generatorFile, "--out", outFile, "--check");
ok("--check fails on a stale file", r.status === 1 && /out of date/.test(r.stderr), r.stderr);
ok("--check does not rewrite the stale file", readFileSync(outFile, "utf8") !== text);
r = cli(generatorFile, "--out", join(work, "none.ts"), "--check");
ok("--check fails when the file is missing", r.status === 1 && /missing/.test(r.stderr), r.stderr);
writeFileSync(snapFile, JSON.stringify({ ...snapshot, tables: [] }));
r = cli(generatorFile, "--out", outFile);
ok("an empty snapshot is refused and nothing is written", r.status === 2 && readFileSync(outFile, "utf8") !== "", r.stderr);
writeFileSync(snapFile, JSON.stringify(snapshot));

console.log("The committed file is current:");
const root = resolve(here, "..");
r = spawnSync(process.execPath, [generatorFile, "--check"], { encoding: "utf8", cwd: root });
ok("lib/database.types.ts matches supabase/schema.snapshot.json", r.status === 0, r.stderr);

console.log("Controls: a broken copy of the generator must be caught:");
const src = readFileSync(generatorFile, "utf8");
const breaks = [
  ["nullable columns lose | null", "(nullable ? `${t} | null` : t)", "t"],
  ["a default no longer makes Insert optional", "nullable || c.default != null || Boolean(c.identity)", "nullable || Boolean(c.identity)"],
  ["an identity column is required on Insert", "nullable || c.default != null || Boolean(c.identity)", "nullable || c.default != null"],
  ["a generated column is writable", "if (c.generated) continue;", ""],
  ["Update fields become required", "`${key(c.name)}?: ${unionOf(t, nullable)}`", "`${key(c.name)}: ${unionOf(t, nullable)}`"],
  ["a foreign key is dropped", 'filter((k) => k.type === "f")', 'filter((k) => k.type === "zz")'],
  ["every key is one-to-many", "uniques.includes(", "[].includes("],
  ["the schema prefix is kept on the referenced table", "table: bare(m[2])", "table: m[2].trim()"],
  ["jsonb becomes unknown", 't === "json" || t === "jsonb"', 't === "json"'],
  ["inet becomes string", 'else base = "unknown"; // inet', 'else base = "string"; // inet'],
  ["arrays lose their []", '"[]".repeat(arrays)', '""'],
  ["enums are not mapped", "else if (enums.has(t))", "else if (false)"],
  ["a trigger function is kept", 'if (/^(trigger|event_trigger)$/i.test(p.returns || "")) continue;', ""],
  ["default arguments become required", '${key(a.name)}${a.hasDefault ? "?" : ""}: ${tsType(a.type, enums)}', '${key(a.name)}: ${tsType(a.type, enums)}'],
  ["void returns void", '{ ts: "undefined" }', '{ ts: "void" }'],
  ["SETOF loses its array", 'const suffix = setof ? "[]" : ""', 'const suffix = ""'],
  ["tables are not sorted", "[...snapshot.tables].sort((a, b) => byName(a.name, b.name))", "[...snapshot.tables]"],
  ["the helper types are dropped", "o.push(helpers.trimEnd(), ", "o.push("],
];
for (const [name, from, to] of breaks) {
  controls++;
  if (!src.includes(from)) { ok(`control: ${name}`, false, "the generator no longer contains the text this control breaks: update the control"); continue; }
  const file = join(work, `broken-${controls}.mjs`);
  writeFileSync(file, src.replace(from, () => to));
  let caught;
  try { const bad = (await load(file))(snapshot); caught = runChecks(bad); } catch (e) { caught = [`threw: ${e.message}`]; }
  ok(`control: ${name} -> caught by ${caught.length} check${caught.length === 1 ? "" : "s"}`, caught.length > 0);
}
{
  controls++;
  const file = join(work, "broken-check.mjs");
  writeFileSync(file, src.replace("have === text", "true"));
  const stale = join(work, "stale.ts");
  writeFileSync(stale, "export type Json = never\n");
  r = cli(file, "--out", stale, "--check");
  ok("control: a --check that always passes -> caught (it no longer fails a stale file)", !(r.status === 1 && /out of date/.test(r.stderr)));
}

console.log(`\ntypes:test: ${ran - controls} checks and ${controls} controls ran, ${failed} failed`);
process.exit(failed ? 1 : 0);
