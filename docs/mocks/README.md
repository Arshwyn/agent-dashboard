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

## 3D prototype (slice 0b)

The picks after the flat mocks: orb-first, layout B, dark default. `3d-hephaestus.html` tests whether real depth fixes the "flat" feeling.

- Orb (idle): three tilted glowing rings with a faint wide copy each (cheap additive bloom), a particle shell and core, an orbiting mote, and pointer-driven camera parallax.
- Bust (active): a hologram figure made only from generated geometry: a point-cloud shell, wire shells for head and shoulders, an anvil and a floating hammer in wire, emissive eyes and a core that travels from the orb centre to the chest. No meshes or textures are loaded, so there is nothing to license beyond three.js itself.
- Morph: one `Points` object holds both shapes; each particle flies from its orb position to its bust position on a staggered delay with a swirl, so the orb dissolves into the figure. Speaking adds a pulse ring, eye and core flicker and a moving scan band.
- The 3D stage keeps dark glass tones in both themes (like a display); the page chrome follows the dark or designed light set.

### Performance notes

- Draw calls: 21 (one point cloud, 6 ring tori, 2 for the mote, core glow and icosahedron, 2 eyes, the pulse ring and 7 wire parts for head, shoulders, anvil and hammer). The readout in the stage corner shows live frame time, CPU time per frame, draw calls, point count and pixel ratio.
- Pixel ratio is capped (2, or 1.5 under 700 px wide); degrading drops it to 1.
- The loop pauses when the tab is hidden or the stage is scrolled out of view. Under `prefers-reduced-motion` nothing animates: the page draws one frame per state change and the state switch snaps between orb and bust.
- Adaptive fallback: if the average frame interval stays above 34 ms over two 90-frame windows, particles drop to 40 percent and the pixel ratio to 1; if it stays slow, the page switches to the flat SVG renderer. Without WebGL 2, or with `?flat` in the URL, or via the Renderer switch, the flat renderer is used.
- Measured only on a software renderer in headless Chromium (about 17 to 30 ms per frame, 0.2 to 0.6 ms CPU); real GPUs will be much faster. Please judge smoothness on a real device.
- Bundle size: the vendored three.js subset is about 540 KB. It is a vendor file, not counted against the 150 KB limit that applied to the flat mocks.
