# mcstats design

How the site looks and why, with the exact values, so a new page or feature matches the rest.
The source of truth is the `:root` block and the "shape" section of [public/style.css](public/style.css);
if this file and the stylesheet disagree, the stylesheet wins and this file needs updating.

## The idea

A quiet, dense stats dashboard that sits comfortably beside Minecraft pixel art (player heads, item
icons, the grass-block logo) without dressing up as the game.

- **Pixel where it counts, plain everywhere else.** Numbers and titles use a pixel typeface. Body
  text, labels, tables and controls use an ordinary sans-serif.
- **Everything is built on a 2px unit.** Corners are cut by one 2px square, the way pixel art rounds
  a rectangle. Shadows are the same shape again in one flat colour, offset down and right at 45°,
  like the shadow under text in the game. Nothing has a curved radius, a blur or a gradient.
- **Soft greys, not black and white.** Light mode is grey-on-grey ("day"), dark mode is near-black
  slate ("deepslate"). Neither uses pure white or pure black for a surface.
- **Blue means everyone together.** Any other strong colour on a page belongs to a team, or to a
  state (good, warning, critical). No green as decoration.
- **Tight.** Panels are 14px apart, padding is small, and rows are close. Favour more data on screen
  over breathing room. The space should feel efficently used (though not busy/cluttered) even on smaller windows and phones. However, remember to incorperate spacing where visually nessesary; don't make it cluttered that the user will be overwhelmed.

## Colour tokens

Always use the variable, never the hex. Dark follows the system unless the theme switch has set
`data-theme` on `<html>`, so the dark values are declared twice in the stylesheet (media query and
`:root[data-theme="dark"]`): change both.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--page` | `#e3e5e8` | `#111315` | Page background |
| `--surface` | `#f2f3f5` | `#1a1d21` | Panels, tooltips, popovers |
| `--surface-2` | `#e7e9ec` | `#121417` | Controls set into a panel: inputs, segmented controls, icon buttons |
| `--raise` | `#fbfbfc` | `#272b30` | Things that sit above a panel: badges, the pressed segment, plain buttons |
| `--bar` | `#f2f3f5` | `#0c0e10` | Top bar |
| `--stage` | `#dcdfe3` | `#0e1012` | Backdrop behind a 3D model, the Liveview world, or a game screen shown on a page |
| `--ink` | `#262a30` | `#eceef0` | Main text |
| `--ink-2` | `#50565e` | `#b6bcc4` | Secondary text, labels |
| `--muted` | `#757c86` | `#878e97` | Notes, units, sub-labels |
| `--edge` | `#ced2d7` | `#2e333a` | Panel frames, input borders, the top bar's bottom line |
| `--grid` | `#dfe2e5` | `#24282d` | Chart gridlines, table row lines |
| `--axis` | `#bdc2c8` | `#4a5159` | Chart axes, scrollbar thumb |
| `--pit` | `#aab0b8` | `#3b4149` | The flat drop shadow under panels and badges |
| `--pit-float` | `rgba(20,24,30,.24)` | `rgba(0,0,0,.55)` | The shadow under floating layers |
| `--hover` | `rgba(26,29,33,.06)` | `rgba(255,255,255,.06)` | Hover wash on rows and tabs |
| `--series-1` | `#2f7de0` | `#4a90e8` | Blue: the accent, primary buttons, focus rings, links, "everyone" in charts |
| `--series-2` | `#ea6a33` | `#e0703a` | Second chart series, the chat-time cursor |
| `--series-3` | `#dd9a00` | `#d9a02a` | Third chart series |
| `--accent-ink` | `#ffffff` | `#ffffff` | Text on blue |
| `--good` | `#1fa64a` | `#3fbf5a` | Server up, positive state |
| `--warning` | `#f2ad1c` | `#f0b429` | Warnings, advancement markers, Liveview's controls being on |
| `--critical` | `#dc4343` | `#e5534b` | Errors, deaths, destructive actions, unread badge |
| `--lv0`…`--lv4` | `#e5e7ea` `#bcd6f7` `#7fb1ef` `#3f86e3` `#1f5fb5` | `#14171a` `#173d6e` `#2565b5` `#4f96e8` `#a4cbf7` | Heatmap steps, near zero to high |
| `--team-red` | `#d93a33` | `#f27a72` | Fallback team colours; real ones come from Admin → Teams |
| `--team-blue` | `#2a6fe3` | `#6ea8f5` | (each team has a light and a dark colour) |

