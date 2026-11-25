# THE LEDGER — Design System

The app is an **editorial operations ledger**: paper, ink, hairline rules, numbers as
typography. Light-first (dark = graphite plate inversion). No cards where a rule will do.
Emerald is the single accent; status colors (warning/danger) always ship with an icon or
label, never color alone.

## Hard rules

1. **Zero raw colors.** Token classes only (`bg-background/panel/panel-2/sunken/muted`,
   `text-foreground/muted-foreground/faint/primary/warning/danger`, `border-border/
   line-strong`, chart via `var(--chart-1..3)`). Tints = token + `/8`–`/12` opacity.
   **Each status color has two values, a fill and an ink.** `bg-primary`, `border-warning`,
   a dot or a meter take the fill (`--primary`, `--warning`, `--danger`); the same word as
   text (`text-primary`, `text-warning`, `text-danger`) takes the ink (`--primary-ink` and
   so on), which is dark enough to read at 4.5:1 on paper and on its own tint. Never reach
   for the fill to color type. The wordmark's dot is the one exception and has its own
   class, `text-brand`. Inside `bg-sunken` the inks and `faint` are re-set to the bright
   values, since the well is dark in both themes. That rule names the theme variables
   (`--color-faint`, `--text-color-*`) as well as the raw tokens: the classes read the
   theme names, which are worked out once at the root, so re-setting only `--faint`
   there changes nothing a class can see.
2. **Rules over cards.** Sections separate with `border-b border-border` (page-level:
   `border-line-strong`); columns with `border-l border-border`. `Panel` (white card,
   `border border-line-strong rounded-lg`) is reserved for: overlays, forms, and tables
   that need containment. Never nest panels. `Panel` carries no severity variant — a
   colored edge stripe is not an idiom here.
3. **Radii:** `rounded-lg` (8px) cards/overlays · `rounded-md` (6px) controls ·
   `rounded-sm` (4px) tags · `rounded-full` dots only.
4. **Shadows:** overlays only (`shadow-2xl`); everything on the page plane is FLAT.
5. **Type is the design.**
   - Page hero numerals: `text-[64px] lg:text-[78px] font-extrabold tracking-[-0.045em]
     leading-none tabular-nums` (sans).
   - Board figures: `text-[40px] font-bold tracking-[-0.03em] tabular-nums`.
   - Section headers: the `rulehead` utility.
   - Labels/eyebrows: the `eyebrow` utility + `text-faint` (live ones get a 6px emerald
     dot with `anim-blink`).
   - Body: `text-[13px] leading-relaxed`; annotations `text-[12px] text-muted-foreground`.
   - Data values (IPs, timestamps, crons, sizes): `font-mono text-[10.5px]`–`[12px]`.
6. **Motion:** near none. `anim-fade`/`anim-pop` on overlays, `anim-blink` on live dots,
   underline/color transitions 150ms. Nothing moves on scroll. Four moves are sanctioned
   and no others: the tab underline slides to the active tab (150ms), the page fades in
   on a real page change (150ms, `RouteFade`), the theme icon turns over (500ms), and a
   sheet rises from the bottom edge on phones (220ms, `anim-sheet`) and follows the
   finger when dragged down. All four stop under `prefers-reduced-motion`.
7. **Icons:** lucide-react, `size={14}`, `strokeWidth={1.75}`, always beside a label.
8. **Copy voice:** broadsheet-factual, sentence case, no jargon-salad ("natively",
   "seamlessly", "matrices", "bounds" are banned). Data gaps read "spec sync pending".

## Component recipes (components/ui/)

- **Button**: solid = `bg-primary text-primary-foreground rounded-md px-4 py-2
  text-[12.5px] font-semibold hover:opacity-90` (the Sync button); ghost = `bg-panel
  border border-line-strong text-muted-foreground hover:text-foreground`; danger/warning
  ghost = tinted border/text. `IconButton` = 33px square `bg-panel border border-line-strong
  rounded-md`.
- **StatusPill**: `eyebrow rounded-sm px-2 py-[3px]` — ok: `text-primary bg-primary/10`;
  warn: `text-warning bg-warning/10`; danger likewise; neutral: `text-muted-foreground
  bg-panel-2`. Delta tags (▲/▼ + text) same recipe.
