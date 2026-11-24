# Victoria Votes 2026

Independent, table-first tracker for Victoria's Legislative Assembly election on Saturday 28 November 2026. It covers all 88 districts, party first preferences, provisional 2CP leads, declarations, a browser-local watchlist and voting-centre drill-downs. The majority threshold is 45 seats.

District and booth tables use abbreviated, party-coloured headers and pinned name cells. Click a party heading to sort by its result. The booth table can switch between counts and shares for first preferences and TCP. Swing stays in percentage points.

Choose **Maximise booth table** for a full-width view with an electorate selector. Search, sort and the display mode carry over when opening or closing the view, and when switching electorates. A party-column sort is specific to its electorate and resets when switching electorates.

## Preview locally

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:8888>. Use `ARCHIVE_PREVIEW=1 npm run dev` to exercise the viewer with six **labelled 2022 archive districts** while there are no live results. That mode is local only and deliberately suppresses swing. Use `npm test` for parser and calculation tests, and `npm run check:source` for a public-site smoke test. That command checks for the 2026 index first and falls back to the 2022 archive for validation only.

To preview the outlined TCP swing columns with simulated values, run `ARCHIVE_PREVIEW=1 TCP_SWING_PREVIEW=1 npm run dev` and open `/?district=bass#booths`. Only this explicitly labelled local mode offsets the archived TCP votes. The table shows Labor's side if present, otherwise Liberal's, otherwise the first candidate in the VEC's published pair.

## Deploy on Netlify

Import the repo into Netlify and publish a production deploy using `netlify.toml`. The production deploy is required for the scheduled collector to run automatically; a static upload or GitHub Pages alone cannot run the collector. No token is needed for the VEC's public pages. The scheduled collector and public API use a site-wide Netlify Blobs snapshot.

- Check `/api/results` on the deployed site. Before publication expect `status: "waiting"` and no votes. `collect` starts fetching at 6 pm Melbourne time on election day, then every five minutes over the weekend and every 15 minutes afterwards.
- On election night, run `npm run check:source` and verify the official index URL and district links, a district with a published 2CP pair, and a district with booth results. Check `collect` logs on Netlify and compare the deployed dashboard against the corresponding public pages. The 2026 result markup could not be verified before publication. If the index moves within the same official results section, set `VEC_RESULTS_PATH` to the verified 2026 path on `www.vec.vic.gov.au`; changes to markup or origin will require updating `lib/vec.mjs`.
- The service only fetches recognised links on the VEC origin. The collector uses bounded concurrency and shared snapshots; a district's booth view fetches the linked first-preference and TCP voting-centre pages, when available, with CDN caching. Missing or unrecognised pages are surfaced explicitly. Old district rows can be retained and marked stale after a partial read and are excluded from that snapshot's statewide totals. A wholesale outage keeps the last available snapshot labelled stale.
- Share `/?demo=1` for a populated review of six districts, or `/?demo=1&district=bass&view=booths&units=swing` to jump to booth swings. This labelled browser-only demo derives simulated counts from the bundled archive and never calls the live results API. The regular URL uses the live feed. Commit the generated JSON files under `public/data/`; the deployment does not regenerate them.

## 2022 booth baseline

The source is the official VEC [2022 statewide lower-house recheck workbook](https://www.vec.vic.gov.au/-/media/c4665365795d431e811d0ce818e373d4.xlsx). The dashboard roster comes from the [2026 district nominations list](https://www.vec.vic.gov.au/voting/2026-state-election/find-candidates). Rebuild both with `python3 scripts/build-baseline.py`, or check the versioned data with `python3 scripts/build-baseline.py --check`. The historical file contains the workbook SHA-256. Narracan has a 2026 district page but no baseline in this workbook: its election was held separately.

Matches require a unique normalised booth label within the same district and vote category. Early and ordinary voting stay separate. No fuzzy match, booth address verification, or boundary reconstruction is applied. Votes from unmatched booths, mobile and pooled/declaration categories are excluded from both matched denominators; informal votes never enter a party share. Independent votes stay in denominators, but the dashboard does not equate independent candidates across elections. The display reports matched venues and their share of formal votes in the displayed venue rows. Nothing is inferred about outstanding votes or winners from the swing estimate.

The separate TCP baseline is rebuilt with `node scripts/build-tcp-baseline.mjs` from the official result-by-voting-centre pages linked from each 2022 district. It has 1,729 election-day venues and pooled early TCP for all 87 archive districts. TCP shares use only votes for the two candidates. Swing requires the same two sides, matched by party (including across candidate changes) or by candidate name for independents. A changed pair or withheld TCP gives a dash. A TCP-page failure does not suppress first preferences.

### Venue matching sources

- **2022:** The VEC's archived results provide district and booth labels. The Tally Room's [2022 polling places workbook](https://drive.google.com/file/d/1BQRuU-tP8erXJOVxP6jQ9QWZ4qyE4TB7/view) adds venue names, street addresses and latitude/longitude. The VEC's public 2022 polling-location XML provides IDs and names, but no addresses; the VEC's 2022 GeoJSON files describe electoral boundaries.
- **2026:** The VEC's [public venues workbook](https://www.vec.vic.gov.au/-/media/19326aa361284a49a69b08194421da96.xlsx) provides district assignments, voting-location labels, premises and addresses. The [public venue locator API](https://maps.vec.vic.gov.au/api/votingcentres/70531e1c-b7e4-4f29-8875-54df0146c356/) supplies `venueId`, premises, address, latitude/longitude and host district without browser cookies. In a spot check, each request returned only 100 election-day centres; queries centred on different locations returned different sets. Treat it as a coordinate source and check coverage against the workbook. Join premises and addresses back to the workbook to recover result labels and joint-centre district assignments. The [electorate endpoint](https://maps.vec.vic.gov.au/api/electorates/1) lists all 88 district IDs and names.

The booth table uses a unique same-name comparison first unless a site move was flagged, then a nearby or weighted estimate, then the historical district's pooled votes of the same voting type. The Swing view names the first-preference baseline used; TCP estimates carry a tilde and tooltip. Early booths use pooled historical early TCP as a district proxy, and a different TCP pairing still has no swing. Narracan compares against its official January 2023 supplementary election. District proxies and spatial estimates are per-booth comparisons and should not be summed.

The district first-preference table's **Matched swing** compares only reporting booths that have a unique historical booth match of the same voting type. Flagged moves, estimates and proxies are excluded. Each year's party shares are calculated from the sum of votes for the same matched set; Votes and Share still use the full current district count.

Run `python3 scripts/audit-booth-matching.py --map-snapshot booth-map-snapshot.json` for an election-day audit based on the Longman approach. It reports distances and weights in `booth-match-audit.csv`, with weighted first-preference counts and comparable historical TCP counts in `booth-match-estimates.json`. A clear match within 500 m can receive 100%; a lone neighbour out to 5 km is marked as an estimate. For similarly distant sites the script blends at most three neighbours using normalised inverse-distance weights. These are local booth baselines; the same historical booth can inform more than one estimate, so the resulting counts must not be added across booths. The generated files are local review outputs, not dashboard inputs.

Add `--coordinates-only` to select 2022 baselines exclusively by location within the same district, without a same-name preference or fallback. Results go to the `-coordinates` CSV and JSON files. Each year's venue metadata still needs to be joined to that year's booth labels to attach coordinates to vote records.

After running both audits, run `node scripts/build-booth-comparisons.mjs` to regenerate the compiled comparison data, including flags for moved labels and the Narracan supplementary results.