Layering, from back to front: `--page` → `--surface` (panel) → `--surface-2` (set in) or `--raise`
(set above). A chart sits directly on `--surface`.

## Type

Fonts load from Google Fonts in [public/index.html](public/index.html).

| Token | Face | Use at exactly | For |
| --- | --- | --- | --- |
| `--font` | Archivo (400–800), then system-ui | any size | All text and controls |
| `--px-20` | Jersey 10 | 20px | Small numbers, the wordmark on phones |
| `--px-30` | Jersey 15 | 30px | Wordmark, page titles, smaller headline numbers |
| `--px-40` | Jersey 20 | 40px | Headline numbers, a player's name |
| `--px-50` | Jersey 25 | 50px | The biggest scoreboard numbers |

Each Jersey face is drawn for one size, so always pair them as above (`font: 400 40px/1.1 var(--px-40)`).
Weight is always 400 for pixel type. Never set body text, labels or buttons in a pixel face.

Sans-serif sizes: body 15px/1.45; tabs 14px semibold; panel titles 15px bold; controls, badges and
most secondary text 13px; notes and table headings 12–12.5px; small tags 11–11.5px. Numbers in tables
and tooltips use `font-variant-numeric: tabular-nums`.

Animated numbers sit in a 1.2em line box (`.odo`, `.odo-static`) so a number that animates and one
that doesn't share a baseline.

## Shape: the 2px system

No `border-radius` anywhere (`--r` and `--r-float` are `0px`). The one exception is the round marker
that rides a chart's line.

All of these are built from box-shadows, declared on every element so they pick up local colours:

```css
--pc: var(--edge);   /* the colour the cut-corner shape is drawn in */
--pixel: -2px 0 0 var(--pc), 2px 0 0 var(--pc), 0 -2px 0 var(--pc), 0 2px 0 var(--pc);
--frame: var(--pixel);
--drop: 0 2px 0 var(--pit), 4px 2px 0 var(--pit), 2px 0 0 var(--pit), 2px 4px 0 var(--pit);
--drop-sm: var(--drop);
--lift: 2px 4px 0 var(--pit-float), 6px 4px 0 var(--pit-float), 4px 2px 0 var(--pit-float), 4px 6px 0 var(--pit-float);
```

`--pixel` grows an element by 2px on each side and leaves the four corner squares empty. What it
looks like depends on `--pc`:

| Kind of thing | Recipe | Result |
| --- | --- | --- |
| Panel (`.card`, `.now`, `.tiles`) | `background: var(--surface); box-shadow: var(--frame), var(--drop);` | Edge-coloured cut-corner frame, shadow one 2px step down-right |
| Badge (`.chip`), primary button | `--pc: <own background>; box-shadow: var(--pixel), var(--drop-sm);` | Cut corners in its own colour (one layer, no outline), shadow one step |
| Control (segmented, icon button, status pill, theme switch) | `--pc: var(--surface-2); background: var(--surface-2); box-shadow: var(--pixel);` | Cut corners, no outline, no shadow |
| Pressed segment / current tab | `--pc: var(--raise)` or `box-shadow: var(--frame)` | A raised or framed block inside the control |
| Floating layer (tooltip, popover, menu, toast) | `box-shadow: var(--frame), var(--lift);` | Frame plus a shadow two steps away |
| Text input, dropdown | `border: 1px solid var(--edge); background: var(--surface-2);` | Plain square box with a hairline |
| Tags, swatches, status dots | no shadow | Plain squares |

Because the shape extends 2px past the box, anything with cut corners needs at least 6px between it
and its neighbour to show a clear 2px gap; with a shadow, allow more (badges are 16px apart).

Elements with a transparent background (`.cg-toggle`, `.tile-select`) must not get `--pixel`: it
would draw a stray box.

Pixel art (heads, icons, logo) always has `image-rendering: pixelated` and is shown at a whole
multiple of its size (24px heads in badges, 14px in tooltips).

## Spacing and layout

- Content column: `max-width: 1152px`, centred, `padding: 14px 16px 32px`.
- Top bar: `min-height: 48px`, `padding: 7px` vertical, `--bar` background, 1px `--edge` line under it.
- Between panels: **14px** (`.card { margin: 14px 0 }`, `.grid2 { gap: 14px }`).
- Panel padding: `14px 16px 16px`; panel header to content: 10px.
- Cells joined inside one panel (the four number tiles) are separated by 1px `--edge` lines made
  with `gap: 1px` on an `--edge` background, not by borders.
