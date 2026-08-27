# Fantasy Draft Companion (2026) — v2.5.2

A static, browser-only fantasy football draft companion built for two ESPN half-PPR leagues:

- **12-team:** QB / RB / RB / WR / WR / TE / FLEX / D/ST / K + 7 bench (16-player roster, 192 total picks)
- **10-team:** QB / RB / RB / WR / WR / TE / FLEX / FLEX / D/ST / K + 7 bench (17-player roster, 170 total picks)

No backend, MySQL, Node server, or account system is required.

## What it does

- Tracks every pick in a snake draft and recognizes your draft slot.
- Shows ESPN rank, projection, VOLS, VORP, same-position wait cost, tier, and directional availability.
- Keeps the **Draft Board** ordered by current player value if the player is available now.
- Before your turn, shows a separate **Priority Targets** list that combines roster relevance, chance of reaching your upcoming pick, and multi-turn positional urgency.
- Once you are on the clock, keeps the **two-pick cross-position view** for immediate context, automatically runs an **average four-selection Monte Carlo outlook**, and adds a **multi-turn positional-depth forecast** across the next four turns.
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






## v2.5.2 simulation stability + tie handling

- Increased the automatic Monte Carlo sample from **64 to 256 deterministic paths per serious on-clock candidate**. This cuts sampling noise roughly in half while remaining lightweight enough for a browser-only draft tool.
- Added explicit **essentially tied** handling. Any candidate whose average four-pick outlook is within **0.5% of the best simulated average** is shown as part of the top group rather than implying that a tiny point difference is strategically meaningful.
- The displayed card still shows the exact average and common path, but a tie callout tells you to use player preference, risk tolerance, or tier judgment as the tiebreaker.
- Simulation scenarios remain reproducible: identical league, slot, and pick history generate the same 256 paths and the same results after an undo returns you to the same board.

## v2.5.1 deterministic simulation patch

- Fixed a Monte Carlo reproducibility bug. Simulation seeds previously included the draft `updatedAt` timestamp, so selecting a player and then undoing the pick returned to the same board but generated a different set of random scenarios.
- Simulations are now seeded from a stable fingerprint of the actual draft state: league, draft slot, and exact pick history. Returning to the same board state now returns the same scenario set, recommendation ordering, average four-pick score, range, and common path.
- The recommendation/simulation caches use the same state fingerprint, so timestamp-only changes no longer force logically identical boards to behave differently.
- Monte Carlo outcomes can still change when the board itself changes, which is intentional. Very small score gaps should still be treated as ties rather than false precision.

## v2.5 depth-forecast + consistency update

- The immediate **two-pick** helper now obeys the same roster-construction rules as the Monte Carlo engine. It will not pair a current choice with D/ST or K while offensive starters remain open, and it will not choose an RB/WR that goes directly to the bench while core RB/WR/FLEX capacity is incomplete.
- Added a **multi-turn positional-depth forecast**. For each candidate, the tool estimates the best same-position projection likely to remain over the next four of your turns and labels roughly how many turns the current tier looks safe to defer. This is meant to detect flat shelves such as a deep TE tier instead of forcing a pick just because the four-selection Monte Carlo horizon is ending.
- The Monte Carlo terminal score now gives an empty QB/TE slot deferred credit based on the actual same-position production forecast to remain at your *next turn after the horizon*, rather than relying only on a fixed baseline placeholder. This better preserves late-QB and late-TE strategies.
- Once core RB/WR/FLEX starters are filled, useful RB/WR bench depth gets a small residual VORP credit at the simulation horizon. Bench depth still cannot crowd out empty core skill-position starters.
- The recommendation badge is explicitly labeled **Avg 4-pick**. The common path remains the most frequently occurring exact path, so a common path and the average outcome are not expected to be numerically identical.
- K and D/ST keep their raw ESPN projection, VOLS, and VORP, but **Model Value** now applies a heuristic reliability discount (D/ST uses 30% and K 40% of otherwise-calculated Model Value) to reflect the lower draft-day confidence and easier replacement/streaming of those positions. This is intentionally a heuristic, not a calibrated statistical estimate.

## v2.4 roster relevance + urgency update

