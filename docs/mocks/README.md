# Mock stage

Throwaway mockups for the agent hub rebuild. They exist so a direction can be chosen before any real code is written, and are deleted or superseded once the design is settled in `docs/DESIGN.md`.

## Open

Open `docs/mocks/index.html` in a browser straight from the file system. There is no build step, no server and no network use; every page works offline. Each mock links its own stylesheet (`mock.css`) and one small classic script (`mock.js`).

| File                   | What it shows                                               |
| ---------------------- | ----------------------------------------------------------- |
| `index.html`           | Comparison page: the shared structure and the choices below |
| `hephaestus.html`      | Hephaestus, layout A (grid of tiles, then full chat)        |
| `hephaestus-rail.html` | Hephaestus, layout B (persistent side rail)                 |
| `janus.html`           | Janus, layout A                                             |
| `apollo.html`          | Apollo, layout A                                            |

## What is being decided

1. Body treatment: orb-first or bust-first emphasis.
2. Layout: grid of tiles then full chat, or a persistent side rail.
3. Overall mood.

Each page has a body-state switch (Auto loops idle and active, or force one) and a theme switch (system, dark, light). Pages respect `prefers-reduced-motion`: animation stops and the orb (idle) and bust (active) stay distinguishable.

## Notes

- All text and chat content is invented placeholder text; no real data is shown.
- Colours, type and body tones are custom properties declared at the top of each page; shared layout lives in `mock.css`.
- Nothing here is production code and nothing in the running service reads these files.

## 3D prototype (`3d-gods.html`)

Decisions so far: orb-first, layout B (persistent side rail), dark default, soft glass orb (variant B) as the body, no flat fallback. Bodies are WebGL-only; without WebGL 2 the stage shows the text "3D view needs WebGL 2" instead of any flat art.

Serving: the page and the vendored script run from the file system, but loading scanned models (`models/*.glb`, see below) needs http, because browsers block `fetch` from `file://`. For the models, serve the folder, for example `python3 -m http.server` from `docs/mocks/`. Without a model the page falls back to the procedural bust and says so in the readout.

How it behaves

- Rail: all eight gods (Hephaestus, Themis, Janus, Atlas, Plutus, Apollo, Iris, Dionysus). Picking one swaps the palette, the attributes, the chat sample and the model; a new god always starts as the collapsed orb.
- Click the body (or focus it and press Enter or Space) to expand the orb into the bust; click again or press Esc to collapse. The stage is a button with `aria-expanded`, a pointer cursor, a hover and focus glow and a first-view hint pill. Touch works the same way (tap).
- Activity (idle, thinking, speaking) is the `data-state` attribute on the stage; the Activity switch stands in for the chat stream that will drive it later. Orb: thinking contracts, spins faster and brightens; speaking pulses the glow. Bust: thinking speeds the scan sweep; speaking adds eye and core flicker, a pulse glow and a swaying hammer or coin.
- Orb: a soft glass sphere (low-alpha fresnel rim, glowing interior, a wide haze band), a 7000-particle shell and core, an orbiting soft mote and pointer parallax. There are no hard ring lines.
- Bust: the same 7000 particles dissolve from the orb into the figure. Real model heads are sampled into surface points with normals and drawn through the hologram point shader (rim light from the normal, scanlines, a rising scan sweep, depth fade for back-facing points, a rare glitch slice). Until a model loads (or if it is missing), a procedural head and body stand in (round cranium, tapered jaw, brow, nose, chin, flared neck, shoulders).
- Per-god attributes are built in code: Hephaestus cap, beard, anvil and hammer (stand-in only); Themis blindfold band and scales; Janus a doorway arch and key; Atlas a sky arc (stand-in only); Plutus a crown and a coin; Apollo a laurel wreath and lyre; Iris a veil and rainbow arcs; Dionysus an ivy wreath with hanging vines (stand-in only). Janus's scan is a single head with two faces.
- The 3D stage keeps dark glass tones in both themes; the page chrome follows the dark or the designed light set.

Models

- One model per god, `docs/mocks/models/<god id>.glb`: apollo, dionysus, janus, hephaestus, atlas, themis, iris, plutus. Each was generated with TRELLIS.2 (MIT, Microsoft) via ComfyUI from a photograph of a real sculpture, then cropped and decimated to about 15k triangles, geometry only (no textures, materials or normals; metadata stripped). About 180 KB each, about 1.45 MB in total. Budget for any future model: at most 15k to 20k triangles and 250 KB per file, 2 MB for the set. A model is loaded only when its god is selected (lazy) and cached for the session; nothing is fetched from anywhere else at runtime.
- Models load over http only (browsers block `fetch` from `file://`); without them the procedural bust is used.
- Every model is shown whole (`bust` kind: it fills the stage). Each has its own yaw, scale and offset in `SCANS` in `3d-gods.js`; `?yaw=`, `?scale=`, `?dy=` and `?crop=y0,y1,x0,x1,z0,z1` override them for the god being viewed.
- The loaded triangles are drawn as a hologram surface (fresnel rim, key light, soft scanlines) next to the particles; the points alone do not show a face.
- In-code attributes remain only where they sit right: Themis (scales), Janus (doorway arch, key), Plutus (coin), Apollo (lyre), Iris (rainbow). Heads that carry their own hair or headgear (Apollo, Dionysus, Hephaestus, Atlas, Iris, Themis) have no in-code wreath, cap, band or veil.
- Atlas is the full Farnese figure (kneeling under the globe, face turned away); a bust of the Gandharan Cleveland Atlas was generated as an alternative but is not shipped.
- When a model arrives while the bust is showing, the bust dissolves to the orb and re-forms from the model, so there is no pop.

