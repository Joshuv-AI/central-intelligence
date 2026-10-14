/* Lane G — DOM surfaces: B4 feed, B5 ticker, B6 event/connection card,
   B7 status/system, B8 region wire, B9 guide, B10 honest states.
   Binds to the static skeleton in src/ui/templates/intel.html.
   §F throughout: plain language first, jargon only with its gloss. */
import { store, on, runtime } from './store.js';
import {
  esc, SEV_COLORS, SEV_LABEL, SEV_PLAIN, DOMAIN_LABELS, REGIONS, regionMatches,
  plainDirection, plainScore, plainConnectionSummary, cleanTitle,
  FEED_KIND_PLAIN, summarizeSources, lastSweepAt, timeAgo, fmtTime, fmtCoords, isGeo,
  formatReasons, whyLinkedLine, SEV_FLOORS, passesSeverityFloor,
} from './model.js';
import { provenanceLine, confidenceLine } from '../ui/provenance.js';
import { saveOfflineSnapshot, loadOfflineSnapshot, createOfflineWatch } from './offline.js';
// Wave 2 (J4-01 / J4-02 / J4-03 / J4-13): fusion surfaces.
import { rankWhatMatters, rankedHeadline, RANKING_EXPLAINER, TOP_N } from '../fusion/whatMatters.js';
import {
  loadPins, savePins, addPin, removePin, pinSubtitle, pinDigest,
  createPinWatcher, notifyEnabled, setNotifyEnabled, requestNotifyPermission,
  sendDesktopNotification, PIN_DIGEST_WINDOW_MS,
} from './pins.js';
import {
  CHANGE_WINDOWS, CHANGE_KIND_PLAIN, CHANGE_KIND_COLOR,
  fetchChanges, timelineTicks, maxTick, pastLabel,
} from './changes.js';
import {
  nearbyAll, formatDistance, emptyStateText, NEARBY_CLASSES,
} from './proximity.js';

const CSS = `
#ci-intel-root{position:fixed;right:12px;top:84px;width:344px;max-width:calc(100vw - 24px);z-index:60;display:flex;flex-direction:column;background:rgba(7,13,24,.92);border:1px solid rgba(127,206,240,.28);border-radius:12px;color:#e8f2fa;font:13px/1.45 system-ui,sans-serif;backdrop-filter:blur(8px);max-height:calc(100vh - 190px)}
#ci-intel-root.ci-collapsed{display:none}
.ci-head{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid rgba(127,206,240,.16)}
.ci-title{font-weight:700;letter-spacing:.08em;font-size:12px}
.ci-pill{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid rgba(127,206,240,.35);white-space:nowrap}
.ci-pill .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;background:#7FCEF0}
.ci-pill.live .dot{background:#4ade80}.ci-pill.stale .dot,.ci-pill.reconnecting .dot{background:#FFD166}.ci-pill.down .dot{background:#FF5A5A}
.ci-x{background:none;border:0;color:#9fc3da;font-size:16px;cursor:pointer;padding:2px 4px}
.ci-tabs{display:flex;gap:2px;padding:6px 8px 0}
.ci-tab{flex:1;background:rgba(127,206,240,.07);border:1px solid transparent;border-bottom:0;border-radius:7px 7px 0 0;color:#b9d4e6;padding:6px 2px;font-size:11.5px;cursor:pointer;min-height:32px}
.ci-tab[aria-selected="true"]{background:rgba(127,206,240,.16);color:#fff;font-weight:600}
.ci-body{overflow-y:auto;padding:10px 11px;min-height:120px}
.ci-empty{color:#9fc3da;padding:14px 4px}
.ci-feed-item,.ci-conn-card{display:block;width:100%;text-align:left;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-left:3px solid #7FCEF0;border-radius:8px;padding:8px 9px;margin:0 0 8px;cursor:pointer;color:inherit}
.ci-feed-item:hover,.ci-conn-card:hover{background:rgba(127,206,240,.1)}
.ci-item-top{display:flex;gap:6px;align-items:baseline;font-size:10.5px;color:#9fc3da;text-transform:uppercase;letter-spacing:.05em}
.ci-item-top .ci-when{margin-left:auto;text-transform:none;letter-spacing:0}
.ci-headline{display:block;font-weight:600;margin-top:2px}
.ci-sub{display:block;color:#b9d4e6;font-size:12px;margin-top:2px}
.ci-brief{border:1px solid rgba(127,206,240,.25);border-radius:8px;padding:8px 9px;margin-bottom:10px;background:rgba(127,206,240,.06)}
.ci-brief b{font-size:14px}
.ci-chain{margin-top:6px}
.ci-step{display:flex;gap:7px;align-items:baseline;margin:3px 0;font-size:12px}
.ci-step .sd{width:8px;height:8px;border-radius:50%;flex:none;position:relative;top:1px}
.ci-step .role{color:#9fc3da;font-size:10.5px;text-transform:uppercase;min-width:44px}
.ci-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.ci-tag{font-size:10.5px;border:1px solid rgba(255,255,255,.18);border-radius:99px;padding:1px 7px;color:#b9d4e6}
.ci-region-row{display:flex;width:100%;justify-content:space-between;background:none;border:0;border-bottom:1px solid rgba(255,255,255,.06);color:inherit;padding:10px 4px;cursor:pointer;min-height:44px;align-items:center}
.ci-region-row.active{color:#7FCEF0;font-weight:700}
.ci-src-row{display:flex;gap:7px;align-items:baseline;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:12px}
.ci-src-row .sd{width:8px;height:8px;border-radius:50%;flex:none;position:relative;top:1px}
.ci-src-row .meta{margin-left:auto;color:#9fc3da;font-size:11px;text-align:right}
.ci-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.ci-stat{border:1px solid rgba(255,255,255,.09);border-radius:8px;padding:7px 9px}
.ci-stat .k{font-size:10.5px;color:#9fc3da;text-transform:uppercase;letter-spacing:.05em}
.ci-stat .v{font-size:15px;font-weight:700;display:block;margin-top:1px}
.ci-guide h4{margin:12px 0 4px;font-size:12.5px}
.ci-guide h4:first-child{margin-top:0}
.ci-guide p,.ci-guide li{color:#cfe2ef;font-size:12.5px}
.ci-guide ul{margin:4px 0;padding-left:16px}
.ci-sw{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
#ci-intel-open{position:fixed;right:12px;top:84px;z-index:60;background:rgba(7,13,24,.92);border:1px solid rgba(127,206,240,.35);color:#e8f2fa;border-radius:99px;padding:9px 14px;font:600 12px system-ui,sans-serif;cursor:pointer;min-height:44px}
#ci-intel-banner{position:fixed;top:84px;left:50%;transform:translateX(-50%);z-index:61;background:rgba(40,26,4,.95);border:1px solid #FFD166;color:#ffe9b0;border-radius:9px;padding:8px 12px;font:12.5px system-ui,sans-serif;display:flex;gap:10px;align-items:center;max-width:calc(100vw - 24px)}
#ci-intel-banner.down{background:rgba(42,8,8,.95);border-color:#FF5A5A;color:#ffc9c9}
#ci-intel-banner button{background:none;border:1px solid currentColor;color:inherit;border-radius:6px;cursor:pointer;padding:2px 8px}
#ci-ticker{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:60;display:flex;gap:9px;align-items:center;background:rgba(7,13,24,.92);border:1px solid rgba(127,206,240,.28);border-radius:99px;color:#e8f2fa;padding:8px 16px;font:12.5px system-ui,sans-serif;cursor:pointer;max-width:min(680px,calc(100vw - 24px));backdrop-filter:blur(8px)}
#ci-ticker .dot{width:8px;height:8px;border-radius:50%;flex:none}
#ci-ticker-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ci-ticker .ci-ticker-label{font-size:10.5px;letter-spacing:.07em;color:#9fc3da;flex:none}
#ci-card{position:fixed;left:12px;bottom:64px;width:330px;max-width:calc(100vw - 24px);z-index:62;background:rgba(7,13,24,.95);border:1px solid rgba(127,206,240,.3);border-left:3px solid #7FCEF0;border-radius:12px;color:#e8f2fa;font:13px/1.45 system-ui,sans-serif;padding:12px 13px;max-height:60vh;overflow-y:auto}
#ci-card h3{margin:3px 20px 6px 0;font-size:14.5px}
#ci-card .k{color:#9fc3da;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
#ci-card .row{display:flex;justify-content:space-between;gap:10px;padding:2.5px 0;border-bottom:1px solid rgba(255,255,255,.05)}
#ci-card .row .v{text-align:right}
#ci-card a{color:#7FCEF0}
.ci-conn-link{display:block;width:100%;text-align:left;background:rgba(127,206,240,.08);border:1px solid rgba(127,206,240,.2);border-radius:7px;color:#cfe9fa;padding:6px 8px;margin:4px 0;cursor:pointer;font-size:12px}
/* J4-15 severity dial: one plain-language filter for feed + connections + markers. */
.ci-sev{display:flex;gap:4px;padding:7px 8px 3px;align-items:center}
.ci-sev .k{color:#9fc3da;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-right:2px}
.ci-sev-btn{flex:1;background:rgba(127,206,240,.07);border:1px solid rgba(127,206,240,.25);border-radius:8px;color:#b9d4e6;font:600 12px system-ui,sans-serif;min-height:44px;cursor:pointer;padding:6px 4px}
.ci-sev-btn[aria-pressed="true"]{background:rgba(127,206,240,.22);color:#fff;border-color:#7FCEF0}
.ci-why{font-size:12px;color:#cfe2ef;margin:6px 0 2px}
.ci-prov{font-size:11px;color:#9fc3da}
@media (max-width:768px){
 #ci-intel-root{top:auto;bottom:58px;right:8px;left:8px;width:auto;max-height:52vh}
 #ci-intel-open{top:auto;bottom:58px;right:8px}
 #ci-intel-banner{top:8px}
 #ci-card{bottom:auto;top:8px;left:8px;right:8px;width:auto;max-height:52vh}
 #ci-ticker{bottom:8px}
}`;

