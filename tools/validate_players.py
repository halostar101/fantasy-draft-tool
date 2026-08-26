import fitz
import json
import math
import re
import sys
from collections import defaultdict

PDF = sys.argv[1] if len(sys.argv) > 1 else 'Pre-Draft Strategy Data.pdf'
DATA = sys.argv[2] if len(sys.argv) > 2 else 'data/players-2026.json'

with open(DATA, encoding='utf-8') as f:
    payload = json.load(f)
players = payload['players']
assert len(players) == 400, f'Expected 400 players, found {len(players)}'
assert [p['rank'] for p in players] == list(range(1, 401)), 'Ranks are not contiguous 1..400'
assert all(p['name'] and p['team'] and p['position'] for p in players), 'Missing player identity fields'
assert len({p['id'] for p in players}) == 400, 'Duplicate player IDs'

# Collect every visually aligned FPTS candidate for each printed rank. Page breaks can
# duplicate a rank, so validation accepts any matching candidate rather than assuming
# the first/last occurrence is always the real row.
doc = fitz.open(PDF)
fpts_candidates = defaultdict(list)
for pi in range(1, min(19, len(doc))):
    words = doc[pi].get_text('words')
    for w in words:
        x0, y, _, _, text, *_ = w
        if not (85 <= x0 <= 110 and re.fullmatch(r'\d{1,3}', text)):
            continue
        rank = int(text)
        if not (1 <= rank <= 400):
            continue
        fpts = [ww for ww in words if ww[0] > 715 and abs(ww[1] - y) < 1.0 and re.fullmatch(r'-?\d+(?:\.\d+)?', ww[4])]
        for ww in fpts:
            fpts_candidates[rank].append(float(ww[4]))

mismatches = []
for p in players:
    fp = p['projectedPoints']
    if fp is None:
        continue
    candidates = fpts_candidates.get(p['rank'], [])
    if candidates and not any(math.isclose(fp, c, abs_tol=0.05) for c in candidates):
        mismatches.append((p['rank'], p['name'], fp, candidates))

# High-value sanity checks catch the page-continuation collision that affected v1.
checks = {
    1: ('Jahmyr Gibbs', 331.0),
    3: ("Ja'Marr Chase", 277.7),
    9: ('CeeDee Lamb', 241.9),
    11: ('Justin Jefferson', 238.3),
    17: ('Trey McBride', 188.0),
    24: ('Brock Bowers', 191.5),
    36: ('Josh Allen', 369.7),
    400: ('Isaiah Bond', 25.6),
}
for rank, (name, fp) in checks.items():
    p = players[rank - 1]
    assert p['name'] == name, (rank, p['name'], name)
    assert math.isclose(p['projectedPoints'], fp, abs_tol=0.05), (rank, p['projectedPoints'], fp)

if mismatches:
    raise SystemExit('Projection mismatches:\n' + '\n'.join(map(str, mismatches[:20])))

print(f'PASS: {len(players)} players validated; key projections and PDF-aligned FPTS match.')
