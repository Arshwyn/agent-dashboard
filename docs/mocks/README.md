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