/* Wave 2 (J4-01 / J4-02 / J4-03 / J4-13) surfaces. §L.1: every new button
   is ≥44px; toasts reflow as a bottom sheet on mobile; the intel panel
   itself keeps the mobile-panels-docked default. */
const CSS_WAVE2 = `
.ci-title2{font-weight:700;font-size:13px;letter-spacing:.02em}
.ci-top-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:10px 0 4px}
.ci-why-btn{background:none;border:1px solid rgba(127,206,240,.35);color:#7FCEF0;border-radius:8px;font:600 12px system-ui,sans-serif;min-height:44px;padding:6px 12px;cursor:pointer}
.ci-why-box{border:1px solid rgba(127,206,240,.25);border-radius:8px;padding:8px 10px;margin:0 0 8px;background:rgba(127,206,240,.05)}
.ci-why-box p{margin:0;font-size:12px;color:#cfe2ef}
.ci-top-row{display:grid;grid-template-columns:26px 1fr auto;gap:8px;align-items:start;width:100%;text-align:left;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-left:3px solid #7FCEF0;border-radius:8px;padding:9px;margin:0 0 8px;cursor:pointer;color:inherit;min-height:44px}
.ci-top-row:hover{background:rgba(127,206,240,.1)}
.ci-top-rank{font-weight:800;font-size:15px;color:#7FCEF0;padding-top:1px}
.ci-top-main{min-width:0}
.ci-sevchip{font-size:10.5px;font-weight:700;border-radius:99px;padding:2px 8px;color:#06121f;white-space:nowrap;margin-top:2px}
.ci-pin-sec{border:1px solid rgba(255,209,102,.3);border-radius:8px;padding:8px 9px;margin:0 0 8px;background:rgba(255,209,102,.05)}
.ci-pin-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline;font-size:12px;color:#ffe9b0}
.ci-pin-count{font-weight:700;white-space:nowrap}
.ci-pin-item{display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid rgba(255,255,255,.06);color:#cfe2ef;padding:8px 2px;cursor:pointer;font-size:12px;min-height:44px}
.ci-pin-item:last-child{border-bottom:0}
.ci-win{display:flex;gap:6px;margin:2px 0 10px}
.ci-win-btn{flex:1;background:rgba(127,206,240,.07);border:1px solid rgba(127,206,240,.25);border-radius:8px;color:#b9d4e6;font:600 12px system-ui,sans-serif;min-height:44px;cursor:pointer;padding:6px 4px}
.ci-win-btn[aria-pressed="true"]{background:rgba(127,206,240,.22);color:#fff;border-color:#7FCEF0}
.ci-tl{display:flex;align-items:flex-end;gap:2px;height:44px;padding:6px 4px 2px;border:1px solid rgba(127,206,240,.2);border-radius:8px;background:rgba(7,13,24,.6);margin-bottom:4px}
.ci-tl-bar{flex:1;background:rgba(127,206,240,.55);border-radius:2px 2px 0 0;min-height:2px}
.ci-tl-bar.zero{background:rgba(127,206,240,.12)}
.ci-scrub{width:100%;min-height:44px;accent-color:#7FCEF0;margin:0 0 4px;cursor:pointer}
.ci-past{background:#3a2b06;color:#ffe9b0;border:1px solid #FFD166;border-radius:8px;padding:9px 10px;font:700 12.5px system-ui,sans-serif;margin:0 0 8px}
.ci-change-row{display:block;width:100%;text-align:left;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-left:3px solid #7FCEF0;border-radius:8px;padding:8px 9px;margin:0 0 6px;cursor:pointer;color:inherit;min-height:44px}
.ci-change-row:hover{background:rgba(127,206,240,.1)}
div.ci-change-row{cursor:default}
.ci-kind{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.ci-near-class{margin:8px 0 2px}
.ci-near-row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:12.5px}
.ci-near-row .d{color:#9fc3da;white-space:nowrap}
.ci-near-detail{font-size:11px;color:#9fc3da;margin:-2px 0 4px}
.ci-pin-btn{background:rgba(255,209,102,.1);border:1px solid rgba(255,209,102,.4);color:#ffe9b0;border-radius:8px;font:600 12px system-ui,sans-serif;min-height:44px;padding:6px 12px;cursor:pointer;margin:8px 0 2px}
.ci-region-pin{flex:none;background:none;border:1px solid rgba(127,206,240,.35);color:#7FCEF0;border-radius:8px;font:600 11.5px system-ui,sans-serif;min-height:44px;min-width:64px;padding:6px 10px;cursor:pointer;margin-left:8px}
.ci-region-pin[aria-pressed="true"]{background:rgba(255,209,102,.15);border-color:#FFD166;color:#ffe9b0}
.ci-region-row .grow{flex:1;display:flex;justify-content:space-between;align-items:center;gap:8px}
.ci-pins-mgmt{border-top:1px solid rgba(127,206,240,.16);margin-top:12px;padding-top:10px}
.ci-pins-mgmt h4{margin:0 0 4px;font-size:12.5px}
.ci-pin-mrow{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.ci-pin-mrow .nm{flex:1;min-width:0}
.ci-pin-mrow .rm{background:none;border:1px solid rgba(255,90,90,.5);color:#ffb3b3;border-radius:8px;font:600 12px system-ui,sans-serif;min-height:44px;min-width:44px;padding:6px 10px;cursor:pointer}
.ci-pin-add summary{cursor:pointer;min-height:44px;display:flex;align-items:center;color:#7FCEF0;font-weight:600;font-size:12.5px}
.ci-pin-add input{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.18);border-radius:8px;color:#e8f2fa;font:13px system-ui,sans-serif;min-height:44px;padding:6px 10px;margin:0 0 6px;width:100%;box-sizing:border-box}
.ci-pin-add .row2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ci-pin-add-btn{background:rgba(127,206,240,.15);border:1px solid #7FCEF0;color:#fff;border-radius:8px;font:600 13px system-ui,sans-serif;min-height:44px;padding:6px 14px;cursor:pointer;width:100%;margin-top:2px}
.ci-pin-err{color:#ffb3b3;font-size:12px;margin:4px 0}
.ci-notify{display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-size:12.5px;cursor:pointer;min-height:44px}
.ci-notify input{width:22px;height:22px;margin-top:1px;accent-color:#7FCEF0;flex:none}
#ci-pin-toasts{position:fixed;right:12px;bottom:64px;z-index:120;display:flex;flex-direction:column;gap:8px;max-width:min(360px,calc(100vw - 24px))}
.ci-pin-toast{background:rgba(20,16,4,.96);border:1px solid #FFD166;border-radius:10px;color:#ffe9b0;padding:10px 12px;font:12.5px/1.45 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.5)}
.ci-pin-toast p{margin:4px 0 8px;color:#ffe9b0}
.ci-toast-btns{display:flex;gap:8px}
.ci-toast-btns button{flex:1;border-radius:8px;font:600 12.5px system-ui,sans-serif;min-height:44px;cursor:pointer;padding:6px 10px}
.ci-toast-view{background:#FFD166;border:1px solid #FFD166;color:#241b04}
.ci-toast-dismiss{background:none;border:1px solid currentColor;color:inherit}
@media (max-width:768px){
 #ci-pin-toasts{right:8px;left:8px;bottom:70px;max-width:none}
 .ci-top-row{grid-template-columns:22px 1fr auto}
}`;

