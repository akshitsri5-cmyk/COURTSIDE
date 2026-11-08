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

## Calibrate each camera

1. Position each camera to cover as much of the playing court as practical and open its **Calibrate** control.
2. Use **Auto-detect court lines**, inspect the result, and try a fresh frame if needed. This is experimental in real gyms.
3. Use **Flip ends** and **Flip sides** until court ends/sides have the **same naming and orientation across every camera**, even when cameras look from opposite directions.
4. If detection fails, select corresponding court landmarks on the calibration canvas and use **Compute from points**. Mark the **left and right rims** separately.
5. Save calibration for each camera. Recalibrate if a device moves or its field of view changes.

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

**Detector choice** (top bar): the default is **COCO-SSD** (TF.js, GPU-accelerated through WebGL, fast). **YOLO11n CPU** is more accurate (on the real test photo it finds 3 of the 3 clearly visible people at >0.5 confidence vs 2 for COCO-SSD) but takes ≈1 s per frame without a GPU. **YOLO11n WebGPU is experimental**: on one real Windows GPU it produced tiny, misplaced boxes, and it could not be tested in the development environment. COCO-SSD loads its weights from storage.googleapis.com and needs internet access; if that fails the dashboard falls back to YOLO11n CPU.

**Validation of this revision:** `npm test` **40/40 passing** with the real dependencies. `npm run test:e2e` ran **three consecutive times, 3/3 passing each run** in headless Chromium (real WebRTC pairing by QR link and code, phone reload, dashboard reload, phone close; YOLO11n + MediaPipe on a real photo; court auto-calibration through the UI on a synthetic court feed). A scripted dashboard sweep clicked every control (camera flip/pause/torch/quality/lines/analysis/remove, calibration auto/flip/rim/save, score, undo, team swap, clock, shot clock, next period, manual flags, new code, export, alert review with clip playback and confirm/review decisions, flash sync) with **zero console errors**; see `docs/dashboard.png`. CPU-only inference here is ~1.5 s/frame (WASM, no GPU), so real-time multi-camera analysis needs a WebGPU-capable laptop. The synthetic-scene logic tests do not validate real-game accuracy.
