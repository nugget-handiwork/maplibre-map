import type { LngLatBoundsLike, Map as MapLibreMap } from 'maplibre-gl'

// Published boundaries, mirrored as PMTiles archives on our own origin and
// read by range request. Geometry in these archives is static, so it is
// never queried: it arrives as tiles, and SQL supplies only the values
// painted onto it.
//
// Levels are named family-first so the catalogue can grow without the
// names colliding — a census tract and a postal district are both
// boundaries, and only one of them has a GEOID.

export const GEO_BASE = 'https://geo.nugget.bot'

export type TileLevel =
  | 'census.state'
  | 'census.county'
  | 'census.tract'
  | 'census.blockgroup'

// A geography GENERATION: one set of boundaries, and the first data year it
// applies to. Census tracts and block groups are redrawn at every decennial
// and counties change between them, so a GEOID is only meaningful against
// the generation it was issued in. Delaware has 218 tracts in the 2019 ACS
// and 262 in the 2023, sharing 179 ids — a 2019 map drawn on 2020
// boundaries silently drops 39 areas, leaves 83 blank, and paints the rest
// onto shapes that in places have moved.
//
// Generations are listed oldest first and selected by the data's year: the
// last one whose `fromYear` is not in the future of it wins. A year older
// than the first generation is an error rather than a fallback, because
// falling back to the newest is precisely the silent failure.
interface Generation {
  fromYear: number
  archive: string
}

// `minZoom` is the zoom at which a level is COMPLETE, and it is measured
// rather than chosen. The published archives were built with tippecanoe's
// --drop-densest-as-needed, so below these zooms features are missing —
// and missing densest-first, which means the omissions are concentrated in
// exactly the urban areas a choropleth is usually about. Counting distinct
// GEOIDs against known totals: San Francisco returns 1 of its 244 tracts
// at z4, 15 at z6, 123 at z7, and all 244 from z8; its block groups reach
// their full 680 only at z10; California returns all 58 counties from z3.
//
// The archives built here from TIGER/Line are tiled over exactly this band
// with no tile size limit, so nothing is ever dropped from them and they
// are complete from their minZoom by construction. The number is the same
// either way, which is what lets one entry cover every generation.
//
// The resulting map is partial, not empty, which is the failure worth
// guarding against — a half-drawn choropleth still looks like a map. Every
// layer added through addTileLevel carries its level's minZoom so
// MapLibre declines to draw an incomplete level at all.
//
// `maxZoom` is the other end: the zoom past which a level has nothing left
// to say. Counties do not get more informative at z12, but the basemap
// underneath keeps resolving until individual streets are showing through
// a polygon the size of a city, which reads as detail the data does not
// have. The map's own maxZoom is set from the finest level actually added,
// so a county-only map simply stops before that.
//
// The two bands overlap deliberately — a level is complete before the next
// one stops being useful — so they are not the zoom range a layer gets.
// addTileLevel narrows each level to end where the next finer one
// present begins, because two levels drawing at once means two 0.75 fills
// stacked, and stacked fills are opaque.
const LEVELS: Record<
  TileLevel,
  {
    generations: readonly Generation[]
    // The layer name inside the archive, which carries no family prefix.
    sourceLayer: string
    idField: string
    minZoom: number
    maxZoom: number
    // The property to show a reader. Tracts and block groups carry a
    // composed DISPLAY_NAME because their stock names repeat: "Block Group
    // 1" is in every tract in the country, and "Census Tract 401" is in
    // hundreds of counties.
    nameField: string
  }