let els = {};
let currentTab = 'top'; // Wave 2 (J4-01): "What matters now" is the first screen.
let tickerIdx = 0;
let tickerTimer = null;
let bannerDismissedEpisode = null; // disconnectedAt value dismissed by user
let ageTimer = null;

/* ——— Wave 2 module state ——— */
let pins = []; // J4-03 pinned places (localStorage v1)
let whyOrderOpen = false; // J4-01 "why this order" toggle
let changesWindow = '6h'; // J4-02 selected window
let changesData = null; // last /api/changes payload
let changesFetchAt = 0; // snapshot-at of the last changes fetch
let changesScrub = 100; // J4-02 timeline scrub: 0..100, 100 = live
let changesToken = 0; // guards async render races
let cardSeq = 0; // guards async Nearby fills on closed cards
const isMobile = () => window.matchMedia('(max-width: 720px)').matches;

function sevColor(s) { return SEV_COLORS[s] || SEV_COLORS.low; }

function statusSummary() {
  const meta = store.meta;
  const src = summarizeSources(meta);
  const dir = plainDirection(meta?.status);
  const sweep = lastSweepAt(meta);
  return { src, dir, sweep };
}

function renderPill() {
  if (!els.pill) return;
  const diag = store.clientDiag;
  const { src, sweep } = statusSummary();
  let cls = 'ci-pill'; let text;
  if (!store.lastSnapshotAt) {
    text = 'Connecting…';
  } else if (diag && (diag.state === 'reconnecting' || diag.state === 'down')) {
    cls += diag.state === 'down' ? ' down' : ' reconnecting';
    text = 'Reconnecting — showing last update';
  } else if (sweep && Date.now() - sweep > 15 * 60_000) {
    cls += ' stale';
    text = 'Data is out of date';
  } else {
    cls += ' live';
    text = src.total ? `${src.live} of ${src.total} sources live` : 'Live';
  }
  els.pill.className = cls;
  els.pill.innerHTML = `<span class="dot"></span>${esc(text)}`;
  els.pill.title = sweep ? `Last update ${fmtTime(new Date(sweep).toISOString())}` : '';
}

function renderBanner() {
  if (!els.banner) return;
  const diag = store.clientDiag;
  const client = els.clientRef;
  const visible = client ? client.reconnectVisible() : false;
  const episode = diag?.disconnectedAt || null;
  if (!visible || bannerDismissedEpisode === episode) {
    // Only touch the attribute on a real transition: the 1 s age timer calls
    // this constantly, and pointlessly re-setting `hidden` churns the DOM
    // (caught as ~1 mutation/s by a Stage-2 probe).
    if (!els.banner.hidden) els.banner.hidden = true;
    return;
  }
  const down = diag.state === 'down';
  els.banner.className = down ? 'down' : '';
  const last = store.lastSnapshotAt ? timeAgo(new Date(store.lastSnapshotAt).toISOString()) : null;
  // Set the message BEFORE unhiding: a visible banner must never show an empty
  // message span (Stage-2 hands-on F4 caught the pill with only its Dismiss
  // button). Guard the span too — a missing span must not blank the banner.
  const message = down
    ? `Can't reach the server. ${last ? `Showing the last update from ${last}.` : 'No data received yet.'} Retrying automatically (attempt ${diag.attempt}).`
    : `Connection interrupted — showing the last update${last ? ` from ${last}` : ''}. Reconnecting…`;
  if (els.bannerText) els.bannerText.textContent = message;
  else {
    const span = document.createElement('span');
    span.id = 'ci-intel-banner-text';
    span.textContent = message;
    els.banner.prepend(span);
    els.bannerText = span;
  }
  els.banner.hidden = false;
}

function briefHtml() {
  const { dir } = statusSummary();
  const top = store.feed.find((f) => f.severity === 'critical') || store.feed[0];
  return `<div class="ci-brief"><b>${esc(dir.word)}</b> — ${esc(dir.detail)}${
    top ? `<br>Top story: ${esc(cleanTitle(top.headline || top.text || ''))}` : ''
  }</div>`;
}

/** J4-05: provenance for a feed item — source + age, resolved from the
    linked event when possible, else the item's own source + sweep age. */
function feedItemProvenance(f) {
  const ev = f.eventId ? store.eventById(f.eventId) : null;
  const source = ev?.source || f.source;
  if (!source) return '';
  const srcRow = summarizeSources(store.meta).rows.find((r) => r.name === source);
  return provenanceLine({
    source,
    fetchedAtMs: srcRow?.lastOk || lastSweepAt(store.meta) || f.time || null,
    stale: srcRow?.status === 'stale',
  });
}

