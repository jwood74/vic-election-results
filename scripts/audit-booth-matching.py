"""Offline analysis of 2026 booths against the 2022 election-day baseline."""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import csv
import json
from math import asin, cos, floor, radians, sin, sqrt
from pathlib import Path
import re
import unicodedata
from urllib.parse import urlencode
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from importlib import import_module

download = import_module('build-baseline').download
ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public/data'
OLD = 'https://drive.google.com/uc?export=download&id=1BQRuU-tP8erXJOVxP6jQ9QWZ4qyE4TB7'
NEW = 'https://www.vec.vic.gov.au/-/media/19326aa361284a49a69b08194421da96.xlsx'
MAP = 'https://maps.vec.vic.gov.au/api/votingcentres/70531e1c-b7e4-4f29-8875-54df0146c356/'


def workbook(raw, sheet):
    with ZipFile(BytesIO(raw)) as z:
        strings = [''.join(i.itertext()) for i in ET.fromstring(z.read('xl/sharedStrings.xml'))]
        for row in ET.fromstring(z.read(f'xl/worksheets/sheet{sheet}.xml')).findall('.//{*}row'):
            vals = {c.get('r').rstrip('0123456789'): strings[int(v)] if c.get('t') == 's' else v
                    for c in row if (v := c.findtext('{*}v')) is not None}
            if vals:
                yield vals


def name(s):
    return ' '.join(unicodedata.normalize('NFKC', s).lower().replace('’', "'").replace('‘', "'").split())


def compact(s):
    return re.sub(r'[^a-z0-9]', '', name(s))


def km(a, b):
    lat1, lon1 = map(radians, a)
    lat2, lon2 = map(radians, b)
    h = sin((lat2-lat1)/2)**2 + cos(lat1)*cos(lat2)*sin((lon2-lon1)/2)**2
    return 12742 * asin(sqrt(min(1, h)))


def weights(ranked):
    """Ranked (distance km, old booth) tuples. Do not bridge sparse areas by default."""
    if not ranked or ranked[0][0] > 5:
        return 'no local baseline', []
    d, closest = ranked[0]
    second = ranked[1][0] if len(ranked) > 1 else float('inf')
    if (d <= .05 and second > .10) or (d <= .5 and second > .5):
        return 'close 100%', [(d, closest, 1)]
    if second > 5:
        return 'isolated 100% estimate', [(d, closest, 1)]
    # Only blend plausibly similar distances; the floor makes co-located candidates safe.
    nearby = [(dist, booth) for dist, booth in ranked[:3] if dist <= min(5, max(.1, d * 1.5))]
    if len(nearby) < 2:
        return 'ambiguous', []
    inverse = [1/max(dist,.025) for dist, _ in nearby]
    total = sum(inverse)
    return 'weighted estimate', [(dist, booth, w/total) for (dist, booth), w in zip(nearby, inverse)]


def blend(sources, votes_for):
    totals = Counter()
    for _, old_name, weight in sources:
        for party, votes in votes_for(old_name).items():
            totals[party] += weight * votes
    return dict(totals)


