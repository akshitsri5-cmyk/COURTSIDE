# COURTSIDE

Multi-camera browser-based basketball referee **assistant**, not an automated referee. The Node server handles pairing and signalling; a dashboard accepts local cameras and WebRTC streams from paired phones, analyzes evidence, and lets a human referee manage calls, scoring and clocks.

## Install and run

Requires Node.js 20+ and a modern browser (Chromium recommended).

```sh
npm install
npm run models
npm start
```

Open the dashboard at `http://localhost:8080` on the server device, or the HTTPS URL printed by the server. By default, HTTP listens on port 8080 and HTTPS on 8443. `npm run models` downloads YOLO11n ONNX and MediaPipe Pose weights. **Ultralytics YOLO11n model weights are AGPL-3.0 licensed**; review the license and obligations before distributing or deploying. Camera permissions generally require HTTPS on phones (localhost is a browser exception).

## HTTPS and remote access

- **Built-in:** first startup generates and retains a self-signed certificate under `data/certs/`. Phones must trust/accept it; some mobile browsers will not permit camera access with an untrusted certificate.
- **Your certificate:** set `CERT_FILE=/path/fullchain.pem` and `KEY_FILE=/path/privkey.pem` before `npm start`.
- **mkcert:** create a locally trusted certificate for the relevant DNS names/IPs, configure `CERT_FILE` and `KEY_FILE`, and install mkcert's local CA on each participating phone.
- **Caddy / Let's Encrypt:** terminate HTTPS on a domain in a reverse proxy and proxy HTTP **and WebSocket upgrades** to the Node server. Publish the externally reachable URL using `PUBLIC_URL=https://your-domain`.
- **Cloudflare Tunnel:** point a tunnel hostname at the local Node HTTP service and set `PUBLIC_URL=https://your-tunnel-hostname`. Ensure WebSockets work; TURN may still be necessary for WebRTC media.

For unusual network setups configure `HTTP_PORT`, `HTTPS_PORT`, `DATA_DIR`, or `PUBLIC_URL`. `DISABLE_HTTPS=1` is useful for local automated tests, not phone deployment.

## WebRTC / TURN

Default ICE configuration uses a public STUN server. Some NATs/firewalls need a reachable TURN server:

```sh
TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349 \
TURN_USERNAME=your-user TURN_CREDENTIAL=your-secret npm start
```

`TURN_URLS` is comma-separated; `TURN_USERNAME` and `TURN_CREDENTIAL` are TURN authentication values. Set up and secure a real TURN service before using those placeholders.

## Pair phones

Start the dashboard and either scan its QR link with each phone or open `/camera.html` on an HTTPS origin and enter its **6-digit code**. Allow camera access and press **Join**. The pairing link includes a match ID and join key. Each phone has a stable per-tab camera identity; connection recovery and re-offering after phone/dashboard reloads are automatic. Use **New code** to rotate future pairing credentials. For local video, select a device and choose **Add local camera**.

## Game modes (half court only)

* **1v1 half court** (default): Player A vs Player B, 1 point inside the arc, 2 beyond, first to **11**, 10 min, 12 s shot clock. Sides follow player identity, so identical clothes are fine.
* **FIBA 3x3 half court**: 1 & 2 points, first to 21. **Half court 2 & 3 pts**: classic scoring.

**AUTO-CALL** (on by default): fouls/violations whose evidence meets the threshold are called immediately (clock stops, counted in FOULS); weaker evidence stays **NEEDS HUMAN REVIEW**. The referee can **Overturn** any auto-call. With one camera most fouls stay in review; auto-calls need two angles. Evidence thresholds are not yet validated on real games, so expect wrong calls.

**Game recording**: enter a location (or 📍 GPS) and press **● Record game**. Every camera angle is saved as `COURTSIDE_<match>_<YYYY-MM-DD_HH-MM>_<camera>.webm` plus `…_match-info.json` (match, date, start/end time, time zone, location, cameras, final score, score history, calls, timeline). Chrome/Edge write straight to a folder you choose; other browsers download the files when you stop.