function renderFeed() {
  const feed = store.feed.filter((f) => {
    if (!passesSeverityFloor(f, store.severityFloor)) return false; // J4-15
    if (store.region === 'world') return true;
    if (!f.region && !f.eventId) return true;
    const ev = f.eventId ? store.eventById(f.eventId) : null;
    if (ev) return regionMatches(store.region, ev);
    return !f.region || regionMatches(store.region, { region: f.region, title: f.headline || '' });
  });
  if (!store.lastSnapshotAt) {
    els.body.innerHTML = `<div class="ci-empty">Connecting to the live feed… the latest events will appear here in a moment.</div>`;
    return;
  }
  if (!feed.length) {
    const filtered = store.severityFloor !== 'all' && store.feed.length > 0;
    els.body.innerHTML = briefHtml() + `<div class="ci-empty">${filtered
      ? 'Nothing at this severity floor. Lower the "Show me" filter to see more.'
      : 'Nothing new right now. New stories, escalations and unusual activity appear here after each sweep of the sources — only the important ones, not a firehose.'}</div>`;
    return;
  }
  els.body.innerHTML = briefHtml() + feed.map((f) => `
    <button class="ci-feed-item" data-feed-id="${esc(f.id)}" style="border-left-color:${sevColor(f.severity)}">
      <span class="ci-item-top"><span>${esc(FEED_KIND_PLAIN[f.kind] || 'Update')}</span>
      ${f.count > 1 ? `<span>· ${f.count} linked</span>` : ''}
      <span class="ci-when">${esc(timeAgo(f.time))}</span></span>
      <span class="ci-headline">${esc(cleanTitle(f.headline || f.text || ''))}</span>
      ${f.sub ? `<span class="ci-sub">${esc(f.sub)}</span>` : ''}
      <span class="ci-sub">${esc(SEV_LABEL[f.severity] || 'Low')} severity${f.region ? ` · ${esc(f.region)}` : ''}</span>
      ${(() => { const p = feedItemProvenance(f); return p ? `<span class="ci-prov">${esc(p)}</span>` : ''; })()}
    </button>`).join('');
  els.body.querySelectorAll('[data-feed-id]').forEach((b) => b.addEventListener('click', () => {
    const f = store.feed.find((x) => x.id === b.dataset.feedId);
    if (!f) return;
    if (f.eventId && store.eventById(f.eventId)) openEventCard(f.eventId);
    else if (f.connectionId && store.connectionById(f.connectionId)) openConnectionCard(f.connectionId);
  }));
}

function connCardHtml(c) {
  const steps = (c.chain || []).map((s) => `
    <div class="ci-step"><span class="sd" style="background:${sevColor(s.severity)}"></span>
    <span class="role">${esc(s.role || 'link')}</span><span>${esc(cleanTitle(s.title || ''))}</span></div>`).join('');
  const tags = (c.tags || []).slice(0, 6).map((t) => `<span class="ci-tag">${esc(t)}</span>`).join('');
  return `
    <button class="ci-conn-card" data-conn-id="${esc(c.id)}" style="border-left-color:${sevColor(c.severity)}">
      <span class="ci-item-top"><span>${esc(SEV_LABEL[c.severity] || '')}</span><span>${esc(plainScore(c))}</span>
      <span class="ci-when">${esc(timeAgo(c.createdAt))}</span></span>
      <span class="ci-headline">${esc(cleanTitle(c.title || ''))}</span>
      <span class="ci-sub">${esc(plainConnectionSummary(c))}</span>
      <span class="ci-chain">${steps}</span>
      ${tags ? `<span class="ci-tags">${tags}</span>` : ''}
    </button>`;
}

function renderConnections() {
  const conns = store.connections.filter((c) => passesSeverityFloor(c, store.severityFloor)); // J4-15
  if (!store.lastSnapshotAt) {
    els.body.innerHTML = `<div class="ci-empty">Connecting… linked events will appear here.</div>`;
    return;
  }
  if (!conns.length) {
    const filtered = store.connections.length > 0;
    els.body.innerHTML = `<div class="ci-empty">${filtered
      ? 'Nothing at this severity floor. Lower the "Show me" filter to see more.'
      : 'No linked events right now. When independent sources start telling the same story — same time, same place, shared effects — the link appears here with the chain that connects them.'}</div>`;
    return;
  }
  els.body.innerHTML = `<p class="ci-sub" style="margin:0 0 8px">Events from different sources that look connected. Strength runs to 90: 75 and up is a strong link.</p>`
    + conns.map(connCardHtml).join('');
  els.body.querySelectorAll('[data-conn-id]').forEach((b) => b.addEventListener('click', () => openConnectionCard(b.dataset.connId)));
}

function renderRegions() {
  const geo = store.markers.filter(isGeo);
  els.body.innerHTML = REGIONS.map((r) => {
    const n = r.id === 'world' ? geo.length : geo.filter((e) => regionMatches(r.id, e)).length;
    // Wave 2 (J4-03): pin toggle per region — "world" is not pinnable.
    const pinned = r.id !== 'world' && pins.some((p) => p.kind === 'region' && p.regionId === r.id);
    return `<div class="ci-region-row ${store.region === r.id ? 'active' : ''}">
      <button class="grow" data-region="${r.id}" style="display:flex;width:100%;justify-content:space-between;background:none;border:0;color:inherit;padding:10px 4px;cursor:pointer;min-height:44px;align-items:center">
      <span>${esc(r.label)}</span><span>${n} events on the globe</span></button>${
      r.id === 'world' ? '' : `<button class="ci-region-pin" type="button" data-pin-region="${r.id}" aria-pressed="${pinned}">${pinned ? 'Pinned' : 'Pin'}</button>`
    }</div>`;
  }).join('')
    + `<p class="ci-sub">Choosing a region moves the globe and filters the markers and feed to match. Events without a known region stay visible everywhere.</p>`;
  els.body.querySelectorAll('[data-region]').forEach((b) => b.addEventListener('click', () => {
    store.setRegion(b.dataset.region);
    const region = REGIONS.find((r) => r.id === b.dataset.region);
    if (region && runtime.flyToRegion) runtime.flyToRegion(region);
    renderRegions();
  }));
  els.body.querySelectorAll('[data-pin-region]').forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const regionId = b.dataset.pinRegion;
    const existing = pins.find((p) => p.kind === 'region' && p.regionId === regionId);
    if (existing) {
      pins = removePin(pins, existing.id);
    } else {
      const res = addPin(pins, { kind: 'region', regionId });
      if (res.error) return;
      pins = res.pins;
    }
    savePins(pins);
    renderRegions();
  }));
}

function renderGuide() {
  els.body.innerHTML = `<div class="ci-guide">
    <h4>What am I looking at?</h4>
    <p>Colored dots are events gathered from ${'34'} public sources — earthquakes, conflicts, cyber incidents, disasters, health and economic signals. The system checks the sources in rounds ("sweeps") and links events that look connected.</p>
    <h4>Reading the globe</h4>
    <ul>
      <li><b>Dot</b> — one event, in its severity color.</li>
      <li><b>Double ring that breathes</b> — a connection: events from different sources that look linked. An arc joins the events on the globe.</li>
      <li><b>Numbered disc</b> — a cluster of events close together. Zoom in and it splits into individual events.</li>
    </ul>
    <h4>Severity</h4>
    <ul>
      ${Object.entries(SEV_PLAIN).map(([k, v]) => `<li><span class="ci-sw" style="background:${SEV_COLORS[k]}"></span><b>${SEV_LABEL[k]}</b> — ${esc(v)}</li>`).join('')}
    </ul>
    <h4>Words we use</h4>
    <ul>
      <li><b>Link strength (0–90)</b> — how strongly two events look connected, from their severity, shared effects, a possible cause-and-effect pattern, and how close they are in time and place. 75+ is strong.</li>
      <li><b>Sources live</b> — how many of the data sources answered their last check.</li>
      <li><b>Calm / Mixed / Needs attention</b> — a plain summary of the last 24 hours of serious events.</li>
    </ul>
    <h4>Good to know</h4>
    <p>Events without coordinates never reach the globe — they live in the feed. The feed only carries stories that pass a quality bar, so it stays short enough to actually read.</p>
  </div>`;
}

