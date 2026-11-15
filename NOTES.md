# Working notes

These notes describe the example this template ships with. Replace them
with the real artifact's, or delete the example outright — nothing in
`src/lib/` depends on it.

## What the example is

A choropleth of an illustrative measure across the nine San Francisco Bay
Area counties. `data/DATA_FILE.json` joins to the `census.county` tiles on
five-character `GEOID`, promoted to the feature id so `setFeatureState` can
address a feature before its tile has loaded. Both sides are strings, so
leading zeroes survive. The values are illustrative rather than a published
measure.

`DATA_YEAR` is 2024, which resolves counties to the TIGER 2024 generation —
the one with Connecticut's nine planning regions. All nine Bay Area counties
match, so the `setValues` report comes back with 0 unmatched; state that
number here rather than assuming it.

## Choices worth knowing before you change them

- **One level.** County only, so the map stops at z9. A second level is a
  second query and a second `addTileLevel` call, and the handover between
  them is automatic.
- **The year is the data's, not today's.** It picks which generation of
  boundaries the GEOIDs are joined against, and getting it wrong renders as
  a plausible map with areas missing. For a multi-year ACS release it is the
  end year.
- **Log spacing.** The `SCALE` constant in `map.ts`. A count is
  multiplicative and right-skewed; a rate or a percentage wants `linear`.
- **2nd and 98th percentiles** as the ramp's endpoints, so one outlying
  county cannot claim a whole end of it.
- **Counties outside the Bay Area carry no value** and are left
  transparent, which is what makes the bare basemap the no-data state.
- **ACS missing-value sentinels were removed before staging.** Negative ACS
  placeholder codes (for example `-222222222`, `-555555555`, and
  `-666666666`) are not estimates. Affected geographies therefore receive no
  feature-state value and render transparent as no data.

## If you are not building a choropleth

Delete `src/map.ts` and start from the "Modes" section of `AGENTS.md`. The
basemap, theming, framing, search, legend, tooltip, and data access all
live in `src/lib/` and `src/style.css`, and none of them are specific to
choropleths.