## Phones as cameras (dashcam)

* **Ball colour** (top bar): *any*, *white / grey* (e.g. Jordan outdoor balls) or *orange*. Colour candidates must be round, ball-sized relative to the players in view and moving; the detector's own ball detections work for any colour.
* **● Record on this phone** (camera page): full-quality recording on the phone itself (6 Mbps), independent of the network; saved to the phone as `COURTSIDE_<camera>_<date>_<time>.mp4/webm` when stopped.
* Connection watchdog: a phone only restarts its connection after a real failure or 25 s+ without progress (with back-off), and each phone streams at ≤1.8 Mbps so two phones fit on mobile uplinks / one relay.

## Apple Watch

* **Watch view**: the dashboard's ⌚ panel shows a private link (`/watch/<match>?k=<key>`). Send it to yourself in Messages and tap it on the watch: score, game clock, shot clock, possession, the last calls and camera status, refreshed every 3 s. Plain HTML, no JavaScript (watchOS's built-in web view), no Apple developer account. Rendered and tested at Apple Watch size in Chromium; not yet tried on a physical watch.
* **Tap alerts**: install the free **ntfy** app on the iPhone, press *Random topic*, subscribe to it in ntfy. Calls, baskets, game over and dropped cameras arrive as iPhone notifications, which the Apple Watch mirrors with a haptic. Keep the link and topic private.

## Player identity across cameras

* **Court visible on every camera** → identities come from court positions (`P1`, `P2`…), robust even with similar clothes.
* **No court / not all cameras calibrated** → identities come from **clothing colour**: in 1v1 each person is **Player A** or **Player B** on every camera. Works when the two players wear clearly different colours; identical outfits cannot be told apart this way.
* Court detection now rejects non-court scenes (rooms, streets): a fit must be far above the chance level of the image's line density, show key/free-throw/3-point markings, cover ≥15 % of the picture and give a plausible camera height.

## Court calibration (automatic, half court)

Nothing to click. Each camera searches for the court lines in the background (every few seconds until found, and again if the camera is bumped or the lines disappear). COURTSIDE assumes a **half-court game**: the filmed basket is always treated as the same basket, and the camera's physical position (above the floor) fixes the remaining mirror ambiguity, so **every camera gets the same court frame automatically**. That shared frame is what gives a player the same ID (P1, P2…) in every camera, and it locates the rim for scoring.

Tips: mount phones high (≥2 m) at the side or corner, landscape, with as many court lines visible as possible (baseline, key, free-throw line, 3-point line). The camera card shows `Court: auto ✓ NN%` when found or `court not found — make the court lines visible`.

**Manual court fix** (on each camera card) lists **half-court points only** (key corners, free-throw line ends, 3-point line ends, baseline corners, halfway line ends — left/right as seen from the halfway line facing the basket) plus **Mark the rim**. It is only a fallback for courts whose lines can't be detected (faded paint, heavy occlusion): click ≥4 named points, or mark the rim if it wasn't located.

Automatic detection is validated on synthetic court renders from four camera angles (≤1.6 px error, correct shared orientation); it has **not yet been validated in real gyms**.

## Features

Live local/paired phone camera feeds; QR/code pairing and reconnection; camera flip, pause, torch and video quality controls (subject to device support); network and camera health indicators; court line detection and per-camera calibration; player/ball detection, pose estimation, tracking and multi-camera fusion; rule/violation evidence heuristics and referee review; score adjustment/undo/team swap; game and shot clocks; manual flags and timeline; flash sync checks; JSON export. Media processing performance depends heavily on available hardware.

## Architecture / module map