function renderSystem() {
  const { src, dir, sweep } = statusSummary();
  const diag = store.clientDiag || {};
  const sizeKb = store.lastSnapshotBytes ? `${(store.lastSnapshotBytes / 1024).toFixed(1)} KB` : '—';
  els.body.innerHTML = `
    <div class="ci-stat-grid">
      <div class="ci-stat"><span class="k">Overall</span><span class="v">${esc(dir.word)}</span></div>
      <div class="ci-stat"><span class="k">Sources live</span><span class="v">${src.live} of ${src.total || '—'}</span></div>
      <div class="ci-stat"><span class="k">Events on globe</span><span class="v">${store.markers.filter(isGeo).length}</span></div>
      <div class="ci-stat"><span class="k">Linked stories</span><span class="v">${store.connections.length}</span></div>
    </div>
    <p class="ci-sub">${esc(dir.detail)} Last update ${sweep ? esc(timeAgo(new Date(sweep).toISOString())) : '—'}.
    Feed shows ${store.feed.length} of ${store.rawFeedCount} items after duplicate removal.</p>
    <p class="ci-sub">Live stream: ${esc(diag.state || 'starting')} · snapshot size ${sizeKb} · ${diag.snapshotsReceived || 0} snapshots · ${diag.updatesReceived || 0} update pings${diag.lastError ? ` · last issue: ${esc(diag.lastError)}` : ''}</p>
    <h4 style="margin:10px 0 4px;font-size:12.5px">Sources</h4>
    ${src.rows.map((r) => `<div class="ci-src-row"><span class="sd" style="background:${r.status === 'ok' ? '#4ade80' : r.status === 'stale' || r.status === 'pending' ? '#FFD166' : '#FF5A5A'}"></span>
      <span>${esc(r.name)}</span><span class="meta">${esc(r.plain)} · ${r.count} events${r.lastOk ? ` · ok ${esc(timeAgo(r.lastOk))}` : ''}</span></div>`).join('') || '<div class="ci-empty">No source data yet — the first sweep is still running.</div>'}`;
}

/* ——— Wave 2 (J4-01): "What matters now" ——— */
function topRowHtml(row) {
  const item = row.item || {};
  const sev = item.severity;
  const open = row.kind === 'connection'
    ? `data-conn="${esc(row.id)}"`
    : `data-ev="${esc(row.id)}"`;
  return `
    <button class="ci-top-row" ${open} style="border-left-color:${sevColor(sev)}">
      <span class="ci-top-rank" aria-hidden="true">${row.rank}</span>
      <span class="ci-top-main">
        <span class="ci-headline">${esc(rankedHeadline(row))}</span>
        <span class="ci-sub">${esc(row.reasons.join(' · '))}</span>
        <span class="ci-sub">${esc(row.kind === 'connection' ? 'Linked events' : 'Event')} · ${esc(timeAgo(row.kind === 'connection' ? item.createdAt : item.time))}</span>
      </span>
      <span class="ci-sevchip" style="background:${sevColor(sev)}">${esc(SEV_LABEL[sev] || 'Low')}</span>
    </button>`;
}

function pinDigestHtml() {
  const digests = pins.map((pin) => ({ pin, d: pinDigest(pin, { feed: store.feed }, PIN_DIGEST_WINDOW_MS) }));
  if (!digests.length) {
    return `<p class="ci-sub">Pin a place to watch it here — open any event card and choose “Pin this place”, or pin a region from the Regions tab.</p>`;
  }
  return digests.map(({ pin, d }) => `
    <div class="ci-pin-sec">
      <div class="ci-pin-head"><span><b>${esc(pin.name)}</b> · ${esc(pinSubtitle(pin))}</span>
      <span class="ci-pin-count">${d.count} in 6 h</span></div>
      ${d.items.slice(0, 3).map((it) => `
        <button class="ci-pin-item" ${it.eventId ? `data-ev="${esc(it.eventId)}"` : it.connectionId ? `data-conn="${esc(it.connectionId)}"` : 'disabled'}>
          ${esc(it.headline)} <span class="ci-sub">· ${esc(timeAgo(it.time))}</span>
        </button>`).join('') || '<p class="ci-sub" style="margin:4px 0 0">Quiet in the last 6 hours.</p>'}
    </div>`).join('');
}

function wireTopRowClicks(scope) {
  scope.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    const e = store.eventById(b.dataset.ev);
    if (e) openEventCard(b.dataset.ev);
  }));
  scope.querySelectorAll('[data-conn]').forEach((b) => b.addEventListener('click', () => {
    const c = store.connectionById(b.dataset.conn);
    if (c) openConnectionCard(b.dataset.conn);
  }));
}

function renderTop() {
  if (!store.lastSnapshotAt) {
    els.body.innerHTML = `<div class="ci-empty">Connecting to the live feed… the ranked developments appear here after the first sweep.</div>`;
    return;
  }
  const rows = rankWhatMatters({
    markers: store.markers,
    connections: store.connections,
    severityFloor: store.severityFloor,
  });
  const empty = !rows.length
    ? `<div class="ci-empty">${store.severityFloor !== 'all'
      ? 'Nothing at this severity floor. Lower the “Show me” filter to see more.'
      : 'No ranked developments yet — feeds still loading.'}</div>`
    : '';
  els.body.innerHTML = `
    ${pinDigestHtml()}
    <div class="ci-top-head"><span class="ci-title2">What matters now</span>
      <button class="ci-why-btn" type="button" data-why aria-expanded="${whyOrderOpen}">Why this order?</button></div>
    <div class="ci-why-box" data-whybox ${whyOrderOpen ? '' : 'hidden'}><p>${esc(RANKING_EXPLAINER)}</p></div>
    ${rows.map(topRowHtml).join('')}
    ${empty}
    <p class="ci-sub">Top ${TOP_N}, ranked from the live feed, links and events. Tap a row for the event, its links and its sources.</p>`;
  els.body.querySelector('[data-why]').addEventListener('click', (ev) => {
    whyOrderOpen = !whyOrderOpen;
    ev.currentTarget.setAttribute('aria-expanded', String(whyOrderOpen));
    els.body.querySelector('[data-whybox]').hidden = !whyOrderOpen;
  });
  wireTopRowClicks(els.body);
}

/* ——— Wave 2 (J4-02): Change view ——— */
function changesWindowMs() {
  const w = CHANGE_WINDOWS.find((x) => x.id === changesWindow);
  return w ? w.ms : 6 * 3600_000;
}

function paintChangesList() {
  const listEl = els.body.querySelector('[data-changes-list]');
  if (!listEl || !changesData) return;
  const data = changesData;
  if (data.error) {
    listEl.innerHTML = `<div class="ci-empty">Could not load the change history. It will retry on the next sweep.</div>`;
    return;
  }
  if (data.coldStart) {
    listEl.innerHTML = `<div class="ci-empty">Change history starts from the first sweep after this deploy — check back soon. Nothing is hidden; there is simply no history yet.</div>`;
    return;
  }
  const pastMs = changesScrub >= 100 ? null : Date.now() - ((100 - changesScrub) / 100) * changesWindowMs();
  const items = data.changes
    .filter((c) => (pastMs === null ? true : new Date(c.at).getTime() <= pastMs))
    .filter((c) => passesSeverityFloor(c, store.severityFloor));
  const shown = items.slice(0, 50);
  listEl.innerHTML =
    (pastMs !== null ? `<div class="ci-past" role="status">${esc(pastLabel(pastMs))}</div>` : '') +
    (shown.map((c) => {
      const color = CHANGE_KIND_COLOR[c.kind] || '#7FCEF0';
      const hasEvent = c.eventId && c.kind !== 'resolved' && store.eventById(c.eventId);
      const inner = `
        <span class="ci-kind" style="color:${color}">${esc(CHANGE_KIND_PLAIN[c.kind] || c.kind)}</span>
        <span class="ci-headline">${esc(cleanTitle(c.title || 'Untitled'))}</span>
        <span class="ci-sub">${esc([c.source, c.region].filter(Boolean).join(' · '))}${c.source || c.region ? ' · ' : ''}${esc(timeAgo(c.at))}</span>`;
      return hasEvent
        ? `<button class="ci-change-row" data-ev="${esc(c.eventId)}" style="border-left-color:${color}">${inner}</button>`
        : `<div class="ci-change-row" style="border-left-color:${color}">${inner}</div>`;
    }).join('') || `<div class="ci-empty">No changes in this window${pastMs !== null ? ' up to the scrub point' : ''}.</div>`) +
    (items.length > 50 ? `<p class="ci-sub">Showing 50 of ${items.length} changes.</p>` : '');
  listEl.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => openEventCard(b.dataset.ev)));
}

