# Onde?

A free, GeoGuessr-style geography game that runs entirely in the browser.

You're dropped onto a random street somewhere on Earth. Look around in 360°, walk down the road, find clues, then pin where you think you are. Five rounds, up to 5,000 points each.

**Play:** https://sandro91145.github.io/geogesser/

## Features

- **Street view (360°)** from [Mapillary](https://www.mapillary.com) and [Panoramax](https://panoramax.fr), with clickable arrows and ↑/↓ (or W/S) to walk, a compass (click it to face north) and "Back to start"
- **Movement options** like GeoGuessr: Move, No moving, or No moving, panning or zooming
- **Daily challenge**: the same five places for everyone each day, with a leaderboard and a shareable 🟩🟨🟧 result
- **Challenge a friend**: copies a link that replays your exact five rounds and shows your score to beat
- **Country streak**: click the country you think you're in; how many in a row can you get?
- **Photos mode**: real photos of places from Wikimedia Commons
- **Installable**: add it to your phone's home screen or install it on your PC as an app
- Regions: World, Europe, Americas, Asia, Africa, Oceania and Portugal (including Madeira and the Azores)
- Optional time limit, personal bests per setting, works on phone and desktop. No account, no build step.

## How it works

- **Street view.** Mapillary: each round reads Mapillary's coverage tile (about 20 km) around a random point near a seed city in `js/seeds.js`, picks a 360° sequence and starts in the middle of it. Panoramax: `data/coverage.json` lists ~1,800 spots with 360° coverage, taken from Panoramax's coverage grid; each round searches one of them. A quarter of rounds use Panoramax, and it's the backup if Mapillary fails. Panoramas are shown with [Photo Sphere Viewer](https://photo-sphere-viewer.js.org).
- **Daily challenge** uses a random generator seeded with the date over the Panoramax coverage, so everyone gets the same places without a server.
- **Challenge links** pack the five round IDs and settings into the URL (`#c=…`).
- **Place names** on the result screen, and the country checks in Country streak, come from OpenStreetMap's Nominatim.
- **Photos mode** asks the [Wikidata Query Service](https://query.wikidata.org) for photographed places near a seed point, with credits from the Commons API, and falls back to ~110 built-in photos in `data/fallback.json`.
- **Map** is [Leaflet](https://leafletjs.com) with OpenStreetMap tiles.
- **Score** is `5000 × e^(−distance / scale)`, where the scale depends on the region size (1,492 km for the world, 150 km for Portugal).

## Mapillary token

`js/config.js` holds the Mapillary client token. It's read-only and meant for use in web pages. To use your own, create one at https://www.mapillary.com/dashboard/developers. If it's empty, street view uses Panoramax only.

## Leaderboard

The daily leaderboard is stored in a free [Supabase](https://supabase.com) project (`SUPABASE_URL` / `SUPABASE_KEY` in `js/config.js`). The table and its access rules are in `supabase/schema.sql`. The public key can only read scores and add one score per player per day for today, and the total must match the five round scores. Nothing can be edited or deleted from the game. Scores are submitted by the browser, so this can't fully prevent a determined cheater. That's fine for a friends leaderboard.

## Run locally

It's a static site, but ES modules need a web server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Project layout

```
index.html         screens: start, game, result
style.css          all styling
js/app.js          game flow, photo mode, daily challenge, challenge links, maps, scoring
js/street.js       street view: Mapillary + Panoramax search, 360° viewer, walking, compass
js/config.js       Mapillary token, Supabase project URL + public key
js/leaderboard.js  daily leaderboard (Supabase REST API)
supabase/schema.sql  leaderboard table and access rules
js/seeds.js        regions (label, map view, score scale, areas) and seed points
data/coverage.json Panoramax spots with 360° coverage
data/fallback.json built-in photos used when the photo search is unavailable
tools/harvest.js   collects photos in bulk from Wikidata (to rebuild the fallback)
sw.js, manifest.webmanifest, icons/   make the game installable as an app
```

## Ideas for later

- Live multiplayer duels (Supabase Realtime, on the same free project)

## Credits

Street imagery © Mapillary and Panoramax contributors (mostly CC BY-SA 4.0); photos belong to their Wikimedia Commons authors. The author and license of each image are shown after you guess, with a link to the original. Map data, tiles and place names © OpenStreetMap contributors.

Code released under the MIT License.