> = {
  // State boundaries have not changed over any year we hold data for.
  'census.state': {
    generations: [{ fromYear: 0, archive: 'census/census-2024/state.pmtiles' }],
    sourceLayer: 'state',
    idField: 'GEOID',
    minZoom: 0,
    maxZoom: 6,
    nameField: 'NAME',
  },
  // Counties change a few at a time rather than in a redraw, so one
  // generation covers everything up to Connecticut's replacement of its
  // eight counties with nine planning regions, which lands in the 2022
  // releases. The older archive is TIGER 2019 and is a handful of features
  // wrong before then — Bedford City VA through 2012, Shannon County SD
  // through 2014, Valdez-Cordova AK through 2018. Those report as
  // unmatched rather than vanishing, which is the point.
  'census.county': {
    generations: [
      { fromYear: 0, archive: 'census/tiger-2019/county.pmtiles' },
      { fromYear: 2022, archive: 'census/census-2024/county.pmtiles' },
    ],
    sourceLayer: 'county',
    idField: 'GEOID',
    minZoom: 3,
    maxZoom: 9,
    nameField: 'NAMELSAD',
  },
  // The 2020 Census redraw reaches ACS with the 2021 releases, not the
  // 2020 ones. 2005-2009, the only release built on 2000 tracts, has no
  // archive: it would be one more generation here and one more row in
  // load_geo.sh's CENSUS_TARGETS.
  'census.tract': {
    generations: [
      { fromYear: 2010, archive: 'census/tiger-2019/tract.pmtiles' },
      { fromYear: 2021, archive: 'census/census-2024/tract.pmtiles' },
    ],
    sourceLayer: 'tract',
    idField: 'GEOID',
    minZoom: 8,
    maxZoom: 13,
    nameField: 'DISPLAY_NAME',
  },
  // The current generation is published against the ACS 2020-2024 vintage
  // rather than plain TIGER 2024, and was built with
  // --coalesce-densest-as-needed as well as --drop-densest-as-needed:
  // below z10 neighbouring block groups are MERGED, so a low-zoom feature
  // carries one member's attributes over a combined shape. That is
  // silently wrong rather than visibly sparse.
  'census.blockgroup': {
    generations: [
      { fromYear: 2010, archive: 'census/tiger-2019/blockgroup.pmtiles' },
      { fromYear: 2021, archive: 'census/acs-2020-2024/blockgroup.pmtiles' },
    ],
    sourceLayer: 'blockgroup',
    idField: 'GEOID',
    minZoom: 10,
    maxZoom: 14,
    nameField: 'DISPLAY_NAME',
  },
}

// The generation each level was added at, so setValues joins against the
// geometry actually on the map rather than against a year passed twice.
const added = new WeakMap<MapLibreMap, Map<TileLevel, Generation>>()

function resolveGeneration(level: TileLevel, year: number): Generation {
  const { generations } = LEVELS[level]
  const generation = generations
    .filter((candidate) => candidate.fromYear <= year)
    .at(-1)
  if (generation === undefined) {
    throw new Error(
      `${level} has no published boundaries for ${year}: the oldest ` +
        `generation starts at ${generations[0].fromYear}. Drawing it on a ` +
        `later generation's tiles would join a minority of the ids and ` +
        `drop the rest without saying so.`,
    )
  }
  return generation
}

// Alaska and Hawaii are deliberately outside this. Including them spans
// 180 degrees of longitude to show two states, and leaves the other
// forty-eight in a third of the frame. A national map that needs them
// wants insets, which is a d3-map job.
export const CONTINENTAL_US: LngLatBoundsLike = [
  [-125.0, 24.4],
  [-66.9, 49.4],
]

