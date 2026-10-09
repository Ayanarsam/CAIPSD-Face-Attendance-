'use strict';
/* CAIPSD Attendance: settings. Change values here; nothing else needs editing for these. */
if (window.top !== window.self) { document.documentElement.replaceChildren(); throw new Error('Framing is not allowed'); }

const APP_VERSION = '2.0';           // shown in the app's corner; bump it (and the ?v= in index.html) on every release

// Google Sheet (Apps Script web app) that receives check-ins
const GOOGLE_SHEET_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbyadv7Q4GHWnG9XsP8J8a0rzYZJRYBsdilYWMNmMEhM0s51R6iLd0X7rM523Pzom53i/exec';
const SYNC_TOKEN = 'YbkeTXd27kUurquK_bEcztDRMerQqCi3';

// Attendance rules
const LATE_AFTER = '09:15';   // check-ins after this time (24-hour clock) are marked Late; set to '' to turn off
const VOICE_ON = true;        // set to false to turn off the spoken "Welcome, name"
const MAX_ENROLLED = 2000;

// Libraries and storage
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model";
const KEY = { enr: 'caipsd2_enr', rec: 'caipsd2_rec', oldEnr: 'eyeAttendance_enrollments', oldRec: 'eyeAttendance_records' };

// Speed / accuracy tuning
const FAST_INPUT_SIZE = 160;         // face box + eyes, every frame (fallback engine)
const ID_INPUT_SIZE = 224;           // identity pass
const ID_RETRY_MS = 200;             // retry this fast while a face is still unidentified
const ID_REVERIFY_MS = 8000;         // re-check an identified face this often while it stays in view
const TRACK_MATCH_RATIO = 0.6;       // how far (in face widths) a face may move between frames
const TRACK_TTL_MS = 700;
const MATCH_DISTANCE_THRESHOLD = 0.45;
const MATCH_MARGIN = 0.06;
const BLINK_WINDOW_MS = 4000;        // a blink made while being identified still counts
const PHOTO_WAIT_MS = 300;           // after a blink, wait for eyes to reopen before the check-in photo
const SUCCESS_HOLD_MS = 1900;
