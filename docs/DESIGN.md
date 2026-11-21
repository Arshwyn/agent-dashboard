# Design

This is the identity of the agent hub: a private page for talking with a small set of AI agents. It is its own design, not a template; the rules below are the universal ones plus what is specific to this app.

## Purpose and audience

One owner, signed in through Cloudflare Access, reaches each agent and chats with it as text. The look should make each agent feel like a distinct presence without getting in the way of reading and typing. Text chat only for now; no voice, no video.

## Mood

Quiet, dark glass, a little theatrical. The default is dark: a near-black page with a lit stage, so the glowing bodies are the brightest thing on screen. A designed light set exists for daytime use; it follows the system preference unless the owner picks Dark or Light in the header. The light set re-tones the page chrome (surfaces, text, accent) but the stage stays dark glass in both themes, like a display.

## The body

- **Primary look: the orb.** Each agent is a soft glass sphere: a low-alpha fresnel rim, a glowing interior, a wide haze band, a particle shell and core, one orbiting soft mote, and gentle pointer parallax. No hard ring lines or outlines.
- **Expanded look: a half figure.** Clicking the orb (or pressing Enter or Space when it is focused) dissolves the particles into the agent's half figure, a hologram drawn with a fresnel rim, a key light, soft scanlines and a rising scan sweep. Clicking again, or pressing Esc, collapses it back to the orb. Choosing another agent always starts as the orb.
- **The figures.** Eight generated half figures (head to waist), each holding its own attribute: a stylised reference image was generated with Google Gemini (Nano Banana) by the repository owner and turned into a 3D model with TRELLIS.2 (MIT, Microsoft) through ComfyUI; the models are CC0 1.0, dedicated by the owner (see `ASSET-LICENSE`). Geometry only, about 25k triangles each, 2.4 MB in total. Each model has its fit (yaw, scale, offset) in the viewer; a replacement mesh needs only those numbers. The pilot agent (Arshwyn, the orchestrator) has no generated figure yet and uses the procedural bust until one exists.
- **States.** Idle, thinking and speaking come from the stage's `data-state`. Thinking contracts and quickens the orb and speeds the scan sweep; speaking adds a pulse glow and a flicker. The chat drives them: waiting for a reply is thinking (a tool call shows a short generic label such as "reading" and returns to thinking), the first streamed text is speaking, a finished reply is idle, and a failed run is error.
- **WebGL 2 is required.** There is no flat or 2D fallback. Without WebGL 2 the stage shows the plain text "3D view needs WebGL 2". Performance step-down lowers particle count, pixel ratio and glow, never to a flat look.

## Layout

The page is one viewport tall: the stage has a capped height and the chat takes the rest, with its messages scrolling inside it, so the composer is always visible at 1280x800 and 390x844 without scrolling the page (on a very short window the page scrolls instead). On a phone the roster is a five-column grid of small tiles.

Layout B, a persistent side rail: the roster of agents on the left (a row of tiles on a phone), the stage above the chat in the main column. One agent is selected at a time and has its own route, `/agent/<id>`. The rail is the roster tile for every agent: a small glowing dot in the agent's palette and its name.

Apollo's card shows the same body but its chat panel is a link-out to the separate chat app (`APOLLO_CHAT_URL`), which keeps its own sign-in and per-user separation. The longer-term goal is a unified view where Apollo is simultaneous with the others; that needs the owner's approval first.

## Palette roles

Each agent has three tones: a main tone (rim, rings, panels), a second tone (inner glow, accents) and a highlight (scan sweep, eyes, mote). They live in `public/roster.json` with the agent's name, role line and motif.

| Agent      | Role              | Tones                               |
| ---------- | ----------------- | ----------------------------------- |
| Arshwyn    | Orchestrator      | cool steel, slate blue, white       |
| Hephaestus | Builder           | forge amber, ember, pale gold       |
| Themis     | Quality gate      | cool silver-blue, brass, near white |
| Janus      | Gatekeeper        | teal, violet, pale blue-white       |
| Atlas      | Operator          | sky blue, deep blue, pale blue      |
| Plutus     | Finance           | emerald, gold, pale green           |
| Apollo     | Coach             | sun gold, laurel green, pale gold   |
| Iris       | Mail and calendar | rose, sky, pale yellow              |
| Dionysus   | Travel and food   | grape purple, wine red, pale lilac  |

## Type, shape and spacing

- A serif display face (system Georgia stack) for names and headings, the system sans for body text, a monospace for the optional frame-time readout. No web fonts, no CDN.
- Colours, sizes, spacing and radii are named custom properties defined once in `public/css/app.css`; components use roles such as surface, text and accent, never raw values. Dark is the base set; the light set is a designed second set, not an inversion.
- Rounded, soft shapes: a large radius on the stage, rail and chat, pill shaped controls and hints.
- Mobile first. Touch targets are at least 44 px, nothing scrolls sideways, the main task (pick an agent, read, type) works one-handed on a phone.

## Motion

Only transform and opacity animate in CSS; the stage animates through WebGL. `prefers-reduced-motion` is respected: CSS animation and transitions are off, the 3D scene draws a single static frame per state (still WebGL, never flat art), expanding snaps between the orb and the figure, and parallax and idle drift stop. The orb and figure remain clearly different without motion. The loop also pauses when the tab is hidden or the stage is off screen.

## Interaction and accessibility

- The stage is a button: pointer cursor, hover and focus glow, a visible focus ring, `aria-expanded`, Enter and Space to toggle, Esc to collapse, and a first-view hint pill.
- The rail is a list of links with `aria-current` on the selected agent; each agent has a real URL. The agent that holds the one running reply carries a small "running" pill (outline, dot and the word, never colour alone), refreshed every few seconds while the page is visible. Each hub agent's chat shows one "Access:" line from the roster, so the reach of the agent is visible before sending; the Apollo link-out has none.
- Status (Idle, Thinking, Speaking) is text as well as colour. Streamed text is not announced word by word (the message log is `aria-live=off` and `aria-busy` while a reply streams); a separate polite status region announces when a reply is complete, stopped or failed.
- The chat panel states its condition in words: an empty state, a streaming reply with a Stop button, a plain error line per failure, a plain notice at the end of the log for a refused send (another reply running, rate limit, switched off, not reachable, too long, expired sign-in) that never looks like a reply and leaves the typed text in the box, a reply that is still running in another tab shown as "Reply in progress..." with Stop available, an offline notice when the gateway is unreachable and a notice when web chat is switched off. The pilot agent is the only one with a live chat; the others say they are not enabled yet. Replies and the user's text are drawn as plain text (never HTML), and narration before a tool call is shown as a muted note.
- Light and dark both keep text contrast at a readable level; the stage uses its own dark tokens in both.

## What this is not

No mascots or cartoon art, no pixel art, no dashboards of pipeline metrics, no flat fallback, no chat bubbles with made-up content.