// Frame the map on a region and keep it framed.
//
// Never set a literal zoom instead. The artifact is shown in a panel whose
// width the reader controls, and a zoom that frames the country at 900px
// clips it at 400px. Bounds are the thing that is actually known; the zoom
// that satisfies them is a function of a viewport size this code cannot
// see.
//
// MapLibre observes the container and resizes the canvas, but a resize
// preserves centre and zoom, so the view has to be recomputed here. It is
// recomputed only while the camera is still where the last fit left it: as
// soon as the reader pans, zooms, or picks a search result, the map is
// theirs and a later resize must not yank it back.
export function fitRegion(
  map: MapLibreMap,
  bounds: LngLatBoundsLike,
  padding = 20,
): void {
  let applied: { longitude: number; latitude: number; zoom: number } | undefined

  function apply(): void {
    map.fitBounds(bounds, { padding, animate: false })
    const center = map.getCenter()
    applied = {
      longitude: center.lng,
      latitude: center.lat,
      zoom: map.getZoom(),
    }
  }

  apply()

  new ResizeObserver(() => {
    if (applied === undefined) return
    const center = map.getCenter()
    if (
      center.lng !== applied.longitude ||
      center.lat !== applied.latitude ||
      map.getZoom() !== applied.zoom
    ) {
      applied = undefined
      return
    }
    apply()
  }).observe(map.getContainer())
}

export function levelMinZoom(level: TileLevel): number {
  return LEVELS[level].minZoom
}

export function levelNameField(level: TileLevel): string {
  return LEVELS[level].nameField
}

// The choropleth belongs above the basemap's land and water but below its
// labels — covering the place names would defeat the point of having a
// basemap at all. Every label layer is a symbol layer and they are added
// last, so the first one marks the boundary. Returns undefined when no
// basemap is present, which appends as before.
function firstLabelLayer(map: MapLibreMap): string | undefined {
  return map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id
}

// Adds the source plus a fill layer and a hairline boundary layer, and
// returns their ids so the caller can set their paint. The source promotes
// the level's id field to the feature id, which is what makes setValues
// able to address a feature that has not loaded yet.
//
// `year` is the year of the DATA, not a preference: it chooses which
// generation of boundaries the ids in that data were issued against. For a
// multi-year ACS release it is the end year, so 2015-2019 is 2019. It has
// no default, because every wrong answer here renders as a plausible map.
export function addTileLevel(
  map: MapLibreMap,
  level: TileLevel,
  year: number,
): { fillLayer: string; lineLayer: string } {
  const { sourceLayer, idField, minZoom } = LEVELS[level]
  const generation = resolveGeneration(level, year)
  const beforeId = firstLabelLayer(map)

  let generations = added.get(map)
  if (generations === undefined) {
    generations = new Map()
    added.set(map, generations)
  }
  generations.set(level, generation)

  map.addSource(level, {
    type: 'vector',
    url: `pmtiles://${GEO_BASE}/${generation.archive}`,
    promoteId: idField,
  })

  map.addLayer(
    {
      id: `${level}-fill`,
      type: 'fill',
      source: level,
      'source-layer': sourceLayer,
      minzoom: minZoom,
    },
    beforeId,
  )

  map.addLayer(
    {
      id: `${level}-line`,
      type: 'line',
      source: level,
      'source-layer': sourceLayer,
      minzoom: minZoom,
    },
    beforeId,
  )

  // Derived from every level present rather than just this one, so adding
  // tracts to a county map hands county over at z8 and widens the map's
  // range to z13, without the caller saying so. Sorted coarse to fine,
  // which for levels that nest is the same as sorted by minZoom.
  const present = (Object.keys(LEVELS) as TileLevel[])
    .filter((each) => map.getSource(each))
    .sort((left, right) => LEVELS[left].minZoom - LEVELS[right].minZoom)
  map.setMaxZoom(Math.max(...present.map((each) => LEVELS[each].maxZoom)))

  // A layer's maxzoom is exclusive — MapLibre hides it at that zoom, not
  // past it — which is what makes it the right way to hand over to a finer
  // level at exactly the zoom that level begins. It is also why the finest
  // level gets no upper bound at all: its band ends where the camera does,
  // and a maxzoom equal to the camera's limit would blank the map at full
  // zoom rather than at no zoom the reader can reach.
  present.forEach((each, index) => {
    const finer = present[index + 1]
    const upperZoom = finer === undefined ? 24 : LEVELS[finer].minZoom
    map.setLayerZoomRange(`${each}-fill`, LEVELS[each].minZoom, upperZoom)
    map.setLayerZoomRange(`${each}-line`, LEVELS[each].minZoom, upperZoom)
  })

  return { fillLayer: `${level}-fill`, lineLayer: `${level}-line` }
}

