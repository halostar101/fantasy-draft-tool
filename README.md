# Fantasy Draft Companion (2026) — v2.2

A static, browser-only fantasy football draft companion built for two ESPN half-PPR leagues:

- **12-team:** QB / RB / RB / WR / WR / TE / FLEX / D/ST / K + 7 bench (16-player roster, 192 total picks)
- **10-team:** QB / RB / RB / WR / WR / TE / FLEX / FLEX / D/ST / K + 7 bench (17-player roster, 170 total picks)

No backend, MySQL, Node server, or account system is required.

## What it does

- Tracks every pick in a snake draft and recognizes your draft slot.
- Shows ESPN rank, projection, VOLS, VORP, same-position wait cost, tier, and directional availability.
- Keeps the **Draft Board** ordered by current player value if the player is available now.
- Before your turn, shows a separate **Likely Targets** list based on player value × estimated chance of reaching your upcoming pick.
- Once you are on the clock, uses a **two-pick cross-position lookahead** to compare the actual choices available now plus the value likely to remain at your following selection.
- Uses ESPN rank as a **modest value prior**, rather than either copying ESPN or ignoring it.
- Autosaves the active draft and saved mocks in browser storage.
- Saves mock snapshots and compares two or more mock teams.
- Exports/imports `draft-backup.json` for manual GitHub backup.

## Important v2 changes

1. Fixed the PDF extraction collision that gave Ja'Marr Chase an incorrect projection in v1. Chase is now correctly loaded at **277.7 projected FPTS**.
2. Added a validation script and key projection checks for the 400-player dataset.
3. Added **VOLS (Value Over Last Starter)** using league-specific starter and FLEX demand.
4. Kept **VORP** as the deeper waiver/replacement measure, but stopped double-counting it with starter lineup gain.
5. Added a 35% ESPN-rank prior to acknowledge information that a point projection alone does not capture (risk, role, expert ordering) while still allowing the model to disagree with ESPN.
6. Added cross-position **two-pick lookahead** so the tool evaluates paths such as RB → WR versus WR → RB, not only the first player in isolation.

## v2.1 availability + usability update

- Added hover tooltips to every Draft Board header so VOLS, VORP, Wait, Gone, tiers, and source columns are easy to decode.
- Fixed the **Gone % display semantics**. While you are waiting for your turn, Gone now shows the chance a player disappears before your *upcoming* pick. Once you are on the clock, it switches to the chance he disappears before your *following* pick if you pass.
- Recalibrated the ESPN-rank availability heuristic. The old curve was too wide for elite players and assigned impossible probability mass before pick 1. The new rank-centered curve is truncated at the start of the draft, is much tighter near the top, and widens gradually later.
- Example: in a 12-team draft from slot 11 at pick 1.01, ESPN ranks 1 and 2 now show roughly **98% and 97%** chance of being gone before 1.11, rather than about 41%.


## v2.2 ranking / recommendation separation

- The Draft Board no longer discounts Gibbs, Bijan, or any other player just because they are unlikely to reach your draft slot. Its default order is **current model value only**.
- Added an explicit **Value** column so you can see the model number driving the board order.
- Before your turn, the recommendation cards become **Likely Targets at your upcoming pick**. This planning list intentionally blends two visible inputs: current model value and estimated availability. It does not change the board ranking.
- Once you are on the clock, the cards switch back to **Best choices right now** and use the cross-position two-pick lookahead.
- Fixed a lookahead inconsistency: before your turn, a possible second-pick player must now survive from the current board all the way to your following pick. The model no longer creates paths that implicitly let an elite player skip the picks before your first selection.
- Existing browser saves remain compatible. If an older save had the board sorted by `Recommendation` or `Two-pick path`, v2.2 automatically falls back to `Model value`.

## Run locally

From the project directory:

```bash
python -m http.server 8000
```

or, if Node/npm is already installed:

```bash
npx serve .
```

Then open the local URL shown in the terminal.

## Host on GitHub Pages

1. Put these files at the repository root and push them.
2. In GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select `main` and `/ (root)`.
5. Save. GitHub Pages will redeploy after each push.

## Updating an existing repo

The provided update ZIP is designed to be extracted **into the root of your existing local repository**. It intentionally does **not** contain `data/draft-backup.json`, so it will not overwrite a committed mock backup.

After extracting/overwriting the changed files:

```bash
git status
git add .
git commit -m "Separate player value from target availability"
git push
```

GitHub Pages should redeploy automatically after the push.

## Mock backup workflow

Your draft actions save immediately in the browser. For a durable/cross-device backup:

1. Open **Data & backup**.
2. Click **Export backup JSON**.
3. Replace `data/draft-backup.json` in this repo with the exported file.
4. Commit and push.
5. A fresh browser can load that committed backup. An existing browser can use **Reload repo backup**.

## Player data

`data/players-2026.json` contains 400 players extracted from the supplied ESPN Pre-Draft Strategy PDF captured August 26, 2026. The PDF includes ESPN overall rank, projected stat columns, and projected fantasy points. It does **not** include ADP.

Rebuild and validate the data with:

```bash
python tools/extract_players.py "Pre-Draft Strategy Data.pdf" data/players-2026.json
python tools/validate_players.py "Pre-Draft Strategy Data.pdf" data/players-2026.json
```

## v2.2 valuation model

- **VOLS:** projected points above the modeled last starter at the same position. Starter baselines include the league's FLEX demand.
- **VORP:** projected points above a deeper replacement/waiver baseline after starters and seven bench spots per team are modeled.
- **Roster value:** the model uses the larger of actual starter-lineup improvement and a small fraction of VORP for bench/depth value; it does not add full VOLS and VORP together.
- **ESPN prior:** 35% of base decision value comes from ESPN rank translated onto the same structural-value scale. This is intended as a risk/role prior, not a requirement to follow ESPN order.
- **Current value:** roster-aware player value if the player is available now. This drives the default Draft Board order and is not adjusted for availability.
- **Likely-target score:** before your turn only, current value × estimated chance the player survives to your upcoming pick. This drives the planning cards, not the Draft Board.
- **On-clock two-pick path:** candidate-now value plus the probability-weighted value of the best players likely to survive to your following selection, across all positions. It is used only when you are actually on the clock.
- **Wait cost:** difference between the current player's model value and a same-position alternative around the following pick.
- **Gone %:** directional conditional estimate based on ESPN rank. The rank is treated as the center of a truncated draft-position curve with tighter uncertainty for elite players and wider uncertainty later. While waiting for your turn it reports the chance the player is gone before your upcoming pick; on your turn it reports the chance he is gone before your following pick if you pass. It is not a true ADP probability because the source PDF has no ADP distribution.

This is a decision aid, not a claim that the projections or availability estimates are exact.
