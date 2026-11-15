import type { IControl, Map as MapLibreMap } from 'maplibre-gl'
import { GEO_BASE } from './geography'

// Place search. The index is a single gzipped file on our own origin —
// states, every county, the five thousand largest places, and a curated
// list of names the Census has no concept of — scanned in memory.
//
// It is deliberately not a geocoder. There are no addresses, no ZIP codes,
// and no neighbourhoods in it, because a choropleth reader is looking for
// the polygon their data is about, not for a street corner.

// Pinned like every other path on this origin: a newer vintage publishes
// alongside rather than replacing, so this map keeps reading what it was
// built against.
const INDEX_URL = `${GEO_BASE}/index/v2024/places.json.gz`

// Ranked by population, so a scan can stop at the first good match rather
// than score all eight thousand — which is also why every tie in the
// matcher below resolves to whichever candidate came first.
interface Place {
  n: string
  s: string
  g: string
  y: number
  x: number
  z: number
  p: number
}

interface Alias {
  a: string
  n: string
  y: number
  x: number
  z: number
}

export interface Result {
  name: string
  detail: string
  latitude: number
  longitude: number
  zoom: number
}

// Both sides of every comparison pass through here. Casefold, drop
// diacritics and punctuation, and fold the abbreviations that the Census
// writes one way and people type the other — `St. Louis` against
// `saint louis` scores 0.67 on raw edit distance, worse than an unrelated
// county, so this is not cosmetic.
const ABBREVIATIONS: Record<string, string> = {
  saint: 'st',
  sainte: 'st',
  fort: 'ft',
  mount: 'mt',
  mountain: 'mtn',
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => ABBREVIATIONS[word] ?? word)
    .join(' ')
}

// Jaro-Winkler, which is the one classical metric that behaves well on
// short proper nouns: it rewards a shared prefix, so `brookyln` still
// scores 0.98 against `brooklyn`. It cannot rescue an initialism — `sf`
// scores 0.73 against `san francisco`, below plenty of wrong answers —
// which is what the curated alias list exists to handle.
function jaroWinkler(left: string, right: string): number {
  if (left === right) return 1
  if (!left.length || !right.length) return 0

  const window = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1)
  const leftMatched = new Array<boolean>(left.length).fill(false)
  const rightMatched = new Array<boolean>(right.length).fill(false)

  let matches = 0
  for (let index = 0; index < left.length; index += 1) {
    const start = Math.max(0, index - window)
    const end = Math.min(index + window + 1, right.length)
    for (let other = start; other < end; other += 1) {
      if (rightMatched[other] || left[index] !== right[other]) continue
      leftMatched[index] = true
      rightMatched[other] = true
      matches += 1
      break
    }
  }
  if (!matches) return 0

  let transpositions = 0
  let position = 0
  for (let index = 0; index < left.length; index += 1) {
    if (!leftMatched[index]) continue
    while (!rightMatched[position]) position += 1
    if (left[index] !== right[position]) transpositions += 1
    position += 1
  }

  const jaro =
    (matches / left.length +
      matches / right.length +
      (matches - transpositions / 2) / matches) /
    3

  let prefix = 0
  while (prefix < 4 && left[prefix] && left[prefix] === right[prefix]) prefix += 1
  return jaro + prefix * 0.1 * (1 - jaro)
}

// Below this a match is noise. Measured against the corpus: real typos sit
// above 0.9, and the wrong-answer floor for a query of any length is around
// 0.85, so this admits misspellings without admitting everything.
const SIMILARITY_FLOOR = 0.88

interface Index {
  places: (Place & { key: string })[]
  aliases: Map<string, Alias>
}

let loading: Promise<Index> | undefined

function load(): Promise<Index> {
  loading ??= fetch(INDEX_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`place index: HTTP ${response.status}`)
      return response.json() as Promise<{ places: Place[]; aliases: Alias[] }>
    })
    .then((data) => ({
      places: data.places.map((place) => ({ ...place, key: normalize(place.n) })),
      aliases: new Map(data.aliases.map((alias) => [normalize(alias.a), alias])),
    }))
    .catch((error: unknown) => {
      // A memoised rejection would leave the box silently inert for the
      // rest of the session; dropping it lets the next keystroke retry.
      loading = undefined
      throw error
    })
  return loading
}

// A GEOID's length is its summary level: 2 state, 5 county, 7 place. Worth
// showing, because a city and the county around it share a name often
// enough — St. Louis, Sacramento — that the state alone leaves two
// identical-looking rows.
function level(geoid: string): string {
  if (geoid.length === 2) return 'state'
  return geoid.length === 5 ? 'county' : 'place'
}

function result(place: Place): Result {
  return {
    name: place.n,
    detail:
      place.g.length === 2 ? 'state' : `${place.s} · ${level(place.g)}`,
    latitude: place.y,
    longitude: place.x,
    zoom: place.z,
  }
}

