# MapLibre map artifact

A zoomable, pannable map drawn with MapLibre GL. Use it when the map needs
zoom, pan, or hover interaction, or when it covers more features than a
single static frame can show legibly. A map that is one fixed view of a few
hundred shapes is better served by the `d3-map` template — that one is
simpler, lighter, and has no tiles to go wrong.

This template is built: the platform runs `npm ci && npm run build` and
serves `dist/index.html`. You never run the build yourself; rendering does
it for you.

The template is a map, not a choropleth. `src/map.ts` ships an example
choropleth, described in `NOTES.md`; it is a starting point, not the shape
of the template. If you are building something else, delete it and work
from "Modes" below. Nothing in `src/lib/` depends on it.

## What you edit

- `src/map.ts` — the map. Everything specific to this artifact.
- `src/style.css` — styling, and the palette tokens.
- `data/` — staged data files, via `stageDataFile`. Never write into it
  directly.
- `README.md` and `NOTES.md` — the human overview and the durable technical
  handoff for this specific artifact. Both ship describing the example;
  replace them.

Do not edit `src/main.ts`, `src/lib/`, `index.html`, `vite.config.ts`, or
`package.json`'s `build` script. They are template wiring — the PMTiles
protocol, the basemap, the data accessors, the published-geography table
and its measured zoom thresholds — and editing them is how a map stops
rendering.

## Data

Values come from `query(sql)`. Files you staged with `stageDataFile` come
from `dataFile(name)`. Both are in `src/lib/data.ts` and neither needs a
token, an endpoint, or a `fetch`.

Pull everything you need once, at load. **Never fetch on `moveend`.** Data
is small — every US tract with one number is a couple of megabytes — and
the expensive part of a map, its geometry, is either tiled or staged.

Two limits worth knowing before you choose an approach:

- Anything you stage is committed to the artifact's Git repository on every
  revision, in full. Values are small and change often, which is fine.
  Geometry is large and never changes, which is not: past a few megabytes,
  use published geography instead of staging a boundary file.
- The build runs with **no network access**. Anything downloaded must be
  downloaded while you are authoring, in the shell, and staged.

## Modes

### Choropleth: values painted onto published boundaries

**Geometry comes from tiles. Values come from SQL.** Do not query geometry,
do not merge values into geometry, and do not download boundaries at view
time. The boundaries listed under "Published geography" are already vector
tiles on our own origin, pre-simplified for every zoom, and MapLibre
fetches exactly the tiles the current view needs without any code from you.

```ts
import { addTileLevel, setValues } from './lib/geography'
import { query } from './lib/data'

const { fillLayer, lineLayer } = addTileLevel(map, 'census.county', 2023)
const rows = await query('SELECT geoid, value FROM ...')
const join = await setValues(map, 'census.county', rows, 'geoid', 'value')
```

`addTileLevel` adds the source and its fill and line layers, promoting the
level's id field to the feature id. Its third argument is **the year of the
data** — see "Vintage" below; it has no default. `setValues` writes each row
into feature state and returns a join report. Then paint from that state:

```ts
map.setPaintProperty(fillLayer, 'fill-color', [
  'interpolate', ['linear'], ['to-number', ['feature-state', 'value']], ...,
])
map.setPaintProperty(fillLayer, 'fill-opacity', [
  'case', ['==', ['feature-state', 'value'], null], 0, 0.75,
])
```

Feature state lives on the source and is keyed by id, so a value set for an
id whose tile has not loaded yet is kept and applied when it does. That is
why you push the whole result set in once and write no zoom handler at all.

Your SQL must return one row per feature. Aggregate in the query, not in
the browser. Join on the id field as a **string**, with leading zeroes
intact.

**More than one level.** Add each with `addTileLevel` and the handover is
automatic and exclusive: each level is cut off where the next finer one you
added begins, so exactly one ever paints. Write no zoom handler, no
visibility toggle, and no view buttons of your own. Two levels drawing at
once stacks two semi-transparent fills into an opaque sheet and hides the
basemap entirely. The map's own `maxZoom` follows the finest level you
added, so a county-only map stops rather than inviting a zoom to street
level that reveals nothing.