- Common gaps: tabs 6px; range controls 6px; segments inside a segmented control 2px; badges 16px;
  form fields 8px; a note after a form or table 12px.
- Breakpoints in use: 1100px (top bar tightens), 800px (tiles go 2-up, numbers drop a size),
  600–640px (top bar wraps to two rows, grids go single column), 420px (smallest paddings).

## Components

| Component | Class | Exact values |
| --- | --- | --- |
| Wordmark | `.brand` | "mcstats", `400 30px/1 var(--px-30)`, 24px logo, 10px gap; 20px face on phones |
| Tab | `.tabs a` | 14px/600, `padding: 5px 12px`, `--ink-2`; current: `--ink` on `--surface-2` with frame |
| Number tile | `.tile` | `padding: 10px 16px 11px`; label 13px/500 `--ink-2`; value `400 40px/1.1 var(--px-40)`; sub 12.5px `--muted` |
| Panel | `.card` | see Shape; title `h2` 15px/700; `.card-sub` 13px `--muted` |
| Player badge | `.chip` | `padding: 2px 11px 2px 2px`, 8px gap, 24px head, 13px/550, `--raise`; hover mixes in 18% `--ink` |
| Segmented control | `.seg` | `padding: 2px; gap: 2px`; buttons 26px tall, `padding: 0 10px`, 13px; pressed is `--raise`, 600 |
| Icon button | `.icon-btn` | 30×30px, `--surface-2`; hover `--grid`; disabled 35% opacity |
| Button | `.btn` | 13px/600, `padding: 6px 14px`, `--raise` with frame; hover `--surface-2` |
| Primary button | `.btn-primary` | `--series-1` background, `--accent-ink` text, cut corners + drop; hover `brightness(1.08)` |
| Quiet button | `.btn-quiet` | transparent, `--muted`, `padding: 4px 10px`; hover `--surface-2` |
| Text input | `.adm-input` | 13px, `padding: 4px 8px`, 1px `--edge` border, `--surface-2` |
| Dropdown | `select` | as input, native arrow removed; own 10×6px pixel arrow `#8a929c`, 9px from the right, `padding-right: 28px` |
| Tooltip | `.tooltip` | `--surface`, frame + lift, `padding: 8px 10px`, 13px, max 260px wide |
| Popover | `.range-pop` | 270px, `padding: 14px`, 10px gap, frame + lift |
| Toast | `.toast` | `--ink` background (errors `--critical`), cut corners + lift, bottom centre |
| Table | `.adm-table`, `.an-table` | headings 12–12.5px/600; rows divided by 1px `--grid`; no zebra stripes |
| Leaderboard bar | `.bar` | 5px tall, `--series-1` (or the team's colour), 4px under its row's text, never narrower than 2px |
| Sign-in popover | `.acct-pop` | 300px, `padding: 14px`, 10px gap, `--surface`, frame + lift; under the top bar's Sign in button |
| Site card | `.site-card` | a `.card`, max 640px, `padding: 20px 22px 22px`; title `400 30px/1.1 var(--px-30)`; fields 14px apart, labels 13px/600 `--ink-2`, hints 12.5px `--muted` |
| Step list | `.wiz-steps` | 220px column beside the step; number square 22×22 `--surface-2`, current `--series-1`, done `--good` with ✓; current row `--surface-2` with frame. Under 800px a row of squares above the step |
| Waiting strip | `.wiz-wait` | `--surface-2`, 14.5px/600, a 10px square that blinks in two steps (`--warning`); green (`--good` mixed 16% into `--surface`) once it's done |

Focus is always `outline: 2px solid var(--series-1)` (offset 1–2px, or -1px on inputs).

In-game tooltips are the deliberate exception to the palette: item tooltips (`.tip-item`, dark purple
`#150a1f` with a `#2f0a6b` inner line) and advancement tooltips (`.adv-tip`, blue `#036a96` title,
gold `#a8782a` when earned, green `#55ff55` description) copy the game's own colours in both themes.

## Charts

- Drawn as SVG directly on the panel surface; gridlines `--grid`, axes and tick labels `--axis` / `--muted`.
- One series is blue (`--series-1`). Several series are team colours first, then `--series-2`, `--series-3`.
- Heatmaps use `--lv0`…`--lv4` only.
- When a chart scrolls or zooms, the y axis stays fixed and only the plot moves; neighbouring data is
  preloaded so there is no blank edge.
- The marker that rides a line on hover is the only round shape on the site.

## Liveview

The Liveview tab ([public/liveview.js](public/liveview.js), admins only) is built from the same parts as the
rest: a page title with a segmented control for its sections, panels, number tiles, tables. Three things are its own.

**The stage** (`.lv-stage`) is the 3D view: `--stage` behind it, `height: clamp(360px, 62vh, 760px)`, no frame of
its own (it sits in a panel). It comes first on the page, above the tiles, because the world is what the page is for.
Everything that floats over it follows the floating-layer recipe, so it reads over any sky, by day or night:

| Over the stage | Class | Exact values |
| --- | --- | --- |
| Tool buttons (top right) | `.lv-tools button` | 28px tall, `padding: 0 9px`, 13px/600, 14px icon; `--surface` with cut corners in its own colour + lift; hover and open: `--raise`. Icons only under 640px |
| Popover (settings, keys) | `.lv-pop` | 300px (keys 340px), 12px in from the stage's edge, `padding: 12px 14px 14px`, 10px gap, frame + lift |
| Following bar, error banner | `.lv-follow`, `.lv-banner` | centred, 52px from the top, frame + lift; the banner adds `inset 3px 0 0 var(--critical)` |
| Camera position | `.lv-hud b` | `400 20px/1.1 var(--px-20)`, white, `text-shadow: 2px 2px 0 rgba(0,0,0,.6)`: the game's debug text |
| Slider | `.lv-range input` | 6px set-in track (`--surface-2`, 1px `--edge`), 10×18px square blue handle |
| Key cap | `.lv-keys kbd` | 11.5px/700, 18px tall, `--raise`, `0 0 0 1px var(--edge), 0 2px 0 var(--pit)` |
| Players menu | `.lv-side` | covers the stage in solid `--surface`; rows divided by 1px `--grid` |

White text straight on the world (the position, the hint, chat) always has a flat 1–2px black shadow, never a blur.

**Amber means the world can be changed.** Watching is the default and looks like any other control
(`.lv-control`: 30px tall, `--surface-2`, a pixel padlock). Switched on, the same button is `--warning` with dark
text (`#241b02`), cut corners + drop, and the padlock's shackle lifts. Anything that only exists while controls are
on carries the same mark: a `inset 3px 0 0 var(--warning)` bar and a 9% `--warning` wash (`.lv-acts-control`).
What needs controls is swapped for a short note and a **Turn on controls** button while they're off
(`.lv-locked` / `.lv-unlocked`), rather than shown disabled. Destructive actions are `--critical` text
(`.btn.lv-danger`) and turn solid `--critical` while they wait for the second click.

**The game's own screens are copied, not restyled**: inventories and chests (`.mc-screen`), item tooltips
(`.mc-tip`), chat lines and the crosshair are drawn from the game's textures and font, like item tooltips elsewhere.
On a page (a player's inventory) they sit on a `--stage` backdrop. The controls around them (close button, the
"inventory below" dropdown) are ours.

The gate card (`.lv-gate`, max 480px, centred) is what shows when something is in the way of watching: one pixel-art
eye, a title, one or two sentences, and at most one field and one button.

The console (`.lv-console`) is the one place with a fixed-width face (`ui-monospace`, 12.5px), so command output
lines up.

## Motion

Short and functional: 0.2–0.35s, `cubic-bezier(0.2, 0.8, 0.3, 1)` (a slight overshoot,
`…, 1.2)`, for badges popping in). Numbers roll like an odometer. Everything is switched off under
`prefers-reduced-motion: reduce`.

## Checklist for a new page or feature

1. Wrap content in `.card` panels, 14px apart; use `.card-head`, `h2`, `.card-sub` for the header.
2. Colours only from the tokens above; check both themes with the switch in the top bar.
3. Big numbers and titles in a Jersey face at its own size; everything else Archivo.
4. No `border-radius`, blur, gradient or soft shadow. Pick the row from the Shape table that matches.
5. Reuse `.seg`, `.btn`, `.icon-btn`, `.chip`, `.adm-input`, `.tooltip` before writing a new control.
6. Blue for "everyone" and for actions; team colours only for teams.
7. Check at 800px and 400px wide.