| Area | Purpose |
| --- | --- |
| `server/server.js` | HTTP(S), static/model assets, QR, ICE config, WebSocket endpoint, match logs |
| `server/signalling.js` | Match registry, host/camera tokens, six-digit pairing, reconnection messages |
| `public/js/app/dashboard.js` | Dashboard event wiring, calibration UI, clocks, scoring, alerts |
| `public/js/app/camera-client.js` | Phone capture, WebRTC offer, controls, reconnection, telemetry |
| `public/js/app/camera-manager.js` | Host-side local/remote cameras, WebRTC answers, ICE, stats |
| `public/js/app/signal-client.js` | Reconnecting WebSocket signalling and clock offset |
| `public/js/app/pipeline.js`, `detectors.js`, `calib-worker.js` | Frame analysis, model inference, calibration worker |
| `public/js/core/` | Court geometry/homography, tracking, camera sync, fusion, possession/action and rules, clocks, scores, alerts and recording |
| `public/js/core/rules/` | Basketball ruleset parameters |
| `tests/unit/`, `tests/e2e/`, `tests/helpers/` | Logic tests, Playwright browser/WebRTC tests, synthetic scenes |
| `tools/download-models.js` | Model weight downloader |

## Validation and limitations

The logic has been tested on **synthetic multi-camera basketball scenes and a real photograph**, **not on labelled basketball-game footage**. The real photo is a general object/person detection fixture, not validation of game decisions. Detection, tracking, court geometry, and rules in actual games remain unverified. **Evidence scores are uncalibrated heuristics**, not empirically calibrated probabilities. **Every alert requires an explicit referee decision**; the app is a decision-support aid and must not be used to officiate unattended. Seek consent and observe applicable laws before recording.

For meaningful real-game reliability, further work requires: a **basketball-fine-tuned person/ball detector** (especially a fine-tuned ball model); a **learned action-recognition model**; **confidence calibration on labelled full games**; **real-gym court-detection validation** with varying floors, lighting and camera angles; and **GPU-laptop validation/optimization for 3+ simultaneous cameras**. Robustness to occlusion, synchronisation drift and connection quality also needs real-world testing.

## Tests

```sh
npm test             # Node unit/logic tests
npm run test:e2e     # Playwright Chromium tests (install with: npm i -D playwright && npx playwright install chromium)
npm run test:all     # Both suites
```

**Detector choice** (top bar). Default: **EfficientDet-Lite2 + MediaPipe Pose in a background worker** (GPU when available). Detection and pose never run on the page's main thread, so the dashboard stays responsive (measured: ~7 ms of page time per analysed frame, no blocking). On the real test photo it finds 3 of 3 clearly visible people at >0.5 confidence (COCO-SSD: 2). If Lite2 is slower than 0.7 s/frame on the device, it switches itself to the faster EfficientDet-Lite0. Alternatives: COCO-SSD (main thread), YOLO11n CPU, YOLO11n WebGPU (experimental). Ball: model detections plus orange-blob tracking that follows a *moving* basketball the detector misses and ignores static orange objects.

Temporal rules need frames: travelling/double dribble need roughly ≥8 analysed frames per second (a GPU laptop); fouls work down to ~1 fps (one contact frame is accepted at low rates).

**Validation of this revision:** `npm test` **40/40 passing** with the real dependencies. `npm run test:e2e` ran **three consecutive times, 3/3 passing each run** in headless Chromium (real WebRTC pairing by QR link and code, phone reload, dashboard reload, phone close; YOLO11n + MediaPipe on a real photo; court auto-calibration through the UI on a synthetic court feed). A scripted dashboard sweep clicked every control (camera flip/pause/torch/quality/lines/analysis/remove, calibration auto/flip/rim/save, score, undo, team swap, clock, shot clock, next period, manual flags, new code, export, alert review with clip playback and confirm/review decisions, flash sync) with **zero console errors**; see `docs/dashboard.png`. CPU-only inference here is ~1.5 s/frame (WASM, no GPU), so real-time multi-camera analysis needs a WebGPU-capable laptop. The synthetic-scene logic tests do not validate real-game accuracy.