- **Text on a tinted row**: the fill colors fail contrast as type on a tint of their own
  color (red on `bg-danger/8` measured 4.28:1, emerald on `bg-primary/8` 3.43:1), which is
  why text takes the ink values (hard rule 1). On a tinted row the title still stays in
  `text-foreground` and the state is a tag: a 5px dot in the tone color plus an `eyebrow`
  word ("Open", "New", "Resolved"). Dark `--danger` (the fill) is `#E84F54`; dark
  `--danger-ink` is `#EF6F73`, the value that reaches 4.5:1 on its own tint. Do not darken
  either.
- **PanelHeader** renders as a `rulehead` row (title left, `eyebrow` links right,
  `ml-auto`).
- **Select/Input**: `bg-panel border border-line-strong rounded-md px-3 py-[7px]
  text-[12.5px] focus:border-primary/60`; selects `appearance-none pr-9` + ChevronDown.
- **Meter**: `h-[4px] rounded-sm bg-panel-2 border border-border`; fill `bg-primary`,
  `bg-warning` ≥75, `bg-danger` ≥90.
- **DataTable — the one table** (`data-table.tsx`). Never build a table by hand. Header
  row `eyebrow text-faint border-b-2 border-foreground`; body rows `border-b
  border-border`, 61px tall everywhere (no zebra; hover = `bg-panel-2/60`); numbers
  right-aligned mono (`numeric`). You give it `columns`, `rows`, `rowKey`, a `noun`
  ("servers") and an `empty` message.
  - **Sorting**: a column with `sortValue` gets a heading that is a button. One click
    sorts, a second reverses; `aria-sort` and a small arrow say which. Empty values sort
    last in both directions. To keep the choice, pass `sort`/`onSortChange` and store it
    with `lib/saved-sort.ts` as `"column-direction"`.
  - **Widths**: one column takes `grow` (the name). It gives way and clips with an
    ellipsis so the fixed columns never push the table wider than the page.
  - **Phones (below `md`)**: the same rows become two-line summaries. Each column says
    where it goes with `phone`: `title`, `subtitle`, `trailing`, `field` (shown when the
    row is opened) or `hidden`. A "Sort" control replaces the headings. There is no
    second list to keep in step.
  - **Paging**: pass `pageSize` (the list pages use 25) to get the `Pager` under the table: "1–25 of 312"
    and two buttons. The range line is always there, so one page and many take the same
    room.
  - **Loading and empty**: the headings stay. While `loading`, the body is rows shaped
    like the table (`skeleton` on a column sets its bar's width), fading gently. When
    there is nothing, the `empty` title, hint and next step sit where the rows would be.
    The table remembers how many rows it last showed on this page (`sessionStorage`,
    `fleet:rows:<path>:<noun>`), so on a return visit the loading shape is the size of
    the loaded table. `skeletonRows` is the guess for a first visit.
  - Also: `selection` (checkboxes and select-all), `rowActions`, `rowTone` (a `warn` or
    `danger` tint), `breakBefore` (a heavier rule between groups), `phoneDetail`.
  `Field` (in `table.tsx`) is still the label-and-value row used inside quick views.
- **FilterBar** (`filter-bar.tsx`): the row above a table. Quick filters first, as pills
  with live counts (`pills`, each `{ id, label, count }`; `count: null` holds the place
  while loading), then search, then "More" for the rarer filters (`more`, built from
  `FilterField` rows; `moreActive` puts a count on the button) and "Clear" when anything
  is set. On phones the pills take the first line and scroll sideways; search and More
  share the line under it. Pills are the questions actually asked of that list ("High
  load", "Overlaps", "Errors"), not every column.
- **Figures** (`figures.tsx`): `Figures cols={2..5}` holds `Figure`s split by hairlines
  with one rule under them, and no boxes. A `Figure` is a label, a big number
  (`text-[40px]`, or `size="lg"` for the 64/78px hero), an optional `unit`, the change
  beside it (`delta`: direction, text, tone) and a `note` under it. `value={null}` draws
  a placeholder the size of the number. **The room for the change and the note is held
  from the first paint**, and on phones a note holds two lines, so a figure that fills in
  late moves nothing. A figure with no reading shows "–", never 0. Two across on a
  phone, a change longer than a few characters ("Action required") cannot sit beside the
  number: `Figures stackDelta` puts every change on its own line under `md`, in every
  state.
- **Callout** (`callout.tsx`): the one way to tell the user something inline. A soft tint
  in the tone's color, an icon, a `title`, the message and an optional `action`. Four
  tones: `note`, `success`, `warning`, `danger`. The icon and the title carry the tone, so
  it never rides on color alone. `live` announces it politely (`"assertive"` for a
  failure the user must see now); `dense` is the small form inside a panel. Do not build a
  tinted box by hand.
- **CodeBlock** (`code-block.tsx`): a labeled `bg-sunken` well with one copy button, for a
  file, a script or a command the user will paste elsewhere. `kind` sets the word before the label
  ("File:", "Shell:", "Dashboard:", "Destructive:"); `copyValue` copies something other than what is shown (a masked
  secret); the button keeps its width when pressed.
- **CopyButton / Copyable** (`copy-button.tsx`): a small icon beside an IP, an ID or a
  cron string. Pressing it copies the value and the icon turns into a check for a moment;
  a hidden status line says "Copied the IP address" for screen readers. Its box never
  changes size. `Copyable` is the mono value and its button kept on one line. A copy
  button never raises a toast. The one exception is a Cloudflare rule's "Copy masked"
  button, which warns that the masked text will not paste back into Cloudflare.
- **Tooltip** (`tooltip.tsx`): names a control and shows its key. `IconButton` has it
  built in (`label`, and `keys="Esc"` when it has a shortcut); wrap anything else in
  `Tooltip`. A mouse gets it after a short rest, the keyboard as soon as focus lands, a
  finger on a long press (which then does not press the control). **Never use the
  `title` attribute on a control**: it never shows on touch or for keyboard users.
- **DetailHeader** (`detail-header.tsx`): the title block on every page below the top
  level (a server, a site, a zone, a server's history). The breadcrumb sits above it; then
  the name with its `status`, one line of `facts` split by dots, `actions` on the right
  and one rule under it. `title={null}` and `facts={null}` draw placeholders of the same
  height; a facts line is 22px tall in every state. A dot never starts or ends a wrapped
  line. `phoneFactLines={2}` holds two lines on phones for a page whose facts always wrap.
- **SummaryStrip** (`summary-strip.tsx`): one line of small figures over a server's
  report, ending in how old the report is (`SummaryFigure`, `SummaryAge`). `stale` gives
  it the warning tint. It heads Fail2Ban, the server firewall and the code cache.
- **Tabs** (`Tabs`, `Tab`, `TabLabel`): the one underlined tab row, used by the masthead
  rail, Firewall and Settings. Navigation links in a `<nav>` with `aria-current`, not
  ARIA tabs; Left/Right/Home/End move focus. One `2.5px` emerald underline per row slides
  to the active tab. Every label is wrapped in `TabLabel` (the `tab-label` utility), which
  reserves the label's bold width so going bold moves nothing beside it. A count that
  loads later gets `count={null}` first, which holds its place. Never build a tab row by
  hand: a row with its own per-link underline cannot slide and its labels will shift.
- **Command palette** (`components/command/`): the search box is a button; the palette
  is a native `<dialog>` opened by ⌘K / Ctrl K, by "/" outside a field, or by that button.
  Centered panel with a preview pane from `md`; a full-screen sheet with Cancel below.
  Input text is 16px (smaller makes iOS zoom the page). Groups are capped at four with a
  "Show all N" row; matched words are tinted `bg-primary/15`; the highlighted row is
  `bg-panel-2` with its icon in `text-primary`. Matching lives in `engine.ts` (pure, so it
  can be tested on its own). To add an action, add one entry to `baseActions` and a handler to
  `PaletteHandlers`: the palette closes first, then runs it. The preview shows a reading
  only when the fleet reported one; it never fills a gap.
- **Floating layers (popovers, anchored dropdowns)**: a fixed-width panel anchored to a
  trigger WILL spill off a phone screen — the trigger's distance from the viewport edge
  is unknowable in CSS. Two sanctioned recipes: small anchored panels (info popovers,
  the chart Filter) keep `absolute` positioning and take `useViewportClamp(open)`, which
  corrects them horizontally to a 12px gutter — pair it with
  `max-w-[calc(100vw-24px)]`; anything bigger (the action logs, the account menu) is a
  `PopoverSheet`, which drops down from its trigger from `sm` and is a bottom sheet
  below. Never ship a new anchored panel without one of the two.
- **Overlays — one family, one hook.** Backdrop `bg-foreground/25 backdrop-blur-[2px]`;
  panel `bg-panel border border-line-strong rounded-lg shadow-2xl`. Every one of them
  runs on `useOverlay(open, onClose, hostRef, { stack })`, which claims the overlay-bus
  (one open at a time, unless `stack`), closes on Escape, makes the page behind `inert`,
  locks scroll with a counted lock, traps Tab, puts focus on the first showing
  `[data-autofocus]` element (or the panel) and returns it to the trigger on close.
  - **Sheet** (`sheet.tsx`): the one modal surface. `side="right"` is a side panel and
    `side="center"` a centered box from `sm`; below `sm` every sheet rises from the
    bottom, leaves the page visible above it, and drags down by its grip or header to
    close. `title`/`meta` or a custom `header`, a scrolling body, an optional pinned
    `footer`.
  - **Drawer** and **Modal** are thin wrappers over the same parts. Use them for forms.
  - **ConfirmDialog**: the one way to ask before anything is deleted or deployed. The
    title is the question with the number in it ("Delete 5 log entries?"), the body says
    who it affects and whether it can be undone, the button says what it does ("Delete 5
    entries", never "OK"). Cancel has the focus. `onConfirm` may be async: the dialog
    stays, busy, and shows a failure in place. It stacks on whatever asked, so Cancel
    returns to a form with its values intact. **Never build a confirm by hand, and never
    use `window.confirm`.** Take the numbers from the database, not from what is on screen.
  - **Peek** (+ `PeekSection`, `PeekMeter`): the quick view for a row. `kind` eyebrow
    (`kindDetail` is dropped on phones), title, status, then sections; `actions` are
    pinned at the bottom; `onPrev`/`onNext` and ↑ ↓ step through the rows of the list
    behind it without closing, with `position` ("2 of 6") announced. A meter with no
    reading says "No reading" and draws no bar. `ServerPeek` and `SitePeek` are the two
    in use; a new kind of row gets its own small wrapper, not a new panel.
  - **PopoverSheet**: a dropdown anchored right under its trigger from `sm`, a Sheet
    below. Used by the action logs and the account menu.
  - **A page must not listen for Escape itself.** A page-level key handler closes the
    form under an open question. Let `useOverlay` own the key.
  - **Menus start on a row.** A menu whose focus lands on its panel ignores arrow keys;
    mark the first row that shows with `data-autofocus`.
- **FilterPill**: the pill itself, used by `FilterBar` and the action logs. `aria-pressed`
  buttons in a `role="group"`, each with its count. The row wraps from `sm` and scrolls
  sideways on phones (`hide-scrollbar`). In the action logs a pill whose count is zero is
  not rendered; in a `FilterBar` every pill stays, so the row keeps its shape.
- **Action logs** (`components/layout/action-logs.tsx`, rules in `lib/action-logs.ts`):
  grouped Today / Yesterday / Earlier, filtered by kind (kinds come from the prefixes the
  app really writes; anything else is "Other"). A row opens in place. `is_read` means
  *read* for an ordinary entry and *resolved* for an error or warning: opening an
  ordinary entry marks it read, opening a problem changes nothing, and "Mark resolved",
  "Reopen" and "Resolve all" are explicit. "Clear read and resolved…" deletes only those,
  after a ConfirmDialog whose counts come from the database.
- **Terminal well**: `bg-sunken rounded-lg font-mono` — ink-dark in BOTH themes;
  chrome = eyebrow `text-faint`.
- **Charts**: Economist manner — horizontal grid `var(--border)` (baseline
  `var(--line-strong)`), NO vertical grid, axis ticks mono 9px `var(--faint)`, series
  `var(--chart-1..3)` strokeWidth 2, **direct labels at line ends** (series name in its
  color, 10.5px semibold) with the right margin reserved (~96px), crosshair + ink tooltip
  (`bg-foreground text-background rounded-md font-mono text-[11px]`). No area fills.
- **Advisory** (warnings): a rulehead section like any other (`PanelHeader
  title="Advisory"` with an eyebrow `meta` domain tag), holding the shared `Callout`:
  `warning` with the count in its title and an action when something needs doing,
  `success` when all is clear. Its height is held, so nothing shifts when the condition
  resolves.

## Layout shell — masthead, no sidebar

`app/(dashboard)/layout.tsx` becomes a stacked shell:
1. **Masthead** (border-b `border-foreground`): wordmark (from `fleet.config.ts`, e.g. `FLEET`) `FLEET<span class
   ="text-brand">.</span>` (`text-[19px] font-extrabold tracking-[0.22em]`), meta stamp
   (eyebrow: `FLEET LEDGER · <date> · <time>`), right: the command palette's button
   (a box with the ⌘K hint from `lg`, an icon below), solid Sync button, theme + bell
   IconButtons, and the account button. The theme button is a half-filled circle drawn
   from the theme class (`rotate-180 dark:rotate-0`), never from state, so it is right on
   the first paint. **On phones the row is search, bell and account only**: theme, Sync
   from GridPane, Profile and Sign out are rows in the account menu (a bottom sheet
   there, a dropdown with Profile and Sign out from `md`). The meta stamp shows only when
   it fits: the left group is a size container and the stamp appears from 480px of it
   (`@min-[480px]:block`), so it can never run under the buttons, including while a task
   is running. Under 340px the wordmark drops to 14px.
2. **Nav rail**: the shared `Tabs` row (Overview/Servers/Sites/Backups/Monitoring/
   Firewall/Settings), `text-[13.5px] font-medium text-muted-foreground`, active
   `font-bold text-foreground` + the sliding `2.5px` emerald underline; hidden under md,
   where the bottom tab bar takes over.
3. **Ticker ribbon** (`bg-panel-2 border-b border-border`): eyebrow-styled per-node
   loads (`WEB1 21.4%`), value mono bold, >75% `text-warning`; overflow-x-auto
   hide-scrollbar; the bar is there from the first paint, with placeholders where the
   loads will be, so the page under it never drops. Data: one client component,
   single query (latest telemetry row per server) + 60s refresh — no realtime channel.
4. **Content**: `max-w-[1360px] mx-auto px-5 lg:px-8`; page sections separated by rules.
5. **Footer**: hairline top rule + eyebrow row (`FLEET LEDGER · DATA: SUPABASE ·
   GRIDPANE API · REFRESH 600S`).
Breadcrumbs are for pages below the top level only (a server, a site, a zone, Backup
schedules): a slim mono line in a fixed-height row that renders with the page. Under it
sits the `DetailHeader`, the same on all of them.

### Nothing moves when you switch tabs (binding)

Measured before these rules: tab labels stepped 3 to 4px, page titles sat at three
different heights, and the Firewall tab row and the Overview board dropped as data
arrived. The rules that removed all of it:

- **One title position.** A top-level page starts with its `PageHeader`. Nothing goes
  above it: no breadcrumb, no tab row (tabs sit under the title).
- **The real title shows while the page loads.** A skeleton title is a different height
  from the real one; render the real header and put the skeleton under it.
- **Hold the space for anything that arrives late**: a sentence that will run to two
  lines gets `min-h-[2lh]`, a status tag gets an invisible twin, a count gets its slot.
- **The scrollbar's space is always held** (`scrollbar-gutter: stable` on
  `#main-scroll-container`). The masthead and ticker pad their right side by `--sbw`
  (the scrollbar's width, measured by the boot script in `app/layout.tsx`) so they stay
  lined up with the content. Any new full-width strip above the scroller needs the same
  `pr-[var(--sbw,0px)]`.
- **A filter that writes to the URL must not rebuild the page.** There is no
  `template.tsx`; `RouteFade` fades on a real page change and leaves the page alone on a
  query change. Pages that share a title and tab row count as one place and do not fade.
- Check by measuring a local build with mock data before and after.

### Nothing moves when the data arrives (binding)

The same promise for loading. Measured with every answer held back a second and a half,
the limit is a layout shift of 0.05 per page, half of what Core Web Vitals calls good.

- **A placeholder is the shape of what replaces it**: the same box, padding and line
  height, not a grey block of a guessed size. `DataTable`, `Figure`, `DetailHeader` and
  `RunStampSkeleton` do this already; use them rather than `Skeleton` with a height.
- **A placeholder never claims an answer.** "No entries" or "Spec sync pending." before
  the fetch has answered is wrong copy as well as a shift. Keep a flag for "the fetch has
  answered" and show row-shaped placeholders until it is set.
- **Something that may or may not appear keeps its room either way.** A status that only
  shows on a problem gets a quiet twin for the good state ("No collisions"), or its line
  is held.
- **Two traps in the code.** Inside `cn()`, a font-size class written after a `leading-*`
  class removes the line height (tailwind-merge treats the size as resetting it): write
  the size first. And a `min-h` with padding from a `className` is measured to the
  border, so the padding eats into it: add `box-content` when the minimum is meant for
  the content.
- **Text that grows after loading leaves `text-pretty` off.** `pretty` re-breaks the
  whole paragraph each time its text changes, so a note that gains a sentence moves the
  words already on screen. Plain wrapping only ever adds after them; glue the last two
  words by hand instead (the web-ports note on Firewall).
- **A placeholder bar holds the height of its line, not only its own.** A 10px bar where
  a 21px pill arrives is fine beside taller neighbors and 11px short once it wraps onto
  its own line on a phone: wrap the bar in a box of the line's height.
- **What cannot be held**, and is left: a first visit cannot know how many rows a table
  will have, and a panel whose length depends on what a server reported (a rule list, a
  slow-query log) grows downward when it arrives. Nothing above it moves.
- Check by loading each page on a throttled connection and comparing box sizes before
  and after the data arrives.

## What stays exactly as-is

All data logic: Supabase queries, realtime channels, AGENT_V1 parsing (`/\|AGENT_V1$/`
strip before atob), localStorage keys, window CustomEvents, handlers, cron math,
`createPortal` overlays, Escape/click-outside, the 360°
SVG health ring geometry (restyled: ink track, emerald value arc, hairline N/E/S/W ticks).

## Mobile doctrine (binding)

The Ledger is phone-first in use: the operator manages the fleet from a mobile browser and an
installed home-screen app. Every change below is mandatory; none may alter desktop
rendering (env() insets are 0 there, coarse-pointer rules never match).

1. **Viewport & PWA:** `viewport` export sets `viewportFit: "cover"` —
   therefore every fixed/sticky edge element MUST pad with safe-area insets, additively:
   `pb-[calc(12px+env(safe-area-inset-bottom))]`, `pt-[calc(8px+env(safe-area-inset-top))]`,
   never replacing the base padding. `ThemeColorSync` keeps browser chrome matched to the
   in-app theme toggle.
2. **Viewport units:** `dvh` only. No `h-screen`, no bare `vh` in overlays/shells
   (`h-dvh`, `max-h-[85dvh]`, …). Review each swap in context — no blind sed.
3. **Fields:** a global coarse-pointer rule forces 16px on input/select/textarea
   (iOS focus-zoom kill). Do not fight it with arbitrary text sizes on form controls;
   design field layouts to tolerate 16px on phones.
4. **Tap targets:** every interactive element under 44px gets the `touch-hit` utility
   (globals.css) — expands the hit zone on coarse pointers only, visual box unchanged.
   Never enlarge the visual box to meet the target.
5. **No hover-gated functionality.** Anything revealed by `group-hover`/`hover:` must
   also be reachable on touch: render it always-visible on coarse pointers
   (`@media (hover: none)` / `pointer-coarse:` variants) or behind an explicit tap.
6. **Navigation (phones, <md):** bottom tab bar — fixed, `bg-panel` with hairline top
   rule (`border-t border-line-strong`), eyebrow-styled labels, active tab
   `text-foreground` + emerald dot, inactive `text-muted-foreground`;
   `pb-[env(safe-area-inset-bottom)]`. Four tabs (Overview, Servers, Sites, Firewall) and
   **More**, which opens a sheet with Backups, Monitoring and Settings, each with a
   one-line hint; More carries the dot when the current page is one of those. The top nav
   rail hides under md. Sync is the second row of the account menu on phones.
7. **Overlays on phones:** every drawer, quick view, menu and question is a bottom
   sheet: full width, rounded top corners, a grip, the page still visible above it, and
   `pb` padded by the bottom safe-area inset. Overlay z-order: content < bulk bars
   (z-100) < palette/sheets — a new overlay is built on `Sheet` or `useOverlay`, never
   on its own portal and key handlers.
8. **Tables:** under md, `DataTable` turns each row into a two-line summary that opens
   in place (see its recipe). No table scrolls sideways.
9. **Typography:** `text-balance` on headings/PageHeader h1, `text-pretty` on body
   copy and EmptyState hints (no stranded last word). `text-wrap: pretty` only works in
   Chromium and Safari 26, so a sentence also gets its last two words glued: `tie()`
   from `lib/utils` for a string, `{"\u00a0"}` before the last word in JSX. `Callout`,
   `EmptyState`, a `Figure` note, a `CodeBlock` footnote and a `DataTable` empty hint
   tie a string for you. `tie` leaves a pair longer than 22 characters alone (a
   hostname, a path): glued, it could be pushed off a narrow screen, which is worse
   than a stranded word.
10. **Text on sunken wells:** use `text-on-sunken` / `text-on-sunken-dim` tokens —
    raw stone-*/zinc-* classes are banned everywhere, no exceptions.
11. **Motion:** the reduced-motion blanket in globals.css covers everything; data
    transitions (Meter, health ring, storage bars) cap at 300ms.