- Future simulated picks no longer take an RB/WR/TE that would go directly to the bench while an RB/WR/FLEX starting slot is still open. This removes irrational paths such as RB → RB → RB → RB when the fourth RB cannot enter the lineup and starting WR slots remain empty.
- The constraint is deliberately **not** "fill every position immediately." Once RB/WR/FLEX capacity is occupied, the simulation may still build RB/WR depth while QB or TE remains open, preserving viable late-QB and late-TE strategies.
- At the four-pick horizon, empty RB/WR/FLEX slots receive no assumed future points. Empty QB/TE slots receive a conservative 88% of the modeled last-starter baseline so the simulation does not artificially force an early QB/TE simply because its horizon ends.
- **Priority Targets** now hide already-covered positions unless the candidate would actually improve the starting lineup. For example, a third RB is still relevant when FLEX is open; a fourth RB is not a featured target when it would go straight to the bench and WR slots remain open. Redundant backup QB/TE targets are also suppressed unless they improve a starter/FLEX spot.
- Added an explicit **Urgency** measure. Player value remains unchanged on the Draft Board, but target priority now discounts players who are likely to survive not only to your upcoming pick but also to the following turn.
- D/ST and K remain visible on the Draft Board, but recommendation cards suppress them while offensive starters are incomplete and continue to defer them while the model thinks they are safely waitable. They become recommendation-eligible as their next-turn availability becomes genuinely urgent.
- The four-pick score is now labeled **horizon points**, because it can include conservative deferred QB/TE credit rather than pretending every point is already attached to a drafted starter.

## v2.3 four-pick Monte Carlo outlook

- The browser runs the simulations automatically. You do **not** run hundreds of mock drafts yourself.
- The original v2.3 implementation used 64 deterministic, rank-driven paths per serious on-clock candidate. v2.5.2 raises the live default to 256 per candidate for lower sampling noise; across the candidate set this means thousands of plausible paths can be evaluated automatically after each pick.
- Opponent selections are sampled from the best remaining ESPN-ranked players with a tighter distribution early and more variance later. This is a directional draft-room model, not a claim of calibrated ADP probabilities.
- After every simulated opponent run, the tool makes your future selections using the same roster-aware value engine. Positional scarcity emerges as the simulated board depletes and roster slots fill rather than through a separate forced position bonus.
- Each candidate is evaluated across your current selection plus up to the next three selections (for example, 3.11 → 4.02 → 5.11 → 6.02).
- The recommendation cards show the average projected points actually occupying offensive starting slots by the end of the horizon, the middle-50% simulation range, the most common positional path, and a common player path. This makes a fourth RB lose value once RB/RB/FLEX are already occupied and lets delayed WR construction show up naturally.
- The existing immediate **two-pick** value stays visible separately so the four-pick outlook does not become another opaque blended score.
- The Draft Board itself is unchanged: it still ranks players by current model value if available now.

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
git commit -m "Increase Monte Carlo samples and flag ties"
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

## v2.5 valuation model

- **VOLS:** projected points above the modeled last starter at the same position. Starter baselines include the league's FLEX demand.
- **VORP:** projected points above a deeper replacement/waiver baseline after starters and seven bench spots per team are modeled.
- **Roster value:** the model uses the larger of actual starter-lineup improvement and a small fraction of VORP for bench/depth value; it does not add full VOLS and VORP together.
- **ESPN prior:** 35% of base decision value comes from ESPN rank translated onto the same structural-value scale. This is intended as a risk/role prior, not a requirement to follow ESPN order.
- **Current value:** roster-aware player value if the player is available now. This drives the default Draft Board order and is not adjusted for availability.
- **Priority-target score:** before your turn only, current value × estimated chance the player survives to your upcoming pick × an urgency factor that now includes the multi-turn positional-depth forecast. Players on flat positional shelves are deliberately easier to defer.
- **Immediate two-pick path:** candidate-now value plus the probability-weighted value of the best roster-eligible players likely to survive to your following selection. The second-pick helper uses the same K/DST and direct-to-bench constraints as the longer simulation.
- **Average four-pick Monte Carlo outlook:** automatic rank-driven simulations extend the decision through up to three more of your picks. Future user selections are constrained to rational roster paths while core RB/WR/FLEX capacity remains open. At the horizon, empty QB/TE slots receive deferred credit based on the production forecast to remain at the next turn, while useful RB/WR bench depth receives only a small residual VORP credit after core skill starters are filled.
- **Wait cost:** difference between the current player's model value and a same-position alternative around the following pick.
- **Urgency:** a directional 0–100% planning signal combining gone-if-wait risk, one-turn same-position drop, and the new multi-turn depth forecast. It affects recommendation/target timing, not intrinsic Draft Board value.
- **Position depth:** a four-turn forecast of the best same-position projection likely to remain if you defer the position. The card shows the projected shelf and a rough “safe turns” count before a meaningful drop.
- **K/DST reliability:** raw projection/VOLS/VORP are preserved, but current Model Value applies a heuristic reliability factor (30% D/ST, 40% K) because preseason separation at those positions is less dependable and replacement/streaming is easier.
- **Gone %:** directional conditional estimate based on ESPN rank. The rank is treated as the center of a truncated draft-position curve with tighter uncertainty for elite players and wider uncertainty later. While waiting for your turn it reports the chance the player is gone before your upcoming pick; on your turn it reports the chance he is gone before your following pick if you pass. It is not a true ADP probability because the source PDF has no ADP distribution.

This is a decision aid, not a claim that the projections or availability estimates are exact.