### Bringing your own geometry

Custom territories, dissolved regions, a river network, anything not in the
published table. Download it while authoring, check it, stage it with
`stageDataFile`, and add it as a `geojson` source:

```ts
const shapes = await dataFile<GeoJSON.FeatureCollection>('territories.geojson')
map.addSource('territories', { type: 'geojson', data: shapes, promoteId: 'id' })
```

Bespoke geometry is small enough for this; it is bespoke because someone
drew it. `d3-map`'s AGENTS.md documents the sources and the download checks
in detail, and they apply here unchanged. Never fetch boundaries from a
third-party host at view time.

You own what `addTileLevel` would have done for you: the layers, their
zoom range, and the join. Simplify while authoring, not in the browser.

**Before you reach for this, check whether you need new geometry at all.**
A grouping of published units — sales territories, regions, catchments,
anything defined as a list of counties or tracts — is not new geometry. It
is a join. Return one row per published unit carrying its group's value and
paint the existing tiles; every unit in a group takes the same colour. The
only thing that differs from true dissolved shapes is that internal
boundaries still show, which is a line-layer problem: filter the line layer
to the group edges, or drop it.

### Points

Point geometry *is* data — it comes out of SQL as coordinates, and the
choropleth rule above does not apply. Build a `geojson` source from the
rows and add a `circle` layer.

Encode the measure as colour, radius, or both, and set `circle-radius` with
an `interpolate` on zoom so points stay legible as the reader zooms out.
Give every circle a `circle-stroke-width` in `--surface` so overlapping
points remain countable.

Past a few tens of thousands of points, set `cluster: true` on the source
and label the clusters; past a few hundred thousand, a dot map is the wrong
encoding and the honest answer is to aggregate to a published level and
build a choropleth.

### Heatmap

A `heatmap` layer over the same kind of `geojson` source. Use it for
density — where observations are concentrated — and not as a substitute
for a value you could paint directly. A heatmap of ten points is noise
presented as a finding.

Set `heatmap-weight` from the measure, `heatmap-intensity` and
`heatmap-radius` as `interpolate` expressions on zoom, and be aware that
what a reader sees is density smoothed by a radius in *screen* pixels: the
same data reads differently at different zooms, so say what the colour
means in the legend and do not label it with data units it does not carry.

## One level is a choice you have to justify

**Check whether your measure exists at a finer level, and add it if it
does.** This map zooms, and a reader who can zoom will. A single level that
never refines tells them their input did nothing.

You have `query` and the whole catalog while you work, so a second level is
a second query and a second `addTileLevel` call — not a limitation of the
template, and not something you need anyone's permission for. **The levels
named in your prompt are a floor, not a ceiling.** A request phrased "by
county" is a request for a map of the measure; if that measure is also
published by tract, the map is better with tracts under the counties, and
building it that way is the job rather than a liberty.

**If the rows are there, add the level.** That is the default, and it does
not need a reason. Leaving them out is the exception, and there are exactly
three that count:

- **It is not published.** Many series stop at county — most BLS and BEA
  measures do, as does ACS 1-year for all but the largest areas. You know
  this because you queried and the rows were not there.
- **It is not defined at that level.** A county unemployment rate is not
  the average of anything smaller.
- **You measured it and it is too noisy to mean anything.** Small-area
  estimates get unreliable before they get unavailable: a tract-level ACS
  median can carry a margin of error rivalling the value, and drilling into
  noise is not detail.

That third one is a real reason and it is also the easy lie, so it comes
with a condition: **you may only claim it if you measured it, and the
number goes in `NOTES.md`.** Query the share of features whose margin of
error exceeds some fraction of the estimate, and write the figure you got.
A sentence like "margins of error often exceed 50% of the estimate" with no
query behind it is a fabrication, and it is worse than shipping the coarser
map, because the next builder believes it.

So: query for it, and when you leave it out, name which of the three
reasons applies in one line in `NOTES.md`, with the number if it is the
third. What is not acceptable is not having looked, and what is less
acceptable is having looked and written a reason you did not check.

