// Checks lib/stored-value.ts with a stand-in for the browser's storage. Touches nothing real.
//   node --experimental-strip-types --no-warnings scripts/test-stored-value.ts
import { readStored, watchStored, writeStored } from "../lib/stored-value.ts";

let ran = 0, failed = 0;
const check = (name: string, ok: boolean) => { ran++; if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`); };

const kept = new Map<string, string>();
let refuse = false;
const fake = {
  getItem: (k: string) => (kept.has(k) ? kept.get(k)! : null),
  setItem: (k: string, v: string) => { if (refuse) throw new Error("full"); kept.set(k, v); },
  removeItem: (k: string) => { if (refuse) throw new Error("full"); kept.delete(k); },
};

kept.set("view", "custom");
check("with no browser, nothing is read", readStored("view") === null);
(globalThis as unknown as { window: unknown }).window = { localStorage: fake };
check("in a browser, what was saved before is read (nothing was held from the read with no browser)", readStored("view") === "custom");
kept.delete("view");

check("a key nobody saved reads as nothing", readStored("empty") === null);
let heard = 0, heardOther = 0;
const stop = watchStored("view", () => heard++);
const stopOther = watchStored("other", () => heardOther++);
check("the first reader starts from what is saved now", readStored("view") === null);
writeStored("view", "custom");
check("a write is kept in storage", kept.get("view") === "custom" && readStored("view") === "custom");
check("a write tells the listener for that key, once", heard === 1);
check("a write does not tell a listener for another key", heardOther === 0);

kept.set("view", "hottest"); // another tab chooses something else
check("another tab's choice does not change this page while it is reading", readStored("view") === "custom" && heard === 1);
writeStored("view", null);
check("writing nothing removes the key", !kept.has("view") && readStored("view") === null && heard === 2);
kept.set("view", "hottest"); // the other tab again
stop();
check("once nobody on the page is reading, the next read sees what is saved now", readStored("view") === "hottest");
writeStored("view", "custom");
check("a stopped listener hears no more", heard === 2);
stopOther();

refuse = true;
let heardRefused = 0;
const stopRange = watchStored("range", () => heardRefused++);
writeStored("range", "1 Hour");
check("when storage refuses, the value is still read back on this page", !kept.has("range") && readStored("range") === "1 Hour" && heardRefused === 1);
const stopView = watchStored("view", () => {});
writeStored("view", null);
check("when storage refuses a removal, the key still reads as removed on this page", kept.get("view") === "custom" && readStored("view") === null);
refuse = false;
writeStored("range", "6 Hours");
check("once storage accepts again, it holds the value", kept.get("range") === "6 Hours" && readStored("range") === "6 Hours");
stopRange(); stopView();

console.log(`stored-value: ${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
