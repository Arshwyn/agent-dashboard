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

- One model per god, `docs/mocks/models/<god id>.glb`: apollo, dionysus, janus, hephaestus, atlas, themis, iris, plutus. Each is a single combined mesh of a stylised half figure that holds its own attribute (Apollo a lyre, Dionysus a thyrsus and a cup, Hephaestus an anvil and a hammer, Themis scales, Atlas a ringed globe held overhead, Janus a key and a staff, Iris wings with a winged staff and a pitcher, Plutus a cornucopia). A reference image was generated with Google Gemini (Nano Banana) by the repository owner and turned into 3D with TRELLIS.2 (MIT, Microsoft) via ComfyUI, then cropped at the waist and decimated to about 25k triangles, geometry only (no textures, materials or normals; metadata stripped). About 300 KB each, about 2.4 MB in total. Budget for any future model: at most 30k triangles and 350 KB per file, 3 MB for the set. A model is loaded only when its god is selected (lazy) and cached for the session; nothing is fetched from anywhere else at runtime.
- No third-party photographs, scans or models are used, so there are no third-party credits; see `ASSET-LICENSE`. The held objects are part of each generated model; there are no separate props.
- Models load over http only (browsers block `fetch` from `file://`); without them the procedural bust is used.
- Framing rule: waist-up (head to waist) is the house framing. Every model is shown whole (`bust` kind: it fills the stage). Each has its own yaw, scale, offset and optional crop box in `SCANS` in `3d-gods.js`; `?yaw=`, `?scale=`, `?dy=` and `?crop=y0,y1,x0,x1,z0,z1` override them for the god being viewed. A new mesh drops in by changing only these numbers.
- The loaded triangles are drawn as a hologram surface (fresnel rim, key light, soft scanlines) next to the particles; the points alone do not show a face.
- When a model arrives while the bust is showing, the bust dissolves to the orb and re-forms from the model, so there is no pop.

### Performance notes

- Draw calls: about 15 to 19 measured (the figure's points and surface, the glass sphere, haze and glow sprites, plus 3 to 6 prop meshes per god, merged per tone; each prop is roughly 1k to 4k triangles, estimated from its segment counts) (one point cloud, the glass sphere and haze band, haze, mote and core glow sprites, two eye sprites, the pulse glow, the two procedural wire shells, plus up to a handful of attribute wires).
- Pixel ratio is capped (2, or 1.5 under 700 px wide). The loop pauses when the tab is hidden or the stage is scrolled out of view. Under `prefers-reduced-motion` nothing animates: one static WebGL frame is drawn per state change and expanding snaps between orb and bust.
- Step down stays 3D: if the average frame interval stays above 34 ms over two 90-frame windows, particles drop to 40 percent and the pixel ratio to 1; if it stays slow, particles drop to 25 percent and the extra glow (haze) is switched off. It never switches to a flat look. `?nodegrade` disables the step down, which helps when taking screenshots on a software renderer.
- Query parameters for testing: `god=<id>`, `state=idle|thinking|speaking`, `open=1` (start expanded), `nogl` (show the no-WebGL message), `nodegrade`.
- Measured only on a software renderer in headless Chromium (about 17 to 35 ms per frame, 0.1 to 0.6 ms CPU). Please judge smoothness on a real device.
- Bundle size: the vendored three.js subset (with GLTFLoader) is about 615 KB. It is a vendor file, not counted against the 150 KB limit that applied to the flat mocks.
