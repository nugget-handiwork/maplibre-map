import { Popup, type Map as MapLibreMap } from 'maplibre-gl'
import { dataFile } from './lib/data'
import {
  addTileLevel,
  fitRegion,
  levelNameField,
  setValues,
  type TileLevel,
} from './lib/geography'
import { BASEMAP_ATTRIBUTION } from './lib/basemap'
import { onThemeChange, ramp, token } from './lib/theme'

// The sample: an illustrative measure over the nine San Francisco Bay Area
// counties, joined to Census boundaries by five-character GEOID. Replace
// the level, the file, the field names, the bounds, and the source line
// with the real ones.

const LEVEL: TileLevel = 'census.county'
const VALUE_LABEL = 'Sample measure'
const SOURCE_NAME = 'US Census Bureau TIGER/Line 2024'

// The year of the DATA, which picks the generation of boundaries its
// GEOIDs were issued against. For a multi-year ACS release this is the end
// year: 2015-2019 is 2019.
const DATA_YEAR = 2024

// How the measure is spaced across the ramp, which is a property of the
// measure and not a matter of taste.
//
// `log` for anything multiplicative and right-skewed — money, counts,
// densities, populations. The step from $30k to $60k means far more than
// $200k to $230k, and a linear ramp gives them the same amount of colour,
// which is what collapses every wealthy tract into one indistinguishable
// dark end.
//
// `linear` for anything already on a bounded or additive scale — rates,
// percentages, indices, differences, temperatures. Log would distort those
// for no reason, and it cannot represent zero or negative values at all.
const SCALE: 'linear' | 'log' = 'log'

interface ValueRow {
  geoid: string
  value: number
}

export default async function drawMap(map: MapLibreMap): Promise<void> {
  const rows = await dataFile<ValueRow[]>('DATA_FILE.json')
  if (!rows.length) throw new Error('DATA_FILE.json contained no rows')

  const { fillLayer, lineLayer } = addTileLevel(map, LEVEL, DATA_YEAR)
  // Throws when the ids and the generation disagree badly enough that the
  // map would be a partial choropleth. The count belongs in NOTES.md.
  const join = await setValues(map, LEVEL, rows, 'geoid', 'value')
  console.info(`${join.matched} of ${join.rows} rows joined`)

  const values = rows.map((row) => row.value).sort((left, right) => left - right)

  // The 2nd and 98th percentiles rather than the extremes. One outlying
  // county otherwise claims a whole end of the ramp and everything real is
  // squeezed into the middle; values beyond these clamp to the end colour,
  // which loses nothing a choropleth was going to show anyway.
  function percentile(fraction: number): number {
    const position = (values.length - 1) * fraction
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    return (
      values[lower] + (values[upper] - values[lower]) * (position - lower)
    )
  }

  // Log spacing needs a positive floor, so it is only available when the
  // data actually is positive. Falling back keeps a measure with a zero in
  // it rendering rather than turning the whole map into NaN.
  const isLogarithmic = SCALE === 'log' && values[0] > 0
  const low = isLogarithmic ? Math.max(percentile(0.02), 1e-9) : percentile(0.02)
  const high = Math.max(percentile(0.98), low * (isLogarithmic ? 1.0001 : 1) + 1e-9)

  // Stop values are spaced evenly along the transformed scale and then
  // brought back into value space, so MapLibre can interpolate linearly
  // between them on the raw number. With six stops that tracks a true log
  // curve closely enough that the difference is not visible.
  function stopValue(position: number): number {
    if (!isLogarithmic) return low + (high - low) * position
    const lowLog = Math.log10(low)
    return 10 ** (lowLog + (Math.log10(high) - lowLog) * position)
  }

  function paint(): void {
    // A sequential ramp runs dark to light, so it is reversed: low values
    // pale, high values saturated.
    const colors = ramp('sequential').reverse()
    const stops = colors.map((color, index) => ({
      value: stopValue(index / (colors.length - 1)),
      color,
    }))
    map.setPaintProperty(fillLayer, 'fill-color', [
      'interpolate',
      ['linear'],
      ['to-number', ['feature-state', 'value']],
      ...stops.flatMap((stop) => [stop.value, stop.color]),
    ])
    // Semi-transparent so the roads and water underneath still read, and
    // fully transparent where there is no value: a feature outside the
    // result set shows the basemap rather than a grey patch, which over a
    // national extent is most of the country.
    map.setPaintProperty(fillLayer, 'fill-opacity', [
      'case',
      ['==', ['feature-state', 'value'], null],
      0,
      0.75,
    ])
    map.setPaintProperty(lineLayer, 'line-color', token('surface'))
    map.setPaintProperty(lineLayer, 'line-width', 0.5)
    drawLegend(colors)
  }

  paint()
  onThemeChange(paint)

  fitRegion(map, [
    [-123.6, 36.9],
    [-121.2, 38.9],
  ])

  const popup = new Popup({
    closeButton: false,
    closeOnClick: false,
  })
  const nameField = levelNameField(LEVEL)

  map.on('mousemove', fillLayer, (event) => {
    const feature = event.features?.[0]
    if (!feature) return
    map.getCanvas().style.cursor = 'pointer'
    const value = feature.state.value
    popup
      .setLngLat(event.lngLat)
      .setHTML(
        `<strong>${feature.properties[nameField]}</strong><br>` +
          `${VALUE_LABEL}: ${
            typeof value === 'number' ? value.toLocaleString() : 'no data'
          }`,
      )
      .addTo(map)
  })

  map.on('mouseleave', fillLayer, () => {
    map.getCanvas().style.cursor = ''
    popup.remove()
  })

  // Attribution is required by the boundary source's terms and belongs
  // below the map, not in a tooltip.
  document.getElementById('attribution')!.textContent =
    `Boundaries: ${SOURCE_NAME} · Basemap: ${BASEMAP_ATTRIBUTION}`

  // A continuous ramp needs a continuous legend. The bar is evenly spaced
  // in the transformed scale, which is what makes a log ramp readable: the
  // labels below it are the values at those positions, so the uneven
  // spacing shows up in the numbers rather than in the colour.
  function drawLegend(colors: string[]): void {
    const legend = document.getElementById('legend')!
    legend.replaceChildren()
    const format = (value: number) =>
      value.toLocaleString(undefined, { maximumFractionDigits: 0 })

    const bar = document.createElement('span')
    bar.className = 'legend-bar'
    bar.style.background = `linear-gradient(to right, ${colors
      .map(
        (color, index) => `${color} ${(index / (colors.length - 1)) * 100}%`,
      )
      .join(', ')})`

    const ticks = document.createElement('span')
    ticks.className = 'legend-ticks'
    for (const position of [0, 0.5, 1]) {
      const tick = document.createElement('span')
      tick.textContent = format(stopValue(position))
      ticks.append(tick)
    }

    const caption = document.createElement('span')
    caption.className = 'legend-caption'
    caption.textContent = VALUE_LABEL

    legend.append(caption, bar, ticks)
  }
}
