# Onde?

A free, GeoGuessr-style geography game that runs entirely in the browser.

Each game is five rounds. You get a real photo taken somewhere on Earth, drop a pin on the map where you think it was taken, and score up to 5,000 points depending on how close you are.

**Play:** https://sandro91145.github.io/geogesser/

## Features

- Regions: World, Europe, Americas, Asia, Africa, Oceania and Portugal (including Madeira and the Azores)
- Optional time limit per round (2 min, 1 min, 30 s)
- Click the photo to zoom in on signs, plates and details
- Animated reveal of your guess against the real spot, plus a summary map at the end
- Personal best saved per region and time limit
- "Copy result" gives a shareable line like `🟩🟨🟧🟩⬛`
- Works on phone and desktop; no account, no API key, no build step

## How it works

- **Photos** come from [Wikimedia Commons](https://commons.wikimedia.org). Each round picks a seed point in the chosen region (`js/seeds.js`), nudges it up to 25 km, and asks the [Wikidata Query Service](https://query.wikidata.org) for places with a photo nearby (about half a second). Size, author and license come from the Commons API. Maps, flags, scans, aerial shots and small or oddly shaped images are filtered out. The next round loads while you play the current one. If Wikidata can't be reached, the game uses ~110 built-in photos from `data/fallback.json`.
- **Map** is [Leaflet](https://leafletjs.com) with OpenStreetMap data and CARTO Voyager tiles.
- **Score** is `5000 × e^(−distance / scale)`, where the scale depends on the region size (1,492 km for the world, 150 km for Portugal).

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
js/app.js          game logic, photo search, maps, scoring
js/seeds.js        regions (label, map view, score scale) and the seed points searched
data/fallback.json built-in photos used when the live search is unavailable
tools/harvest.js   collects photos in bulk from Wikidata (to rebuild the fallback)
```

## Ideas for later

- Street-level mode with [Mapillary](https://www.mapillary.com/developer) imagery (needs a free access token)
- Daily challenge where everyone gets the same five photos
- Multiplayer rooms

## Credits

Photos belong to their Wikimedia Commons authors; the author and license are shown with each photo, with a link to the original file. Map data © OpenStreetMap contributors, tiles © CARTO.

Code released under the MIT License.