def map_venues(points):
    # One query for each occupied geographic tile, based on the 2022 booth footprint.
    tiles = sorted({(floor(lat/.60), floor(lon/.75)) for lat, lon in points})
    def fetch(tile):
        lat, lon = tile
        query = urlencode({'latitude': round((lat+.5)*.60, 6), 'longitude': round((lon+.5)*.75, 6)})
        return json.loads(download(MAP + '?' + query))
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = [r for batch in pool.map(fetch, tiles) for r in batch if r.get('votingCentreType') == 'Voting Centre']
    return list({row['venueId']: row for row in rows}.values()), len(tiles)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--coordinates-only', action='store_true', help='Rank historical booths by distance without preferring a same-name historical booth')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--estimates', type=Path)
    parser.add_argument('--map-snapshot', type=Path, help='Reuse a local map response snapshot if it exists, otherwise save one here')
    args = parser.parse_args()
    suffix = '-coordinates' if args.coordinates_only else ''
    output = args.output or ROOT / f'booth-match-audit{suffix}.csv'
    estimate_output = args.estimates or ROOT / f'booth-match-estimates{suffix}.json'
    district_ids = {compact(n): k for k, n in json.loads((DATA / 'districts.json').read_text()).items()}
    baseline = json.loads((DATA / 'history-2022.json').read_text())['districts']
    tcp = json.loads((DATA / 'tcp-2022.json').read_text())['districts']
    official = json.loads((DATA / 'historical-results.json').read_text())

    def compatible(district, data):
        result = official[district]
        pair = [name(c['name']) for c in data['pair']]
        if len(pair) != 2 or len(data.get('districtTotal', [])) != 2:
            return False
        return (result['kind'] != 'distribution' or len(result['rows']) != 2
                or set(pair) == {name(c['name']) for c in result['rows']})

    tcp_votes = {district: {name(b['name']): dict(enumerate(b['votes'])) for b in data['booths'] if b['kind'] == 'ordinary'}
                 for district,data in tcp.items() if compatible(district, data)}
    historical = defaultdict(list)
    for district, records in baseline.items():
        for kind, label, votes in records:
            if kind == 'ordinary' and sum(votes.values()) > 0:
                historical[district,name(label)].append(votes)
    old = defaultdict(dict)
    for r in workbook(download(OLD), 1):
        district = district_ids.get(compact(r.get('C','')))
        if not district or r.get('F') != '1':
            continue
        label = name(r.get('G',''))
        if len(historical[district,label]) != 1:
            continue
        try:
            point = float(r['L']), float(r['M'])
        except (KeyError, ValueError):
            continue
        if -40 < point[0] < -33 and 140 < point[1] < 151:
            old[district][label] = (r['G'],point)

    if args.map_snapshot and args.map_snapshot.exists():
        snapshot = json.loads(args.map_snapshot.read_text())
    else:
        venues, requests = map_venues(point for booths in old.values() for _, point in booths.values())
        snapshot = {'requests':requests, 'venues':venues}
        if args.map_snapshot:
            args.map_snapshot.write_text(json.dumps(snapshot) + '\n')
    map_index = defaultdict(list)
    for r in snapshot['venues']:
        postcode = re.search(r'\b(\d{4})\s*$',r['addressLine3'] or '')
        point = (r['latitude'],r['longitude'])
        if postcode and all(isinstance(c,(int,float)) for c in point) and -40 < point[0] < -33 and 140 < point[1] < 151:
            map_index[compact(r['venueName']),postcode[1]].append((compact(r['addressLine1'] or ''),point))

    current = []
    for r in workbook(download(NEW),3):
        district = district_ids.get(compact(re.sub(r'\s+District\s*$', '', r.get('A',''), flags=re.I)))
        if district and r.get('B') and r.get('C'):
            current.append((district,r))
    keys = Counter((district,name(r['B'])) for district,r in current)
    totals = Counter()
    estimates = defaultdict(list)
    with output.open('w',newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['district','2026 voting location','2026 premises','2026 address','2026 lat','2026 lon','outcome','2022 candidate','distance km','weight','evidence'])
        for district,r in current:
            label = name(r['B'])
            matches = map_index[compact(r['C']),r.get('H','').strip()]
            address_matches = {point for address,point in matches if address == compact(r.get('E',''))}
            premise_points = {point for _,point in matches}
            selected = address_matches or premise_points
            point = next(iter(selected)) if len(selected) == 1 else None
            evidence = 'premises + street + postcode' if address_matches else 'unique premises + postcode' if point else ''
            sources = []
            if keys[district,label] != 1:
                method = 'duplicate 2026 label'
            elif point is None:
                method = 'existing label; no 2026 coordinates' if not args.coordinates_only and len(historical[district,label]) == 1 else 'no 2026 coordinates'
            elif not args.coordinates_only and label in old[district]:
                old_name, old_point = old[district][label]
                distance = km(point,old_point)
                method = 'existing same label' if distance <= .5 else 'review moved same label'
                sources = [(distance,old_name,1 if distance <= .5 else '')]
            elif not args.coordinates_only and historical[district,label]:
                method = 'existing label; no 2022 coordinates'
            else:
                # A previously exact-matched historical booth can still be a local proxy here.
                ranked = sorted((km(point,p),old_name) for old_name,p in old[district].values())
                method,sources = weights(ranked)
            totals[method] += 1
            if method in {'close 100%', 'isolated 100% estimate', 'weighted estimate'}:
                fp = blend(sources, lambda n: historical[district,name(n)][0])
                entry = {'name':r['B'], 'kind':'ordinary', 'method':method, 'firstPreferences':fp,
                         'sources':[{'name':n, 'distanceKm':round(d,4), 'weight':w} for d,n,w in sources]}
                if all(name(n) in tcp_votes.get(district,{}) for _,n,_ in sources):
                    blended = blend(sources, lambda n: tcp_votes[district][name(n)])
                    entry['tcp'] = {'pair':tcp[district]['pair'], 'votes':[blended[0],blended[1]]}
                estimates[district].append(entry)
            for distance,old_name,weight in sources or [(None,'','')]:
                writer.writerow([district,r['B'],r['C'],r.get('E',''),*(point or ('','')),method,old_name,
                                 round(distance,4) if distance is not None else '',weight,evidence])
    print(f'{len(current)} workbook rows; {len(snapshot["venues"])} unique map venues from {snapshot["requests"]} queries; '
          f'{sum(map(len,old.values()))} geocoded historical results')
    print('\n'.join(f'{count:5}  {label}' for label,count in totals.most_common()))
    estimate_output.write_text(json.dumps({'status':'audit estimates', 'method':'coordinates only' if args.coordinates_only else 'label then coordinates', 'districts':estimates}, indent=2) + '\n')
    print(output)
    print(estimate_output)


if __name__ == '__main__':
    main()
