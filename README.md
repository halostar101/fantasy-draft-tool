# Fantasy Draft Companion (2026)

A static, browser-only fantasy football draft companion built for two ESPN half-PPR leagues:

- **12-team:** QB / RB / RB / WR / WR / TE / FLEX / D/ST / K + 7 bench (16-player roster, 192 total picks)
- **10-team:** QB / RB / RB / WR / WR / TE / FLEX / FLEX / D/ST / K + 7 bench (17-player roster, 170 total picks)

No backend, MySQL, Node server, or account system is required.

## What v1 does

- Tracks every pick in a snake draft.
- Automatically recognizes when the current pick belongs to your draft slot.
- Shows the best available players with ESPN rank, projection, VORP, VONA, tier, and a directional “gone before next pick” estimate.
- Recalculates recommendations after every pick.
- Optimizes your drafted players into starting roster slots and FLEX spots.
- Autosaves the active draft and saved mocks in browser storage.
- Saves mock snapshots and compares two or more mock teams.
- Exports/imports a `draft-backup.json` file for manual GitHub backup.
- On a fresh browser, can seed saved mocks from `data/draft-backup.json` committed in the repo.

## Run locally

From the project directory:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

Opening `index.html` directly may fail because browsers restrict local `fetch()` calls.

## Host on GitHub Pages

1. Create a GitHub repository and put these files at the repo root.
2. Push the repo.
3. In GitHub, open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select your main branch and `/ (root)`.
6. Save. GitHub will provide a URL such as `https://YOUR-USERNAME.github.io/fantasy-draft-tool/`.

Because this app uses only relative file paths, no code changes are needed for GitHub Pages.

## Mock backup workflow

Your draft actions save immediately in the browser. For a durable/cross-device backup:

1. Open **Data & backup**.
2. Click **Export backup JSON**.
3. Replace `data/draft-backup.json` in this repo with the exported file.
4. Commit and push.
5. A fresh browser opening the site can load that committed backup automatically. An existing browser can use **Reload repo backup**.

## Player data

`data/players-2026.json` contains 400 players extracted from the supplied ESPN Pre-Draft Strategy PDF captured on August 26, 2026. The supplied PDF includes ESPN overall rank, projected stat columns, and projected fantasy points. It does **not** include ADP, so v1 uses ESPN overall rank as the market/draft-order proxy.

## V1 valuation model

The replacement model first fills aggregate league starter demand, including the league's FLEX slots. It then fills all seven bench spots per team with the best remaining QB/RB/WR/TE players in ESPN rank order. The best projected player left at each position becomes that league's modeled replacement baseline.

- **VORP:** projected points minus the modeled positional replacement baseline.
- **Lineup gain:** increase to your optimized starting lineup versus replacement placeholders if you add the player.
- **VONA:** the VORP difference between the current player and a same-position alternative expected around your next selection.
- **Gone %:** a conditional logistic estimate based on ESPN rank. This is intentionally labeled directional because the source does not include an ADP distribution.
- **Recommendation score:** combines lineup gain, VORP, wait cost, estimated disappearance risk, and whether the player has fallen relative to ESPN rank.

This is a decision aid, not a claim that the projections or availability estimates are exact.

## Updating player data

The `tools/extract_players.py` script is included to reproduce the JSON from the supplied PDF format:

```bash
python tools/extract_players.py "Pre-Draft Strategy Data.pdf" data/players-2026.json
```

The supplied PDF has a few rows split across printed page boundaries; the extractor includes fixes for those specific continuation rows.
