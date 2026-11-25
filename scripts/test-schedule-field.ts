// Checks how the GridPane sync stores a backup schedule's hour, minute and day:
// zero is a real time and must be kept. Reads no database and calls nothing.
//   node --experimental-strip-types --no-warnings scripts/test-schedule-field.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scheduleField } from "../lib/backup-schedules.ts";

let ran = 0, failed = 0;
const check = (name: string, ok: boolean) => { ran++; if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`); };

// What GridPane sends today: text, zero-padded for the hour and minute.
check('"00" (midnight, or the top of the hour) is kept as "00"', scheduleField("00") === "00");
check('"0" (Sunday) is kept as "0"', scheduleField("0") === "0");
check('"05" is kept as it came', scheduleField("05") === "05");
check('"23" is kept as it came', scheduleField("23") === "23");
// What it could send: numbers. Zero is still a time.
check('the number 0 is kept, as "0"', scheduleField(0) === "0");
check('the number 5 is kept, as "5"', scheduleField(5) === "5");
check('the number 23 is kept, as "23"', scheduleField(23) === "23");
// Only a missing value is "no time": an hourly schedule has no hour, a daily one no day.
check("null stays null", scheduleField(null) === null);
check("a missing field is null", scheduleField(undefined) === null);
check("an empty string is null", scheduleField("") === null);

// The sync itself uses it for all three, and tests none of them for truth.
const sync = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "sync-gridpane.ts"), "utf8");
for (const field of ["hour", "minute", "day"]) {
  check(`the sync stores a schedule's ${field} with scheduleField`, sync.includes(`${field}: scheduleField(bup.${field})`));
  check(`the sync does not test a schedule's ${field} for truth`, !new RegExp(`bup\\.${field}\\s*(\\?[^.?]|\\|\\||&&)`).test(sync));
}

console.log(`schedule field: ${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