Model attribution

All models are derivatives of public-domain, CC0 or CC BY 3.0 photographs (the full entries, with retrieval dates and processing, are in `ASSET-LICENSE`). Every file was cropped and decimated.

| God        | Source photo                                                            | Author or holder                  | Licence            | Source                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------- | --------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apollo     | Apollo Palatino Inv12456 (Palazzo Massimo)                              | Marie-Lan Nguyen (2009)           | Public domain      | https://commons.wikimedia.org/wiki/File:Apollo_Palatino_Inv12456.jpg                                                                                                          |
| Dionysus   | Marble head of Dionysus, 2nd c. CE Roman copy (Louvre)                  | Gary Todd                         | CC0 1.0            | https://commons.wikimedia.org/wiki/File:Ancient_Greek_Marble_Statue_Head_of_Dionysus,_2nd_Cent._AD_Roman_Copy_(28224386661).jpg                                               |
| Janus      | Double herm Chiaramonti Inv1395 (Vatican Museums)                       | Marie-Lan Nguyen (2009)           | CC BY 3.0          | https://commons.wikimedia.org/wiki/File:Double_herm_Chiaramonti_Inv1395.jpg                                                                                                   |
| Hephaestus | Hephaestus statuette (Nelson-Atkins Museum of Art)                      | Daderot                           | Public domain      | https://commons.wikimedia.org/wiki/File:Hephaestus,_findspot_unknown,_1st_or_2nd_century_CE_copy_or_adaptation_of_Greek_original_-_Nelson-Atkins_Museum_of_Art_-_DSC08202.JPG |
| Atlas      | Farnese Atlas (National Archaeological Museum, Naples)                  | Carlo Raso                        | Public Domain Mark | Wikimedia Commons, file "Farnese Atlas.jpg"                                                                                                                                   |
| Themis     | Statue of Themis from Rhamnous (National Archaeological Museum, Athens) | Gary Todd                         | CC0 1.0            | https://commons.wikimedia.org/wiki/File:Pentelic_Marble_Statue_of_Themis_from_Rhamnous,_c._300_BC_(27873364654).jpg                                                           |
| Iris       | Weber-Laborde head, Louvre Ma 740                                       | Marie-Lan Nguyen / Jastrow (2007) | Public domain      | https://commons.wikimedia.org/wiki/File:Weber-Laborde_head_Louvre_Ma740_n3.jpg                                                                                                |
| Plutus     | Eirene with the infant Ploutos (Glyptothek, Munich)                     | Marie-Lan Nguyen (2009)           | Public domain      | https://commons.wikimedia.org/wiki/File:Eirene_Ploutos_Glyptothek_Munich_219_n4.jpg                                                                                           |

Credit required by the licence: the Janus model is based on "Double herm Chiaramonti Inv1395" by Marie-Lan Nguyen (2009), CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/), via Wikimedia Commons, and was modified (cropped, decimated, converted to a 3D model).

### Performance notes

- Draw calls: about 14 to 18 (one point cloud, the glass sphere and haze band, haze, mote and core glow sprites, two eye sprites, the pulse glow, the two procedural wire shells, plus up to a handful of attribute wires).
- Pixel ratio is capped (2, or 1.5 under 700 px wide). The loop pauses when the tab is hidden or the stage is scrolled out of view. Under `prefers-reduced-motion` nothing animates: one static WebGL frame is drawn per state change and expanding snaps between orb and bust.
- Step down stays 3D: if the average frame interval stays above 34 ms over two 90-frame windows, particles drop to 40 percent and the pixel ratio to 1; if it stays slow, particles drop to 25 percent and the extra glow (haze) is switched off. It never switches to a flat look. `?nodegrade` disables the step down, which helps when taking screenshots on a software renderer.
- Query parameters for testing: `god=<id>`, `state=idle|thinking|speaking`, `open=1` (start expanded), `nogl` (show the no-WebGL message), `nodegrade`.
- Measured only on a software renderer in headless Chromium (about 17 to 35 ms per frame, 0.1 to 0.6 ms CPU). Please judge smoothness on a real device.
- Bundle size: the vendored three.js subset (with GLTFLoader) is about 615 KB. It is a vendor file, not counted against the 150 KB limit that applied to the flat mocks.
