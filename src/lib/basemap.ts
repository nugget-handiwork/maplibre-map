import type { StyleSpecification } from 'maplibre-gl'
import { labels, noLabels } from 'protomaps-themes-base'
import { GEO_BASE } from './geography'

// The Protomaps basemap, extracted to the US at zoom 12 and mirrored on our
// own origin beside the census tiles. It is reference, not data: roads,
// water, and place names exist so a viewer can tell which part of the
// country a polygon belongs to.

// Pinned deliberately. Newer extracts publish under a new path rather than
// replacing this one, so an existing map keeps rendering exactly what it
// was built against until this constant moves. The archive's major version,
// the sprite set, and protomaps-themes-base's major must agree — all three
// are v4 here.
const ARCHIVE = 'basemap/v4.15.2-20261115.pmtiles'
const SOURCE = 'protomaps'

// Grayscale rather than light or dark, and pinned rather than following the
// app's theme. A choropleth carries the only colour that means anything, so
// a neutral basemap keeps the ramp legible; and swapping themes at runtime
// would mean setStyle, which discards all feature state — that is to say,
// every value the map is painting.
const THEME = 'grayscale'

export const BASEMAP_ATTRIBUTION = '© OpenStreetMap contributors'

export function basemapStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: `${GEO_BASE}/basemap/assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${GEO_BASE}/basemap/assets/sprites/v4/${THEME}`,
    sources: {
      [SOURCE]: {
        type: 'vector',
        url: `pmtiles://${GEO_BASE}/${ARCHIVE}`,
      },
    },
    // Labels are added here, above the basemap's own fills, and the census
    // layers insert between the two — see addTileLevel. Adding them after
    // the choropleth instead would leave the map briefly unlabelled while
    // the values load.
    layers: [
      ...noLabels(SOURCE, THEME),
      ...labels(SOURCE, THEME, 'en'),
    ],
  }
}