**Never add a level you have no values for.** Under the no-data rule those
features are transparent, so it renders as a layer that silently blanks the
map on zoom.

Pair levels that are actually far apart. Adjacent published levels hand
over almost immediately — states are cut off where counties begin, which on
a national map is within the first few zooms — so a state-plus-county map
is a county map with a brief state phase nobody sees. County plus tract is
a real two-level map.

## Published geography

Already tiled on our origin. Add by name with `addTileLevel`; nothing to
download, stage, or attribute beyond the source line below.

| level | covers | complete from | join key | id field | years |
|---|---|---|---|---|---|
| `census.state` | US states | z0 | 2-char string | `GEOID` | any |
| `census.county` | US counties | z3 | 5-char string | `GEOID` | any |
| `census.tract` | US census tracts | z8 | 11-char string | `GEOID` | 2010– |
| `census.blockgroup` | US block groups | z10 | 12-char string | `GEOID` | 2010– |

Source: US Census Bureau TIGER/Line — 2024 for data from 2021 on, 2019 for
older data, except `census.blockgroup` at 2021+, which is the ACS 2020–2024
vintage. `addTileLevel` picks by year; name the vintage it picked in your
attribution.

### Vintage: the year argument is not optional and not a preference

Census tracts and block groups are **redrawn at every decennial** and
counties change between them, so a GEOID only means something against the
generation it was issued in. Delaware has 218 tracts in the 2019 ACS and 262
in the 2023, and only 179 ids are in both. Draw 2019 data on 2024 boundaries
and 39 areas disappear, 83 more stay blank, and the rest are painted onto
shapes that in places have moved — and every one of those is silent, because
a feature state set for an id the tiles do not have is a no-op and a feature
no row reached is transparent by design.

So pass the year of the data, and for a multi-year ACS release pass the end
year: 2015–2019 is `2019`. `addTileLevel` resolves it to a generation, and a
year older than anything published throws rather than falling back.

`setValues` then checks every id against that generation's published list
and returns a report:

```ts
const join = await setValues(map, LEVEL, rows, 'geoid', 'value')
join.rows // rows handed in
join.matched // rows that will paint
join.unmatched // rows whose GEOID is not in this generation
join.unmatchedSample // up to ten of them
```

Past 2% unmatched it **throws** and the artifact shows the error instead of
the map, because a choropleth missing a fifth of its areas still looks like
a finished map. Below that it warns. Either way the number goes in
`NOTES.md`, and a non-zero one is worth understanding before you ship:
usually it means the year is wrong, occasionally it means the ids are a
different level, and for county data before 2019 it is a genuine handful
(Bedford City VA, Shannon County SD, Valdez-Cordova AK) that no published
generation covers.

**Two levels can be two different years only if the data is.** They resolve
independently, so pass each its own data's year.

**The tiles already carry names.** Every feature has a name property, and
`levelNameField(level)` returns which one, so a tooltip reads it straight
off the feature:

```ts
const nameField = levelNameField(LEVEL)
feature.properties[nameField] // "Santa Clara County"
```

Tract and block group names are fully qualified — "Block Group 1, Census
Tract 401, Kent County, Delaware" — because the stock Census names repeat
in every county in the country and a tooltip reading "Census Tract 401"
identifies nothing.

So your values do not need a name column, and you must not go looking for
one. Do not download a gazetteer, do not hand-write a FIPS-to-name table,
and do not fetch the place search index — it is the search box's private
index, not a lookup table, and it is not published for this. If the rows
you were given are ids and numbers, that is enough to build the map: the
tiles supply the names, at every level, for free.

This applies to the map. Your written findings are prose you compose
yourself, and the values behind them usually have no names attached — ACS
fact tables carry `GEO_ID` and nothing else. Describe what the map shows
in terms you can actually support, and leave naming individual features to
the tooltip, which does it correctly for every one of them.

