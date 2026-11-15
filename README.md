# MapLibre map

A zoomable, pannable map over a grayscale basemap, with a place search box,
a legend, and hover tooltips. It draws choropleths over published boundary
tiles, and point and heatmap layers over data of its own.

The example it ships with is a choropleth of an illustrative measure across
the nine San Francisco Bay Area counties. The sample values in
`data/DATA_FILE.json` join to Census county boundaries by five-character
`GEOID`; both sides are strings so leading zeroes survive. `src/map.ts`
loads the values, adds the county tile layer, joins the two through feature
state, and paints, legends, and labels the result. `src/style.css` holds
the palette and the map, legend, and tooltip styles.

Boundaries are served as PMTiles from `geo.nugget.bot`, mirrored from the US
Census Bureau's TIGER/Line 2024 release, over a grayscale Protomaps basemap
from the same origin. Counties beyond the Bay Area carry no sample value
and are left transparent, showing the basemap underneath.
