"""Bundle a Sportsbet district-winner CSV snapshot for the dashboard."""

import argparse
import csv
import json
import math
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv', type=Path)
    args = parser.parse_args()
    data = Path(__file__).resolve().parents[1] / 'public' / 'data'
    roster = json.loads((data / 'districts.json').read_text(encoding='utf-8'))
    district_ids = {name.casefold(): key for key, name in roster.items()}
    markets = {}

    with args.csv.open(encoding='utf-8-sig', newline='') as source:
        reader = csv.DictReader(source)
        columns = ['seat'] + [f'{field}_{i}' for i in range(1, 7) for field in ('party', 'odds')]
        if reader.fieldnames != columns:
            parser.error('Expected seat followed by party_1, odds_1 through party_6, odds_6.')
        for row in reader:
            if None in row or None in row.values():
                parser.error(f'Line {reader.line_num}: wrong number of columns.')
            seat = row['seat'].strip()
            key = district_ids.get(seat.casefold())
            if not key or key in markets:
                parser.error(f'Unknown or duplicate district: {seat!r}.')
            options = []
            labels = set()
            for i in range(1, 7):
                label, price = row[f'party_{i}'].strip(), row[f'odds_{i}'].strip()
                if not (label or price):
                    continue
                try:
                    odds = float(price)
                except ValueError:
                    parser.error(f'{seat}: invalid odds for {label!r}: {price!r}.')
                if not label or label.casefold() in labels or not math.isfinite(odds) or odds <= 1:
                    parser.error(f'{seat}: invalid or duplicate market option: {label!r} at {price!r}.')
                labels.add(label.casefold())
                options.append([label, odds])
            if len(options) < 2:
                parser.error(f'{seat}: expected at least two quoted options.')
            markets[key] = sorted(options, key=lambda option: option[1])

    missing = roster.keys() - markets.keys()
    if missing:
        parser.error('Missing districts: ' + ', '.join(roster[key] for key in sorted(missing)))
    lines = [f'  {json.dumps(key)}: {json.dumps(markets[key], ensure_ascii=False)}' for key in roster]
    (data / 'sportsbet-odds-2026.json').write_text('{\n' + ',\n'.join(lines) + '\n}\n', encoding='utf-8')
    print(f'Bundled Sportsbet odds for {len(markets)} districts.')


if __name__ == '__main__':
    main()