// Every GEOID in a generation, published next to its archive. Small enough
// to fetch alongside the tiles — a few hundred kilobytes gzipped for the
// 84,000 tracts — and cached immutably like everything else on the origin.
const manifests = new Map<string, Promise<ReadonlySet<string>>>()

function generationIds(archive: string): Promise<ReadonlySet<string>> {
  let ids = manifests.get(archive)
  if (ids === undefined) {
    const url = `${GEO_BASE}/${archive.replace(/\.pmtiles$/, '.geoids.txt.gz')}`
    ids = fetch(url).then(async (response) => {
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`)
      }
      return new Set((await response.text()).split('\n').filter(Boolean))
    })
    manifests.set(archive, ids)
  }
  return ids
}

export interface JoinReport {
  /** Rows handed to setValues. */
  rows: number
  /** Rows whose id exists in this generation, and so can be painted. */
  matched: number
  /** Rows whose id does not exist in this generation. */
  unmatched: number
  /** Up to ten unmatched ids, for working out why. */
  unmatchedSample: string[]
  /** Features in the generation, matched or not. */
  features: number
}

// A join is wrong in the same way twice over and neither half announces
// itself: setFeatureState against an id the tiles do not have is a silent
// no-op, and a feature no row reached is painted at opacity 0, which is
// indistinguishable from being outside the result set on purpose. So the
// ids are checked against the generation's published manifest instead of
// against the tiles, which arrive lazily and only for the current view.
//
// Past a small fraction unmatched this throws rather than returning, and
// the artifact frame shows the message: a choropleth missing a fifth of
// its areas still looks like a finished map, and shipping one is worse
// than shipping none. Below that it warns and returns the count, which
// belongs in NOTES.md either way.
const UNMATCHED_LIMIT = 0.02

export async function setValues<RowType extends object>(
  map: MapLibreMap,
  level: TileLevel,
  rows: readonly RowType[],
  idKey: keyof RowType & string,
  valueKey: keyof RowType & string,
): Promise<JoinReport> {
  const generation = added.get(map)?.get(level)
  if (generation === undefined) {
    throw new Error(`${level} was not added with addTileLevel`)
  }
  const ids = await generationIds(generation.archive)

  const unmatched: string[] = []
  let matched = 0
  for (const row of rows) {
    const id = row[idKey]
    if (id == null) continue
    const geoid = String(id)
    if (!ids.has(geoid)) {
      unmatched.push(geoid)
      continue
    }
    matched += 1
    // Feature state lives on the source and is keyed by id, so state set
    // for a GEOID whose tile has not loaded is retained and applied when
    // it does. That is why the whole result set can be pushed in once at
    // load and left alone while the viewer pans.
    map.setFeatureState(
      {
        source: level,
        sourceLayer: LEVELS[level].sourceLayer,
        id: geoid,
      },
      { value: row[valueKey] },
    )
  }

  const report: JoinReport = {
    rows: rows.length,
    matched,
    unmatched: unmatched.length,
    unmatchedSample: unmatched.slice(0, 10),
    features: ids.size,
  }

  if (unmatched.length > 0) {
    const share = unmatched.length / rows.length
    const message =
      `${level}: ${unmatched.length} of ${rows.length} rows ` +
      `(${(share * 100).toFixed(1)}%) carry a GEOID that does not exist in ` +
      `${generation.archive}. Either the year passed to addTileLevel does ` +
      `not match the year of the data, or the ids are not this level's. ` +
      `Unmatched: ${report.unmatchedSample.join(', ')}`
    if (share > UNMATCHED_LIMIT) throw new Error(message)
    console.warn(message)
  }

  return report
}
