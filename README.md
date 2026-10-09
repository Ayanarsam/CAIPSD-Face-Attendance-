# CAIPSD Attendance

Face and blink attendance for the Centre of AI & Professional Skills Development (CAIPSD), The Islamia University of Bahawalpur.

**Live app:** https://ayanarsam.github.io/CAIPSD-Face-Attendance-/

A student looks at the camera, is recognised, blinks once, and is checked in. A check-in photo is taken and the record is sent to the CAIPSD Google Sheet. It works on computers, Android and iPhone, can be installed as an app, and keeps working offline.

## Files

| File | What's in it |
|---|---|
| `index.html` | Page layout |
| `style.css` | Design (colours, layout, animations) |
| `config.js` | **Settings**: late time, voice on/off, Google Sheet link, app version |
| `core.js` | Shared state, helpers, encrypted on-device storage |
| `engine.js` | Camera, face tracking, blink detection, recognition, on-screen boxes |
| `sync.js` | Offline outbox and sending check-ins to the Google Sheet |
| `app.js` | Check-in pop-up and voice, weekly view, enrolment, records, startup, install button, auto-update |
| `sw.js` | Offline cache and update checks |
| `manifest.webmanifest`, `icon-*.png` | App name and icon for "Install app" |
| `tests/` | Automatic checks (code checker + browser tests) |

The browser loads the scripts in this order: `config.js`, `core.js`, `engine.js`, `sync.js`, `app.js`. They share one scope, so a name defined in an earlier file can be used in a later one.

## Common changes

- **Late time / voice:** edit `LATE_AFTER` or `VOICE_ON` in `config.js`.
- **Google Sheet link:** edit `GOOGLE_SHEET_WEB_APP_URL` and `SYNC_TOKEN` in `config.js`.

## Releasing a change

1. Make the change on a branch (not directly on `main`, which is the live site).
2. Set a new version so every device downloads the new files:
   ```
   npm run release 2.1
   ```
3. Run the checks locally (optional, GitHub runs them too):
   ```
   npm install
   npx playwright install chromium
   npm run check
   ```
4. Push the branch and open a pull request. Wait for the green ✓ from the **Check** workflow.
5. Merge into `main`. GitHub Pages publishes it in a minute or two, and the office device updates itself within 15 minutes, when nobody is at the camera.

The version shown in the app's bottom-left corner tells you which release a device is running.

## What the automatic checks cover

- The code checker: undefined names, duplicates, unreachable code, and that every file carries the same version.
- Browser tests (real app, real face engine, a test camera video):
  - opens quickly with the security rule on, without errors, version shown
  - camera blocked: the message stays on screen
  - check-ins reach the Google Sheet, even two in a row while it is slow
  - works offline: reopens without internet, saves check-ins, sends them when back online
  - restarts itself if the face engine keeps failing
  - recognises an enrolled face at normal distance and asks for a blink

The Google Sheet is replaced by a fake during tests, so nothing real is sent. The test face (`tests/face.png`) is NASA's public-domain portrait of astronaut Eileen Collins.

## How it works (short)

- **Recognition:** face-api.js (TinyFaceDetector, 68-point landmarks, 128-number face fingerprint). It runs on a close-up around the tracked face, so people are recognised from normal standing distance.
- **Blink:** MediaPipe Face Landmarker (blink scores), with face-api eye shapes as a backup until it loads.
- **Storage:** enrolled faces and records are encrypted on the device with a key that can't be exported. Check-ins wait in an encrypted outbox until the Sheet receives them.
- **Security:** a strict Content Security Policy allows only this site's own scripts and the pinned libraries.

## Known limits

- The Google Sheet link and token are in this public repo, so anyone could send fake rows to the Sheet. Signed check-ins (a secret key on the office device, checked by the Sheet's script) would fix that.
- Enrolled faces live only on the device where they were enrolled.
- A blink can be faked with a video of the person; the check-in photo (fixed office backdrop) is the safeguard.