**"Complete from" is measured, not chosen, and it is the one number here
that will bite you.** The archives were built with tippecanoe's
`--drop-densest-as-needed`, so below its threshold a level does not vanish
— it thins, densest first, so the features that disappear are concentrated
in exactly the urban areas a map is usually about. A half-drawn map still
looks like a map. `census.blockgroup` is worse: below z10 neighbouring
features are *merged*, so a low-zoom feature carries one member's
attributes over a combined shape, which is silently wrong rather than
visibly sparse. `addTileLevel` sets each layer's zoom range for you, so a
level simply does not draw below its threshold.

The consequence: **a national tract map needs counties underneath it.**
Tracts alone cannot open at national zoom — they are incomplete below z8,
and 84,000 of them across a continent is about twelve pixels each. Two
levels is the answer, not one: counties at national zoom, tracts from z8,
with the handover automatic. That is a tract map, and it is the one to
build whenever the measure exists at tract level.

Anything not in this table you bring yourself.

## The basemap

A grayscale Protomaps basemap — roads, water, place names — is already
under every map, wired in `src/lib/basemap.ts`. You do not add it, style
it, or switch it off. `addTileLevel` inserts its layers above the basemap's
land and water but below its labels, so place names stay legible through a
fill; do the same with `beforeId` when you add layers yourself.

What this asks of your paint, and it is the whole of what it asks:

- **Keep fills around 0.75 opacity.** An opaque layer hides the basemap
  completely, at which point there was no reason to have one.
- **Give features with no value opacity 0, not a grey fill.** Over a wide
  extent most of the map is outside any result set, and painting it grey
  erases the basemap everywhere it matters most. Bare basemap *is* the
  no-data state, and it reads as one.

The basemap is pinned to the grayscale theme and does not follow the app's
light/dark setting. Themes differ by whole layers rather than colours
alone, so switching one at runtime means `setStyle`, and `setStyle`
discards all feature state — every value the map is painting. A neutral
basemap under a coloured measure is also simply the better cartography.

**The extract covers the United States only.** There is no basemap outside
it, at any zoom. A map of anywhere else will draw your data over blank
space, which is a template limitation to report rather than work around.

## The search box

Every map gets one, wired in `src/lib/search.ts`. It downloads a small
index from `geo.nugget.bot` on the first keystroke and flies the viewport to
whatever is chosen. You do not add it or configure it, and it cannot be
turned off.

It moves the map and nothing else. It does not select a feature, so what is
on screen and the thing searched for need not agree.

It is not a geocoder, and saying otherwise in your README will be wrong. It
holds US states, every US county, the 5,000 largest US places, and a
curated alias list — no addresses, no ZIP codes, no neighbourhoods, and
nothing outside the United States. Typos and prefixes work (`brookyln`,
`san fran`); initialisms work only where someone put them in the alias list
(`SF`, `NYC`, `Bay Area`). Ranking is by population, which is what makes
`Springfield` mean Missouri and `Portland` mean Oregon.

## Colour

Every colour is a token in the `:root` block of `src/style.css`, carrying a
light and a dark value in a `light-dark()` pair.

MapLibre paints through WebGL and needs real colours, so — unlike every
other template — this one reads tokens into JavaScript, through `token()`
and `ramp()` in `src/lib/theme.ts`. A value read that way is frozen at the
theme it was read in, so anything painted from a token must be repainted
when the theme changes:

```ts
function paint() { /* every setPaintProperty */ }
paint()
onThemeChange(paint)
```

Never hard-code a hex, and never add a `prefers-color-scheme` rule — the
theme is the app's to decide, not the operating system's.

- `sequential`, steps 1–6 — one ordered measure, dark to light. Reverse it
  so low values read pale.
- `secondary` — the same ramp in blue.
- `diverging` — orange through pale to blue, for a measure with a
  meaningful midpoint.
- `categorical` — unordered categories. Beyond six, group the tail into
  "Other".

`--ink`, `--muted`, `--grid`, `--axis` cover text and rules. `--surface` is
the right stroke between adjacent features. Missing data is the one case
where this template departs from the others: leave it transparent and let
the basemap show through, rather than filling it with `--grid`.

