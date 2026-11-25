# Backup timeline resolver

## What it is for

The Backups page shows when each site's backup runs and marks the ones that
overlap: two backups that start at the same hour and minute on the same server
compete for that server's disk and CPU. The resolver lets you spread them out,
then writes the new times to GridPane and to the app's own copy in Supabase.

## How a change is sent (`app/api/backups/resolve/route.ts`)

The page sends the route a list of changes. The route sends GridPane one `PUT`
per change and records each answer's HTTP status in the `system_logs` table.

## Hourly schedules have no hour (important)

A GridPane **hourly** schedule has no `hour`. The app keeps it as `null`.

- **Do not send `hour: 0` for an hourly schedule.** GridPane answers
  `422 Unprocessable Entity`, and the page would show a change that did not
  happen.
- **Do not call `.toString()` on an hourly schedule's hour.** Check
  `bup_schedule !== 'hourly'` first.

## Rate limits and the sync

GridPane's API rate limits are strict.

1. Anything that reads many sites in a row (such as `scripts/sync-gridpane.ts`)
   must pause between calls.
2. When a resolve finishes, the task runner fires a `system_logs_updated` event
   on `window`, which refreshes the bell indicator.