function paintTimeline() {
  const strip = els.body.querySelector('[data-tl-strip]');
  const scrub = els.body.querySelector('[data-scrub]');
  if (!strip || !changesData) return;
  const ticks = timelineTicks(changesData.changes, changesWindowMs());
  const mx = maxTick(ticks);
  strip.innerHTML = ticks.map((t) => `<span class="ci-tl-bar${t.n ? '' : ' zero'}" style="height:${Math.max(4, Math.round((t.n / mx) * 100))}%"></span>`).join('');
  if (scrub && Number(scrub.value) !== changesScrub) scrub.value = String(changesScrub);
}

function paintPinMgmt() {
  const host = els.body.querySelector('[data-pin-mgmt]');
  if (!host) return;
  host.innerHTML = `
    <h4>Pinned places</h4>
    <p class="ci-sub">Watch a place: new developments there raise an in-app alert while the app is open. Alerts only work while the app is open — there is no background monitoring.</p>
    ${pins.length ? pins.map((p) => `
      <div class="ci-pin-mrow">
        <span class="nm"><b>${esc(p.name)}</b><br><span class="ci-sub">${esc(pinSubtitle(p))}</span></span>
        <button class="ci-pin-mrow rm" type="button" data-ci-unpin="${esc(p.id)}" aria-label="Remove pin ${esc(p.name)}">Remove</button>
      </div>`).join('') : '<p class="ci-sub">No pinned places yet. Pin from any event card or region row.</p>'}
    <details class="ci-pin-add">
      <summary>Add a custom pin</summary>
      <div data-pin-form>
        <input type="text" data-f-name placeholder="Name (e.g. Port of Singapore)" aria-label="Pin name" maxlength="80">
        <div class="row2">
          <input type="number" data-f-lat placeholder="Latitude" aria-label="Latitude" step="any" min="-90" max="90">
          <input type="number" data-f-lon placeholder="Longitude" aria-label="Longitude" step="any" min="-180" max="180">
        </div>
        <input type="number" data-f-r placeholder="Watch radius in km (default 200)" aria-label="Watch radius in km" min="10" max="2000">
        <div class="ci-pin-err" data-f-err hidden></div>
        <button class="ci-pin-add-btn" type="button" data-f-add>Add pin</button>
      </div>
    </details>
    <label class="ci-notify">
      <input type="checkbox" data-notify ${notifyEnabled() ? 'checked' : ''}>
      <span>Desktop notifications <span class="ci-sub">— optional, and only while this tab is open. No email, no push to your phone.</span></span>
    </label>`;
  host.querySelectorAll('[data-ci-unpin]').forEach((b) => b.addEventListener('click', () => {
    pins = removePin(pins, b.dataset.ciUnpin);
    savePins(pins);
    paintPinMgmt();
    if (currentTab === 'top') renderTop();
  }));
  const form = host.querySelector('[data-pin-form]');
  form.querySelector('[data-f-add]').addEventListener('click', () => {
    const errEl = form.querySelector('[data-f-err]');
    const res = addPin(pins, {
      kind: 'point',
      name: form.querySelector('[data-f-name]').value,
      lat: form.querySelector('[data-f-lat]').value,
      lon: form.querySelector('[data-f-lon]').value,
      radiusKm: form.querySelector('[data-f-r]').value || 200,
    });
    if (res.error) {
      errEl.textContent = res.error;
      errEl.hidden = false;
      return;
    }
    pins = res.pins;
    try { window.__ciPins?.refresh?.(); } catch { /* noop */ }
    paintPinMgmt();
    if (currentTab === 'top') renderTop();
  });
  host.querySelector('[data-notify]').addEventListener('change', async (ev) => {
    if (!ev.currentTarget.checked) { setNotifyEnabled(false); return; }
    const perm = await requestNotifyPermission();
    if (perm === 'granted') {
      setNotifyEnabled(true);
    } else {
      ev.currentTarget.checked = false;
      setNotifyEnabled(false);
    }
  });
}

async function renderChanges() {
  const token = ++changesToken;
  const snapshotAt = store.lastSnapshotAt || 0;
  // Soft refresh: the tab DOM exists and the changes payload is already
  // from this snapshot — repaint list + timeline only. This keeps the
  // scrub position, the pin-add form, and the window buttons stable across
  // sweep pings (and the pin form never loses typed text mid-snapshot).
  if (changesData && changesFetchAt === snapshotAt && els.body.querySelector('[data-changes-list]')) {
    paintTimeline();
    paintChangesList();
    return;
  }
  const winBtns = CHANGE_WINDOWS.map((w) => `
    <button class="ci-win-btn" type="button" data-win="${w.id}" aria-pressed="${w.id === changesWindow}">${w.label}</button>`).join('');
  els.body.innerHTML = `
    <div class="ci-win" role="group" aria-label="Change window">${winBtns}</div>
    <div class="ci-tl" data-tl-strip aria-hidden="true"></div>
    <input class="ci-scrub" type="range" min="0" max="100" value="${changesScrub}" data-scrub
      aria-label="Scrub change history — drag left to look at the past">
    <div data-changes-list><div class="ci-empty">Loading change history…</div></div>
    <div class="ci-pins-mgmt" data-pin-mgmt></div>`;
  els.body.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => {
    if (changesWindow === b.dataset.win) return;
    changesWindow = b.dataset.win;
    changesScrub = 100; // window change resets the scrub to live
    changesData = null;
    renderChanges();
  }));
  els.body.querySelector('[data-scrub]').addEventListener('input', (ev) => {
    changesScrub = Number(ev.target.value);
    paintChangesList(); // list + past chrome only — never touches the globe
  });
  paintPinMgmt();
  // Fetch once per sweep ping: the retention log only changes when a sweep
  // writes to it. A tab/window switch with fresh-enough data reuses it.
  if (!changesData || changesFetchAt !== snapshotAt) {
    const data = await fetchChanges(changesWindow);
    if (token !== changesToken) return; // user moved on
    changesData = data;
    changesFetchAt = snapshotAt;
  }
  if (token !== changesToken) return;
  paintTimeline();
  paintChangesList();
}