## The scale

Three rules, wherever a measure becomes a colour. They exist because the
same failure keeps recurring: zoom into a dense metro and every feature is
the identical dark colour, because the scale spent its whole palette on a
range the visible features are all past the end of.

**Interpolate, do not bin.** Use an `interpolate` expression, not `step`.
Bins throw away every distinction inside a bin, and the top bin is always
the widest, so it is exactly the interesting tail that gets flattened.

**Derive the endpoints from the data.** The 2nd and 98th percentiles, never
round numbers you chose. Hard-coding `$50k` … `$100k+` guarantees that
anywhere above $100k renders as one colour. Percentiles also stop a single
outlier from claiming an end of the ramp; anything beyond them clamps,
which costs nothing the map was going to show.

**Match the transform to the measure.** The example's `SCALE` constant:

- `log` for multiplicative, right-skewed measures — money, counts,
  densities, populations. $30k to $60k is a far bigger difference than
  $200k to $230k, and linear spacing gives them the same amount of colour.
  This is usually the one you want.
- `linear` for measures already on a bounded or additive scale — rates,
  percentages, indices, differences. Log distorts those for nothing, and
  cannot represent zero or negatives at all.

## Rendering

- The artifact sits in an iframe whose height follows its content, so
  `#map` is sized by `aspect-ratio` in `style.css`. Never use `vh` or `vw`.
- Frame the map with `fitRegion(map, bounds)` against the area you are
  actually showing, and use `CONTINENTAL_US` for a national one. For point
  data, compute the bounds from the rows. **Never set a literal zoom** —
  no `jumpTo({ zoom })`, no `zoom` in the map options. The reader controls
  the width of the panel this is shown in, and a zoom that frames the
  country at 900px clips it at 400px. Bounds are what you actually know;
  the zoom that satisfies them depends on a viewport you cannot see.
  `fitRegion` also re-fits when the panel is resized, and stops doing so
  the moment the reader pans, zooms, or picks a search result.
- Put no title in the frame; the artifact title is rendered outside it.
- No outer border, background, gradient, or shadow.
- Rotation and pitch are disabled in `main.ts`. A statistical map has no
  reason to leave plan view.

## Legend, tooltip, attribution

Every non-obvious encoding needs a legend, and the legend must describe the
actual breaks. A continuous ramp needs a continuous legend: a gradient bar
with labelled ticks, not swatches. Label the ends and the middle at
minimum, and let the uneven number spacing of a log scale show in the
labels. If you encode by circle size, the size needs a legend too.

Add a tooltip wherever a reader needs the exact value or the name of a
place. Attribution is required by the geometry licence, belongs below the
map, and must name the geometry source and its vintage, plus OpenStreetMap
for the basemap.

## NOTES.md

Replace the example's notes with this artifact's. The next builder needs
what they cannot read off the code: which geography and vintage, the year
you passed to `addTileLevel` and why, the join key and the unmatched count
from the `setValues` report, why this scale, and — when you
looked for a finer level and there wasn't one — that you looked and why
there isn't.

## Before submitting

Call `renderArtifact` and inspect the image and the console. Verify that:

- The map shows the requested geography and frames it at both a wide and a
  narrow panel width.
- Where you painted published levels, the join was on the id field as a
  string with leading zeroes intact, you passed the year of the data to
  `addTileLevel`, and you read the unmatched count off the `setValues`
  report rather than assuming it was zero.
- You considered a finer level, and either added it or recorded in
  `NOTES.md` why there isn't one.
- Missing values are transparent, not filled, and read as absent rather
  than as a low value.
- The basemap is visible through your layers and its labels sit on top.
- The legend matches the encoding — real values, whose ends are the
  percentiles actually painted — and the tooltip shows correct values.
- Zoomed into the densest part of the map, features are still
  distinguishable from one another rather than a single flat colour.
- Attribution names the geometry source and OpenStreetMap.
- There are no page errors, failed requests, or console warnings. A failed
  tile request is invisible on the map and fatal to its meaning.