export async function search(text: string, limit = 6): Promise<Result[]> {
  const trimmed = text.trim()
  if (trimmed.length < 2) return []
  const index = await load()

  // `Portland, ME` — the part after the comma constrains the state rather
  // than joining the name being matched.
  const [namePart, statePart] = trimmed.split(',')
  const query = normalize(namePart)
  const state = statePart ? normalize(statePart) : undefined
  if (!query) return []

  // Aliases match exactly and win outright. Fuzzy-matching them would be
  // actively harmful: two-letter keys like `sf` sit within edit distance of
  // a large fraction of the corpus.
  const alias = index.aliases.get(query)
  if (alias && !state) {
    return [
      {
        name: alias.n,
        detail: '',
        latitude: alias.y,
        longitude: alias.x,
        zoom: alias.z,
      },
    ]
  }

  // Tiers, best first: exact name, then prefix, then a fuzzy match. Within
  // a tier the index's population order is preserved, which is what makes
  // `Springfield` mean Missouri and `Portland` mean Oregon.
  const exact: Result[] = []
  const prefix: Result[] = []
  const fuzzy: { hit: Result; score: number }[] = []

  for (const place of index.places) {
    if (state && normalize(place.s) !== state) continue
    if (place.key === query) exact.push(result(place))
    else if (place.key.startsWith(query)) prefix.push(result(place))
    else if (query.length >= 4) {
      const score = jaroWinkler(query, place.key)
      if (score >= SIMILARITY_FLOOR) fuzzy.push({ hit: result(place), score })
    }
    if (exact.length >= limit) break
  }

  fuzzy.sort((left, right) => right.score - left.score)
  return [...exact, ...prefix, ...fuzzy.map((entry) => entry.hit)].slice(0, limit)
}

// The control flies the viewport and does nothing else. It deliberately
// does not select a feature: the searched place and the level on screen
// need not be the same thing, so a city search on a county choropleth
// simply moves the map to that city and lets the counties draw there.
export function searchControl(): IControl {
  let container: HTMLDivElement
  let input: HTMLInputElement
  let list: HTMLDivElement
  let results: Result[] = []
  let sequence = 0

  function close(): void {
    list.replaceChildren()
    list.hidden = true
  }

  // `speed` rather than a fixed `duration`, so the flight is as long as
  // the journey deserves: MapLibre scales it by the path length, and 4 is
  // about three times the default. Measured from a Bay Area view, that is
  // 0.4s to San Jose or Sacramento and 1.4s to Boston, against 3.1s at the
  // default speed.
  //
  // Flying is not free — crossing the country requests around a hundred
  // tiles along the way and discards nearly all of them, where jumping
  // requests a dozen. The animation is worth that only because losing
  // track of where you moved costs more, and `maxDuration` bounds the
  // worst case: anything that would still run long (Puerto Rico to Alaska)
  // gives up and jumps instead of dragging.
  function go(hit: Result, map: MapLibreMap): void {
    map.flyTo({
      center: [hit.longitude, hit.latitude],
      zoom: hit.zoom,
      speed: 4,
      maxDuration: 1800,
    })
    input.value = hit.name
    close()
  }

  return {
    onAdd(map: MapLibreMap) {
      container = document.createElement('div')
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group map-search'

      input = document.createElement('input')
      input.type = 'search'
      input.placeholder = 'Search places'
      input.setAttribute('aria-label', 'Search places')

      list = document.createElement('div')
      list.className = 'map-search-results'
      list.hidden = true

      function render(hits: Result[], map: MapLibreMap): void {
        results = hits
        list.replaceChildren(
          ...hits.map((hit) => {
            const option = document.createElement('button')
            option.type = 'button'
            option.className = 'map-search-result'
            const name = document.createElement('span')
            name.textContent = hit.name
            option.append(name)
            if (hit.detail) {
              const detail = document.createElement('span')
              detail.className = 'map-search-detail'
              detail.textContent = hit.detail
              option.append(detail)
            }
            option.addEventListener('click', () => go(hit, map))
            return option
          }),
        )
        list.hidden = !hits.length
      }

      input.addEventListener('input', () => {
        // Every keystroke starts a search and the index resolves
        // asynchronously the first time, so a stale response can arrive
        // after a newer one. The sequence number discards it.
        const issued = (sequence += 1)
        void search(input.value)
          .then((hits) => {
            if (issued === sequence) render(hits, map)
          })
          .catch((error: unknown) => console.error(error))
      })

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && results.length) go(results[0], map)
        if (event.key === 'Escape') close()
      })

      input.addEventListener('blur', () => setTimeout(close, 150))

      container.append(input, list)
      return container
    },

    onRemove() {
      container.remove()
    },
  }
}