/* ——— Wave 2 (J4-03): pin alert toasts ——— */
function ensureToastHost() {
  let host = document.getElementById('ci-pin-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ci-pin-toasts';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

function showPinToast(pin, items) {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = 'ci-pin-toast';
  el.setAttribute('role', 'status');
  const n = items.length;
  el.innerHTML = `
    <b>Pinned place: ${esc(pin.name)}</b>
    <p>${n === 1 ? esc(items[0].headline) : `${n} new developments — latest: ${esc(items[0].headline)}`}</p>
    <div class="ci-toast-btns">
      <button class="ci-toast-view" type="button" data-view>View</button>
      <button class="ci-toast-dismiss" type="button" data-dismiss aria-label="Dismiss alert">Dismiss</button>
    </div>`;
  const first = items[0];
  el.querySelector('[data-view]').addEventListener('click', () => {
    el.remove();
    if (first.eventId && store.eventById(first.eventId)) openEventCard(first.eventId);
    else if (first.connectionId && store.connectionById(first.connectionId)) openConnectionCard(first.connectionId);
    else { setTab('changes'); if (els.root.classList.contains('ci-collapsed')) togglePanel(true); }
  });
  el.querySelector('[data-dismiss]').addEventListener('click', () => el.remove());
  host.appendChild(el);
  setTimeout(() => el.remove(), 12000);
  while (host.children.length > 3) host.firstChild.remove(); // bounded stack
}

const RENDERERS = { top: renderTop, feed: renderFeed, changes: renderChanges, connections: renderConnections, regions: renderRegions, guide: renderGuide, system: renderSystem };
function renderBody() { RENDERERS[currentTab]?.(); }

function setTab(tab) {
  currentTab = tab;
  els.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  renderBody();
}

/* ——— B6 cards ——— */
export function openEventCard(eventId) {
  const e = store.eventById(eventId);
  if (!e || !els.card) return;
  store.selectEvent(eventId);
  const conns = store.connectionsForEvent(eventId);
  // J4-05: source + age on the datum. Age = the source's own last-ok check,
  // falling back to the last sweep; never fabricated.
  const srcRow = summarizeSources(store.meta).rows.find((r) => r.name === e.source);
  const prov = provenanceLine({
    source: e.source,
    fetchedAtMs: srcRow?.lastOk || lastSweepAt(store.meta) || null,
    stale: srcRow?.status === 'stale',
  });
  els.card.style.borderLeftColor = sevColor(e.severity);
  const myCard = ++cardSeq;
  els.card.innerHTML = `
    <button class="ci-x" data-close style="float:right" aria-label="Close detail">×</button>
    <span class="k">${esc(DOMAIN_LABELS[e.domain] || 'Event')} · ${esc(SEV_LABEL[e.severity] || '')} — ${esc(SEV_PLAIN[e.severity] || '')}</span>
    <h3>${esc(cleanTitle(e.title))}</h3>
    <div class="row"><span class="k">Where</span><span class="v">${esc([e.region, fmtCoords(e.lat, e.lon)].filter(Boolean).join(' · '))}</span></div>
    <div class="row"><span class="k">When</span><span class="v">${esc(fmtTime(e.time))} (${esc(timeAgo(e.time))})</span></div>
    <div class="row"><span class="k">Source</span><span class="v">${esc(prov)}${e.attribution ? `<br>${esc(e.attribution)}` : ''}</span></div>
    ${e.summary ? `<p>${esc(e.summary)}</p>` : ''}
    ${conns.length ? `<span class="k">Linked to</span>${conns.map((c) => `<button class="ci-conn-link" data-conn="${esc(c.id)}">${esc(cleanTitle(c.title))} — ${esc(plainScore(c))}</button>`).join('')}` : ''}
    ${e.url ? `<p><a href="${esc(e.url)}" target="_blank" rel="noopener">Read the original source →</a></p>` : ''}
    ${isGeo(e) ? `<button class="ci-pin-btn" type="button" data-pin-place>Pin this place</button>
    <span class="k">Nearby</span>
    <div class="ci-nearby" data-nearby><p class="ci-sub">Checking flights, vessels, bases and cameras near this event…</p></div>` : ''}`;
  els.card.hidden = false;
  els.card.querySelector('[data-close]').addEventListener('click', closeCard);
  els.card.querySelectorAll('[data-conn]').forEach((b) => b.addEventListener('click', () => openConnectionCard(b.dataset.conn)));
  // Wave 2 (J4-03): pin this event's place (200 km watch radius).
  const pinBtn = els.card.querySelector('[data-pin-place]');
  if (pinBtn && isGeo(e)) {
    pinBtn.addEventListener('click', () => {
      const res = addPin(pins, {
        kind: 'point',
        name: (e.region || cleanTitle(e.title) || 'Pinned place').slice(0, 60),
        lat: e.lat, lon: e.lon, radiusKm: 200,
      });
      if (res.error) {
        pinBtn.textContent = res.error;
        return;
      }
      pins = res.pins;
      savePins(pins);
      pinBtn.textContent = `Pinned: ${res.pin.name}`;
      pinBtn.disabled = true;
      if (currentTab === 'top') renderTop();
    });
  }
  // Wave 2 (J4-13): proximity awareness — nearest flights / vessels /
  // bases / cameras, distances computed client-side. Fetched on card open
  // (user-initiated); the card may close before they land (guarded).
  const nearbyHost = els.card.querySelector('[data-nearby]');
  if (nearbyHost && isGeo(e)) {
    const cap = isMobile() ? 5 : 8; // §L row: ≤8 desktop, ≤5 mobile
    nearbyAll(e.lat, e.lon, cap).then((res) => {
      if (myCard !== cardSeq || !nearbyHost.isConnected) return;
      nearbyHost.innerHTML = NEARBY_CLASSES.map(({ id, label }) => {
        const r = res[id];
        let body;
        if (!r.ok) {
          body = `<p class="ci-sub">${esc(r.unavailable)}</p>`;
        } else if (!r.items.length) {
          body = `<p class="ci-sub">${esc(emptyStateText(label))}</p>`;
        } else {
          body = r.items.map((it) => `
            <div class="ci-near-row"><span>${esc(it.name)}</span><span class="d">${esc(formatDistance(it.km))}</span></div>
            ${it.detail ? `<div class="ci-near-detail">${esc(it.detail)}</div>` : ''}`).join('');
        }
        return `<div class="ci-near-class"><span class="k">${label[0].toUpperCase() + label.slice(1)}</span>${body}</div>`;
      }).join('');
    }).catch(() => {
      if (myCard !== cardSeq || !nearbyHost.isConnected) return;
      nearbyHost.innerHTML = `<p class="ci-sub">Nearby lookup failed — the event details above are unaffected.</p>`;
    });
  }
  if (isGeo(e) && runtime.flyToEvent) runtime.flyToEvent(e);
}

export function openConnectionCard(connectionId) {
  const c = store.connectionById(connectionId);
  if (!c || !els.card) return;
  store.selectConnection(connectionId);
  const steps = (c.chain || []).map((s) => `
    <div class="ci-step"><span class="sd" style="background:${sevColor(s.severity)}"></span>
    <span class="role">${esc(s.role || 'link')}</span><span>${esc(cleanTitle(s.title || ''))}<br>
    <span class="ci-sub">${esc(s.source || '')}${s.region ? ` · ${esc(s.region)}` : ''} · ${esc(timeAgo(s.time))}</span></span></div>`).join('');
  // J4-04: mechanical reason codes rendered with fixed templates (no prose).
  // J4-05: confidence only where a real signal exists (multi-source count).
  const why = whyLinkedLine(c) || plainConnectionSummary(c);
  const conf = confidenceLine(c);
  els.card.style.borderLeftColor = sevColor(c.severity);
  els.card.innerHTML = `
    <button class="ci-x" data-close style="float:right" aria-label="Close detail">×</button>
    <span class="k">Linked events · ${esc(SEV_LABEL[c.severity] || '')}</span>
    <h3>${esc(cleanTitle(c.title))}</h3>
    <div class="row"><span class="k">Link strength</span><span class="v">${esc(plainScore(c))}</span></div>
    <p class="ci-why">${esc(why)}${conf ? ` <span class="ci-prov">(${esc(conf)})</span>` : ''}</p>
    <span class="k">How they connect — cause to effect</span>
    <div class="ci-chain">${steps}</div>
    ${(c.tags || []).length ? `<span class="k">Shared effects</span><div class="ci-tags">${c.tags.slice(0, 6).map((t) => `<span class="ci-tag">${esc(t)}</span>`).join('')}</div>` : ''}
    <p class="ci-sub">Tap a step's event in the Feed or on the globe for its full detail.</p>`;
  els.card.hidden = false;
  els.card.querySelector('[data-close]').addEventListener('click', closeCard);
  if (runtime.flyToConnection) runtime.flyToConnection(c);
  setTab('connections');
  if (els.root.classList.contains('ci-collapsed')) togglePanel(true);
}

export function closeCard() {
  if (els.card) els.card.hidden = true;
  store.clearSelection();
}

export function handlePick(hit) {
  if (!hit) return;
  if (hit.type === 'event') openEventCard(hit.eventId);
  else if (hit.type === 'connection') openConnectionCard(hit.connectionId);
  else if (hit.type === 'cluster') {
    // Zoom toward the first member so the cluster resolves (E4 regrouping
    // happens on the settled zoom change).
    const first = (hit.members || []).map((id) => store.eventById(id)).find(isGeo);
    if (first && runtime.flyToEvent) runtime.flyToEvent(first);
  }
}

function togglePanel(open) {
  els.root.classList.toggle('ci-collapsed', !open);
  els.openBtn.hidden = open;
  if (open) renderBody();
}

/* ——— B5 ticker ——— */
function cycleTicker() {
  const items = store.feed.slice(0, 6);
  if (!els.ticker || !items.length) { if (els.ticker) els.ticker.hidden = true; return; }
  els.ticker.hidden = false;
  const f = items[tickerIdx % items.length];
  tickerIdx++;
  els.tickerDot.style.background = sevColor(f.severity);
  els.tickerText.textContent = cleanTitle(f.headline || f.text || '');
}

export function initIntelUi(client) {
  const root = document.getElementById('ci-intel-root');
  if (!root) { console.warn('[Intel] template skeleton missing — UI not mounted'); return; }
  const style = document.createElement('style');
  style.id = 'ci-intel-css';
  style.textContent = CSS;
  document.head.appendChild(style);
  // Wave 2 surfaces (J4-01 / J4-02 / J4-03 / J4-13).
  const style2 = document.createElement('style');
  style2.id = 'ci-intel-wave2-css';
  style2.textContent = CSS_WAVE2;
  document.head.appendChild(style2);
  els = {
    root,
    pill: document.getElementById('ci-intel-pill'),
    body: document.getElementById('ci-intel-body'),
    tabs: [...document.querySelectorAll('.ci-tab')],
    banner: document.getElementById('ci-intel-banner'),
    bannerText: document.getElementById('ci-intel-banner-text'),
    card: document.getElementById('ci-card'),
    ticker: document.getElementById('ci-ticker'),
    tickerDot: document.getElementById('ci-ticker-dot'),
    tickerText: document.getElementById('ci-ticker-text'),
    openBtn: document.getElementById('ci-intel-open'),
    clientRef: client,
  };
  els.tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  document.getElementById('ci-intel-close').addEventListener('click', () => togglePanel(false));
  els.openBtn.addEventListener('click', () => togglePanel(true));
  // J4-15: severity floor dial — one plain-language filter for feed +
  // connections + globe markers. Encoded in share-link state (the shell
  // reads store.severityFloor via the severity-floor provider).
  els.sevBtns = [...document.querySelectorAll('.ci-sev-btn')];
  const paintSevDial = () => {
    els.sevBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sev === store.severityFloor)));
  };
  els.sevBtns.forEach((b) => b.addEventListener('click', () => {
    store.setSeverityFloor(b.dataset.sev);
  }));
  paintSevDial();
  on('severityFloor', () => { paintSevDial(); renderBody(); });
  // F12: on mobile the feed starts docked behind the "Intel feed" pill so the
  // globe is usable in the default state; desktop keeps the open panel.
  if (window.matchMedia('(max-width: 720px)').matches) {
    els.root.classList.add('ci-collapsed');
    els.openBtn.hidden = false;
  } else {
    els.openBtn.hidden = true; // panel starts open: feed visible on fresh load
  }
  document.getElementById('ci-intel-banner-dismiss').addEventListener('click', () => {
    bannerDismissedEpisode = store.clientDiag?.disconnectedAt || null;
    els.banner.hidden = true;
  });
  els.ticker.addEventListener('click', () => { togglePanel(true); setTab('feed'); });
  els.ticker.addEventListener('mouseenter', () => { els.tickerPaused = true; });
  els.ticker.addEventListener('mouseleave', () => { els.tickerPaused = false; });

  on('data', () => {
    renderPill(); renderBody(); cycleTicker();
    // J4-11: every good snapshot refreshes the offline cache (last picture).
    try {
      saveOfflineSnapshot({ markers: store.markers, connections: store.connections, feed: store.feed, meta: store.meta });
    } catch { /* best-effort */ }
  });
  on('status', () => { renderPill(); renderBanner(); if (currentTab === 'system') renderBody(); });
  on('region', () => { if (currentTab === 'regions') renderBody(); if (currentTab === 'feed') renderBody(); });

  // J4-11: offline watcher — persistent age chrome + frozen motion on
  // disconnect; cold boot with no network falls back to the cached picture.
  const offlineWatch = createOfflineWatch({
    getDiag: () => store.clientDiag,
    getViewer: () => runtime.viewer,
    getLastSnapshotAt: () => store.lastSnapshotAt,
    onWentLive: () => { try { els.clientRef?.fetchSnapshot?.('offline-recover'); } catch { /* best-effort */ } },
  });
  window.__ciOffline = offlineWatch;
  // Wave 2 (J4-03): pinned places — load, watch for changes on every data
  // pulse (the SSE update-ping → snapshot refetch path), alert in-app.
  pins = loadPins();
  const pinWatcher = createPinWatcher({
    getPins: () => pins,
    getFeed: () => store.feed,
    onAlert: ({ pin, items }) => {
      showPinToast(pin, items);
      if (notifyEnabled()) sendDesktopNotification(pin, items);
    },
    onPinsChanged: (next) => { pins = next; },
  });
  on('data', () => { try { pinWatcher.check(); } catch { /* alerts never break the data pulse */ } });
  window.__ciPins = {
    get pins() { return pins; },
    refresh: () => { pins = loadPins(); },
    check: () => { try { pinWatcher.check(); } catch { /* test seam */ } },
    version: 1,
  };
  const cached = loadOfflineSnapshot();
  if (cached && !store.lastSnapshotAt) {
    // Honest cold start: the cached picture is labeled with its age by the
    // pill/banner chrome; nothing here presents it as live.
    store.setSnapshot({ markers: cached.markers, connections: cached.connections, feed: cached.feed, meta: cached.meta });
    store.lastSnapshotAt = cached.savedAt; // age counts from when it was saved
  }

  renderPill();
  renderBody(); // fresh-load state: "Connecting…" until the seed snapshot lands
  cycleTicker();
  tickerTimer = setInterval(() => { if (!els.tickerPaused) cycleTicker(); }, 4500);
  ageTimer = setInterval(() => { renderPill(); renderBanner(); }, 1000);
}
