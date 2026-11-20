# agent-hub

A private web hub for talking with a small set of AI agents. Each agent is a glowing glass orb that expands, on click, into a hologram half figure. A side rail lists the eight agents (Hephaestus, Themis, Janus, Atlas, Plutus, Apollo, Iris, Dionysus); a chat panel sits under the stage.

**Status: the shell.** The roster, the 3D bodies, routing and single-owner sign-in work. The chat is not connected to a backend yet and says so in the page. Apollo's card links out to its own chat app. See [`docs/DESIGN.md`](docs/DESIGN.md) for the look and the rules behind it.

- Node 24, plain `http` server with no runtime dependencies, no frontend framework, no build step, no CDN. The browser needs WebGL 2 (otherwise the stage shows the text "3D view needs WebGL 2").
- Sign-in is Cloudflare Access only: the server verifies the `Cf-Access-Jwt-Assertion` JWT against the team's published keys, checks issuer, audience and expiry, and allows exactly one email. There are no passwords or sessions of its own. Everything except `/healthz` and `/event` requires it, and it fails closed.
- `/healthz` is open. `POST /event` is a stub that reads the body, stores nothing and returns 204, so hooks configured elsewhere for the old dashboard do not error.
- Default port: **8787**.

## Configuration

Copy `.env.example` to `.env` and fill it in (it is gitignored).

| Variable             | Required | Meaning                                                                        |
| -------------------- | -------- | ------------------------------------------------------------------------------ |
| `ACCESS_TEAM_DOMAIN` | yes      | Hostname of the Cloudflare Access team, no scheme                              |
| `ACCESS_AUD`         | yes      | Audience tag of the Access application in front of this app                    |
| `OWNER_EMAIL`        | yes      | The single allowed email                                                       |
| `PORT`               | no       | Listen port (default 8787)                                                     |
| `HOST`               | no       | Bind address (default 127.0.0.1; the image sets 0.0.0.0)                       |
| `BIND_ADDR`          | no       | Address compose publishes the port on (default 127.0.0.1)                      |
| `APOLLO_CHAT_URL`    | no       | https link-out for the Apollo card (no credentials in the URL); empty hides it |
| `DEV_AUTH_BYPASS`    | no       | `1` skips Access for local development only                                    |

`DEV_AUTH_BYPASS=1` is accepted only when `NODE_ENV` is explicitly `development` or `test` (case and spaces ignored; unset or anything else is refused) and `HOST` is a loopback address; otherwise the server refuses to start. With it on, only requests from the local machine are served (a request carrying `X-Forwarded-For`, `Forwarded` or any `Cf-*` header is refused, as it came through a proxy or tunnel) and a warning is logged at startup. Never set it on a deployment.

## Run

```bash
npm install
# local development, no Access:
NODE_ENV=development DEV_AUTH_BYPASS=1 npm start   # http://127.0.0.1:8787
# or with Access configured in .env:
npm start
```

With Docker, `docker compose up -d --build` builds the image and publishes the port on `BIND_ADDR`; put it behind a Cloudflare Access application (a tunnel or reverse proxy) so requests carry the JWT header. The compose file refuses to start without the three required variables.

Add `?perf` to the page URL to show the frame-time readout on the stage; `?yaw=`, `?pitch=`, `?roll=`, `?scale=`, `?dy=` and `?god=<id>` tune a model's fit while developing (values are clamped).

## Project layout

- `src/` server, config and the Access verifier.
- `public/` the app: `index.html`, `css/app.css`, `js/app.js` (shell and routing), `js/hub.js` (the 3D viewer), `roster.json` (the one roster file), `models/` (the eight generated figures) and `vendor/` (a three.js subset bundle with its licence and rebuild notes).
- `docs/DESIGN.md` the design identity. `ASSET-LICENSE` lists every asset and its licence.
- `scripts/hook.js` a no-op kept so existing hook entries on the host keep working.

## Tests

```bash
npm test        # node:test, no network
npm run lint    # eslint and prettier --check
```

The tests cover config validation, the Access verifier (signature, issuer, audience, expiry, email, key caching, fail closed), the routes and headers, the roster, the `/event` stub and the removal of the old dashboard.

## Licence

Code: MIT, see `LICENSE`. Generated models and other assets: see `ASSET-LICENSE`.
