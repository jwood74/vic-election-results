"""Build reproducible dashboard metadata from two public VEC sources (stdlib only)."""
import argparse
from collections import Counter, defaultdict
import hashlib
from html.parser import HTMLParser
from io import BytesIO
import json
from pathlib import Path
import re
from urllib.request import urlopen
from xml.etree import ElementTree as ET
from zipfile import ZipFile

WORKBOOK = 'https://www.vec.vic.gov.au/-/media/c4665365795d431e811d0ce818e373d4.xlsx'
NOMINATIONS = 'https://www.vec.vic.gov.au/voting/2026-state-election/find-candidates'
NS = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
ROOT = Path(__file__).resolve().parents[1] / 'public/data'


class DistrictLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = None
        self.names = {}

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            m = re.fullmatch(r'/electoral-boundaries/state-districts/([a-z0-9-]+)-district/nominations', dict(attrs).get('href', ''))
            self.active = m[1] if m else None
            self.text = []

    def handle_data(self, text):
        if self.active:
            self.text.append(text)

    def handle_endtag(self, tag):
        if tag == 'a' and self.active:
            self.names[self.active] = ''.join(self.text).strip()
            self.active = None


def key(value):
    return ''.join(re.findall('[a-z0-9]', value.lower()))


def rows(raw):
    with ZipFile(BytesIO(raw)) as z:
        strings = [''.join(si.itertext()) for si in ET.fromstring(z.read('xl/sharedStrings.xml'))]
        for row in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('.//x:row', NS):
            vals = {}
            for cell in row:
                value = cell.findtext('x:v', namespaces=NS)
                if value is not None:
                    vals[cell.get('r').rstrip('0123456789')] = strings[int(value)] if cell.get('t') == 's' else value
            if vals:
                yield vals


def download(url):
    with urlopen(url, timeout=20) as res:
        return res.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workbook', type=Path)
    parser.add_argument('--nominations', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    raw = args.workbook.read_bytes() if args.workbook else download(WORKBOOK)
    nominations = args.nominations.read_bytes() if args.nominations else download(NOMINATIONS)
    links = DistrictLinks()
    links.feed(nominations.decode())
    if len(links.names) != 88:
        raise ValueError(f'Expected 88 districts, got {len(links.names)}')
    districts = dict(sorted(links.names.items(), key=lambda entry: entry[1]))
    ids = {key(name): slug for slug, name in districts.items()}
    records = iter(rows(raw))
    if list(next(records).values()) != ['Electorate', 'Count phase', 'Count type', 'Polling place', 'Candidate name', 'Ballot order', 'Party name', 'Vote type new', 'Votes']:
        raise ValueError('Unexpected workbook headers')
    booths = defaultdict(dict)
    for r in records:
        if (r['B'], r['C']) != ('Recheck', 'First Preference'):
            raise ValueError('Workbook contains unexpected count stage')
        if int(r['F']) >= 998:
            continue  # Informal and overall total, not candidate votes
        kind = {'Ordinary': 'ordinary', 'Early Votes': 'early'}.get(r['H'])
        if not kind or key(r['D']) in {'otherearlyvotes', 'earlyvotes', 'earlyvotestotal', 'allvotes', 'mobilevoting', 'mobileearlyvoting', 'mobilevotes'} or 'mobile voting' in r['D'].lower():
            continue
        place = booths[ids[key(r['A'])]].setdefault((kind, r['D'].strip()), [Counter(), set()])
        if r['F'] in place[1] or int(r['I']) < 0:
            raise ValueError(f'Duplicate/invalid candidate row: {r}')
        place[1].add(r['F'])
        place[0][r['G']] += int(r['I'])
    if len(booths) != 87 or 'narracan' in booths:
        raise ValueError('Expected 87 ordinary election contests and no Narracan')
    history = {'source': WORKBOOK, 'sha256': hashlib.sha256(raw).hexdigest(), 'districts': {
        slug: [[kind, name, dict(sorted(party.items()))] for (kind, name), (party, _) in sorted(places.items())]
        for slug, places in sorted(booths.items())}}
    for filename, data in [('districts.json', districts), ('history-2022.json', history)]:
        target = ROOT / filename
        output = json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n'
        if args.check:
            if target.read_text() != output:
                raise ValueError(f'Generated {filename} differs')
        else:
            ROOT.mkdir(parents=True, exist_ok=True)
            target.write_text(output)
    print(f'{len(districts)} districts; {sum(map(len, booths.values()))} historical district/booth records; SHA256 {history["sha256"]}')


if __name__ == '__main__':
    main()
