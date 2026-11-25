/**
 * The command palette's matcher. Pure functions, no React.
 *
 * Ported from the operator's own site palettes so Fleet
 * ranks the same way. Per query word: exact 1, prefix .8, one typo .5 (two
 * for 7+ letters), inside a word .35. Each word takes its best field: title
 * 10, keywords 5, meta 3, sub line 2. A word that matches nothing drops the
 * entry. A query that starts the title, or sits inside it, scores extra.
 *
 * Two changes from the original, both for a list of machines rather than
 * articles: a word with a digit in it gets no typo matching, and the cut for
 * weak matches is taken per kind.
 */

export type Kind = "server" | "site" | "page" | "action" | "log";

export interface Entry<T = unknown> {
  id: string;
  kind: Kind;
  title: string;
  sub: string;
  /** Extra words worth matching that are not shown as the title: an IP, a provider, a server's name. */
  meta?: string;
  /** Other names people use for this ("logout" for Sign out). */
  keywords?: string[];
  data: T;
}

export interface Indexed<T = unknown> {
  entry: Entry<T>;
  f: { title: string[]; keywords: string[]; meta: string[]; sub: string[] };
  nn: string;
}

export interface Hit<T = unknown> {
  entry: Entry<T>;
  score: number;
}

const WEIGHT = { title: 10, keywords: 5, meta: 3, sub: 2 } as const;
/* Log entries are many and wordy: rank them under the things they mention. */
const KIND_WEIGHT: Record<Kind, number> = { server: 1, site: 1, action: 1, page: 0.95, log: 0.6 };
const STOP = new Set(["a", "an", "the", "of", "to", "for", "on", "in", "and", "is"]);
const SYN: Record<string, string[]> = { fw: ["firewall"], cf: ["cloudflare"], logout: ["sign"], signout: ["sign"] };

export const norm = (s: string) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const words = (s: string) => {
  const n = norm(s);
  return n ? n.split(" ") : [];
};

function lev(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How well query word `t` matches indexed word `w`. `last` is the word still being typed. */
function tok(t: string, w: string, last: boolean) {
  if (w === t) return 1;
  if (w.startsWith(t)) return last || t.length >= 4 ? (t.length === 1 ? 0.5 : 0.8) : 0.45;
  /* No typo matching on a word with a digit in it: web1 is not a misspelled web2. */
  const max = t.length >= 7 ? 2 : 1;
  if (t.length >= 4 && w.length >= 4 && !/\d/.test(t) && Math.abs(w.length - t.length) <= 2 && lev(t, w, max) <= max) return 0.5;
  if (t.length >= 3 && w.includes(t)) return 0.35;
  return 0;
}

const best = (t: string, list: string[], last: boolean) => {
  let b = 0;
  for (const w of list) {
    const s = tok(t, w, last);
    if (s > b) b = s;
    if (b === 1) break;
  }
  return b;
};

export function index<T>(entries: Entry<T>[]): Indexed<T>[] {
  return entries.map((entry) => ({
    entry,
    f: {
      title: words(entry.title),
      keywords: (entry.keywords ?? []).flatMap(words),
      meta: words(entry.meta ?? ""),
      sub: words(entry.sub),
    },
    nn: norm(entry.title),
  }));
}

export function queryWords(q: string) {
  return words(q).filter((w) => !STOP.has(w));
}

export function search<T>(pool: Indexed<T>[], q: string): { hits: Hit<T>[]; toks: string[] } {
  const toks = queryWords(q);
  if (!toks.length) return { hits: [], toks };
  const phrase = toks.join(" ");
  const hits: Hit<T>[] = [];
  for (const e of pool) {
    let score = 0;
    let ok = true;
    toks.forEach((t, ti) => {
      const last = ti === toks.length - 1;
      let b = 0;
      for (const [v, mul] of [[t, 1], ...(SYN[t] ?? []).map((s) => [s, 0.9])] as [string, number][]) {
        for (const f of ["title", "keywords", "meta", "sub"] as const) {
          const s = best(v, e.f[f], last) * WEIGHT[f] * mul;
          if (s > b) b = s;
        }
      }
      if (!b) ok = false;
      score += b;
    });
    if (!ok) continue;
    if (e.nn.startsWith(phrase)) score += 12;
    else if (e.nn.includes(phrase)) score += 6;
    hits.push({ entry: e.entry, score: score * KIND_WEIGHT[e.entry.kind] });
  }
  /* Weak matches are cut against the best of their own kind, not the best overall:
     a server's name should still bring up its sites and the logs that mention it. */
  const top: Partial<Record<Kind, number>> = {};
  for (const h of hits) top[h.entry.kind] = Math.max(top[h.entry.kind] ?? 0, h.score);
  return {
    hits: hits
      .filter((h) => h.score >= (top[h.entry.kind] ?? 0) * 0.15)
      .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title)),
    toks,
  };
}

/** Split text into runs, flagging the words the query matched, for bolding. */
export function markRuns(text: string, toks: string[]): { text: string; hit: boolean }[] {
  if (!toks.length) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  for (const [i, part] of String(text ?? "").split(/([A-Za-z0-9À-ÿ'’]+)/).entries()) {
    if (!part) continue;
    if (i % 2 === 0) {
      out.push({ text: part, hit: false });
      continue;
    }
    const w = norm(part);
    const hit = toks.some(
      (t) => w === t || w.startsWith(t) || (t.length >= 3 && w.includes(t)) || (SYN[t] ?? []).some((x) => w.startsWith(x))
    );
    out.push({ text: part, hit });
  }
  return out;
}
