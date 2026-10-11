/* =====================================================================
   APEX CONVOY -- NATIVE BRIDGE (Android app, Capacitor 8)   native-b2026-10-11.1
   ---------------------------------------------------------------------
   Makes the SAME index.html work as a real Android app. In a normal
   browser (your Vercel site) it does nothing at all.
   Inside the Android app it adds:
     - background GPS (keeps tracking with the screen off)
     - screen kept on during rides, native vibration, Android voice
     - Android share sheet, phone notifications while minimised
     - Android BACK button handling (never ends a ride)
     - NEW: "Update available" banner. Reads /appConfig/android in
       Firebase and compares it with this installed app's version code.
     - NEW: "App update" section in the Admin panel to publish a new
       version number + download link to every rider.
   Live-update mode: this file must ALSO be in your GitHub repo next to
   index.html, and index.html must contain <script src="native.js"></script>.
   ===================================================================== */
(function () {
  'use strict';
  const PUBLIC_URL = 'https://apex-convoy.vercel.app/'; // your public website address

  const Cap = window.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  window.APEX_NATIVE = isNative;
  if (!isNative) return; // normal browser: change nothing

  const avail = n => { try { return !!Cap.isPluginAvailable(n); } catch (e) { return false; } };
  const plug = n => (avail(n) ? Cap.registerPlugin(n) : null);
  const BG = plug('BackgroundGeolocation');
  const AppP = plug('App');
  const KA = plug('KeepAwake');
  const TTS = plug('TextToSpeech');
  const HAP = plug('Haptics');
  const SH = plug('Share');
  const FS = plug('Filesystem');
  const LN = plug('LocalNotifications');
  window.APEX_NATIVE_INFO = { BackgroundGeolocation: !!BG, App: !!AppP, KeepAwake: !!KA, TextToSpeech: !!TTS, Haptics: !!HAP, Share: !!SH, Filesystem: !!FS, LocalNotifications: !!LN };
  const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };

  /* ---- installed app version (versionName / versionCode from build.gradle) ---- */
  window.APEX_APP = { version: '?', build: 0 };
  const appInfoReady = AppP ? AppP.getInfo().then(i => { window.APEX_APP = { version: String(i.version || '?'), build: parseInt(i.build, 10) || 0 }; }).catch(() => {}) : Promise.resolve();

  let appActive = true;
  const activeHooks = [];
  if (AppP) AppP.addListener('appStateChange', s => { appActive = !!(s && s.isActive); if (appActive) activeHooks.forEach(f => { try { f(); } catch (e) {} }); });

  /* ---- safe areas (Android 15+ edge-to-edge) + banner styles ---- */
  try {
    const st = document.createElement('style');
    st.textContent = ':root{--safe-t:var(--safe-area-inset-top,env(safe-area-inset-top,0px));--safe-b:var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))}'
      + '#apexUpd{position:fixed;left:10px;right:10px;top:calc(var(--safe-t,0px) + 10px);z-index:99990;display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:16px;'
      + 'background:#052e16;border:1px solid #22c55e;color:#ecfdf5;font:500 14px/1.35 "Chakra Petch",system-ui,sans-serif;box-shadow:0 8px 30px rgba(2,6,23,.7)}'
      + '#apexUpd.force{background:#450a0a;border-color:#ef4444}'
      + '#apexUpd .u-txt{flex:1;min-width:0}#apexUpd b{display:block;font-size:16px}#apexUpd small{display:block;color:#bbf7d0;margin-top:2px;max-height:3.9em;overflow:hidden}'
      + '#apexUpd.force small{color:#fecaca}'
      + '#apexUpd button{height:42px;padding:0 14px;border-radius:10px;border:1px solid #22c55e;background:#22c55e;color:#052e16;font:700 14px "Chakra Petch",system-ui,sans-serif;flex:none}'
      + '#apexUpd button.later{background:none;color:#bbf7d0;border-color:rgba(187,247,208,.4)}'
      + '#apexUpdAdmin{margin-top:20px;padding-top:14px;border-top:1px solid rgba(6,182,212,.3)}'
      + '#apexUpdAdmin .row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}';
    (document.head || document.documentElement).appendChild(st);
  } catch (e) {}

  /* ---- no service worker inside the app ---- */
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('native app: service worker not used')); } catch (e) {}

  /* ---- notifications (Android 13+ asks once) ---- */
  let permDone = null, notifId = 100;
  function ensureNotifyPerm() {
    if (!LN) return Promise.resolve();
    if (permDone) return permDone;
    permDone = (async () => {
      try { const s = await LN.checkPermissions(); if (s.display !== 'granted') await LN.requestPermissions(); } catch (e) {}
      try { await LN.createChannel({ id: 'ride-alerts', name: 'Ride alerts (SOS, pings, chat)', description: 'Alerts from riders in your group', importance: 5, visibility: 1, vibration: true }); } catch (e) {}
    })();
    return permDone;
  }
  function notify(title, body) {
    if (!LN || appActive) return;
    notifId = notifId >= 2000000000 ? 100 : notifId + 1;
    LN.schedule({ notifications: [{ id: notifId, title: String(title).slice(0, 60), body: String(body).slice(0, 240), channelId: 'ride-alerts' }] }).catch(() => {});
  }

  /* ---- background GPS: replaces navigator.geolocation.watchPosition / clearWatch ---- */
  const geo = navigator.geolocation;
  let lastKick = 0, settingsAsked = false;
  function bgKick() {
    if (appActive) return;
    const now = Date.now(); if (now - lastKick < 2400) return; lastKick = now;
    try { if (typeof window.sendSelf === 'function') window.sendSelf(); } catch (e) {}
  }
  if (BG && geo) {
    const nativeClear = geo.clearWatch ? geo.clearWatch.bind(geo) : null;
    const watchers = new Map(); let nextId = 1;
    geo.watchPosition = function (ok, err) {
      const id = 900000 + nextId++, w = { nid: null, removed: false };
      watchers.set(id, w);
      ensureNotifyPerm().then(() => {
        if (w.removed) return;
        BG.addWatcher({
          backgroundTitle: 'Apex Convoy - ride in progress',
          backgroundMessage: 'Sharing your live location with your group. Tap Leave in the app to stop.',
          requestPermissions: true, stale: false, distanceFilter: 3
        }, (loc, e) => {
          if (e) {
            const denied = e.code === 'NOT_AUTHORIZED';
            if (denied && !settingsAsked) {
              settingsAsked = true;
              setTimeout(() => { if (window.confirm('Apex Convoy needs location permission to share your position with your group.\n\nOpen settings now?')) BG.openSettings().catch(() => {}); }, 50);
            }
            if (err) err({ code: denied ? 1 : 2, message: e.message || String(e.code || 'location error') });
            return;
          }
          if (!loc || !ok) return;
          ok({
            coords: {
              latitude: loc.latitude, longitude: loc.longitude,
              accuracy: loc.accuracy == null ? null : loc.accuracy,
              altitude: loc.altitude == null ? null : loc.altitude,
              altitudeAccuracy: loc.altitudeAccuracy == null ? null : loc.altitudeAccuracy,
              heading: loc.bearing == null ? null : loc.bearing,
              speed: loc.speed == null ? null : loc.speed
            },
            timestamp: loc.time || Date.now()
          });
          bgKick();
        }).then(nid => {
          if (w.removed) BG.removeWatcher({ id: nid }).catch(() => {}); else w.nid = nid;
        }).catch(e => { if (err) err({ code: 2, message: String((e && e.message) || e) }); });
      });
      return id;
    };
    geo.clearWatch = function (id) {
      const w = watchers.get(id);
      if (!w) { if (nativeClear) nativeClear(id); return; }
      w.removed = true; watchers.delete(id);
      if (w.nid != null) BG.removeWatcher({ id: w.nid }).catch(() => {});
    };
  }

  /* ---- keep the screen on during a ride ---- */
  if (KA) {
    try {
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: { request: async () => { await KA.keepAwake(); return { release: () => KA.allowSleep().catch(() => {}) }; } }
      });
    } catch (e) {}
  }

  /* ---- vibration via native haptics ---- */
  if (HAP) {
    try {
      navigator.vibrate = function (p) {
        const arr = Array.isArray(p) ? p : [p]; let t = 0;
        arr.forEach((d, i) => { d = +d || 0; if (i % 2 === 0 && d > 0) setTimeout(() => HAP.vibrate({ duration: d }).catch(() => {}), t); t += d; });
        return true;
      };
    } catch (e) {}
  }

  /* ---- share sheet ---- */
  function fixUrl(u) {
    if (!u) return u;
    try {
      if (u.indexOf(location.origin) === 0 && /localhost/.test(location.hostname)) {
        if (!PUBLIC_URL || PUBLIC_URL.indexOf('https://apex-convoy.vercel.app') !== -1) return null;
        const rest = u.slice(location.origin.length).replace(/^\/(index\.html)?/, '');
        return new URL(rest, PUBLIC_URL).href;
      }
    } catch (e) {}
    return u;
  }
  if (SH) {
    navigator.share = async function (data) {
      data = data || {};
      const opts = { title: data.title || 'Apex Convoy', text: data.text || '', dialogTitle: 'Share' };
      const url = fixUrl(data.url); if (url) opts.url = url;
      if (data.files && data.files.length) {
        if (!FS) throw new Error('file sharing unavailable');
        const f = data.files[0];
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(f); });
        const name = String(f.name || 'apex-convoy.png').replace(/[^A-Za-z0-9._-]/g, '_');
        const wr = await FS.writeFile({ path: name, data: b64, directory: 'CACHE' });
        opts.files = [wr.uri];
      }
      try { await SH.share(opts); }
      catch (e) {
        if (/cancel/i.test(String((e && (e.message || e.code)) || e))) { const a = new Error('Share cancelled'); a.name = 'AbortError'; throw a; }
        throw e;
      }
    };
    navigator.canShare = d => !!(d && (!d.files || FS));
  }

  /* =====================================================================
     UPDATE CHECK  --  /appConfig/android in Firebase:
       { latestCode, latestName, url, minCode, notes, at }
     latestCode > installed versionCode  -> "Update available" banner
     minCode    > installed versionCode  -> required update (no "Later")
     ===================================================================== */
  const Upd = {
    cfg: null, ref: null,
    whenCloud(cb, tries = 0) {
      try { if (typeof Cloud !== 'undefined' && Cloud.ready && Cloud.live && Cloud.db) return cb(); } catch (e) {}
      if (tries < 60) setTimeout(() => this.whenCloud(cb, tries + 1), 1000);
    },
    start() {
      this.whenCloud(() => {
        this.ref = Cloud.db.ref('appConfig/android');
        this.ref.on('value', s => { this.cfg = s.val(); appInfoReady.then(() => this.check()); fillAdmin(); }, () => {});
      });
      activeHooks.push(() => this.check());
    },
    open(url) {
      if (!url) return;
      try { window.location.href = url; } catch (e) {} // Capacitor opens other websites in the phone's browser
    },
    check() {
      const c = this.cfg, cur = window.APEX_APP.build;
      const old = document.getElementById('apexUpd');
      if (!c || !cur || !(+c.latestCode > cur) || !c.url) { if (old) old.remove(); return; }
      const force = +c.minCode > cur;
      const key = 'apex.updLater.' + c.latestCode;
      if (!force && Date.now() - (+ls.get(key) || 0) < 12 * 3600 * 1000) return; // "Later" hides it for 12 h
      const el = old || document.createElement('div');
      el.id = 'apexUpd'; el.className = force ? 'force' : '';
      el.setAttribute('role', 'alert');
      el.innerHTML = `<div class="u-txt"><b>${force ? 'Update required' : 'Update available'}: v${escH(c.latestName || c.latestCode)}</b>`
        + `<small>${escH(c.notes || (force ? 'This version is no longer supported. Please update to keep riding with your group.' : 'A new version of Apex Convoy is ready.'))}</small>`
        + `<small>You have v${escH(window.APEX_APP.version)}</small></div>`
        + (force ? '' : '<button class="later" type="button">Later</button>') + '<button class="go" type="button">Update</button>';
      el.querySelector('.go').onclick = () => this.open(c.url);
      const l = el.querySelector('.later'); if (l) l.onclick = () => { ls.set(key, String(Date.now())); el.remove(); };
      if (!old) document.body.appendChild(el);
    }
  };

  /* ---- Admin panel: "App update (Android)" section ---- */
  function buildAdmin() {
    const card = document.querySelector('#adminModal .rides-card, #adminModal .panel');
    if (!card || document.getElementById('apexUpdAdmin')) return;
    const box = document.createElement('div');
    box.id = 'apexUpdAdmin';
    box.innerHTML = `<h3 style="margin:0 0 8px;font-size:12px;color:var(--dim);letter-spacing:.1em">APP UPDATE (ANDROID)</h3>
      <p class="tag" style="margin:0 0 10px;font-size:13px" id="updThis"></p>
      <div class="row2">
        <div class="field"><label for="updCode">Latest version code</label><input class="num" id="updCode" type="number" inputmode="numeric" min="1"></div>
        <div class="field"><label for="updName">Version name</label><input class="plain" id="updName" placeholder="e.g. 0.1.2"></div>
      </div>
      <div class="field"><label for="updUrl">Download link (App Distribution / Drive)</label><input class="plain" id="updUrl" type="url" placeholder="https://appdistribution.firebase.google.com/testerapps"></div>
      <div class="field"><label for="updNotes">What's new (shown to riders)</label><input class="plain" id="updNotes" maxlength="160" placeholder="Faster joining, bug fixes"></div>
      <div class="field"><label for="updMin">Force update below version code (optional)</label><input class="num" id="updMin" type="number" inputmode="numeric" min="0"></div>
      <button type="button" class="btn cyan" id="updSave" style="width:100%">Publish update to all riders</button>
      <div class="p-sum" id="updMsg"></div>`;
    card.appendChild(box);
    document.getElementById('updSave').onclick = async () => {
      const g = id => document.getElementById(id).value.trim();
      const code = parseInt(g('updCode'), 10), url = g('updUrl'), min = parseInt(g('updMin'), 10) || 0;
      const msg = document.getElementById('updMsg');
      if (!(code > 0)) { msg.textContent = 'Enter the version code (the number from build.gradle).'; return; }
      if (!/^https:\/\//.test(url)) { msg.textContent = 'Enter a download link starting with https://'; return; }
      if (min > code) { msg.textContent = 'The force-update number cannot be higher than the latest version code.'; return; }
      msg.textContent = 'Publishing...';
      try {
        await Cloud.db.ref('appConfig/android').set({ latestCode: code, latestName: g('updName').slice(0, 20), url: url.slice(0, 300), notes: g('updNotes').slice(0, 160), minCode: min, at: Date.now() });
        msg.textContent = 'Published. Riders on an older version will see the update banner.';
      } catch (e) {
        msg.textContent = /permission/i.test(String(e && (e.code || e.message))) ? 'Blocked by Firebase rules -- add the "appConfig" rule (see UPDATES-GUIDE).' : 'Could not publish. Check your connection.';
      }
    };
    fillAdmin();
  }
  function fillAdmin() {
    if (!document.getElementById('apexUpdAdmin')) return;
    const c = Upd.cfg || {}, set = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v == null ? '' : v; };
    set('updCode', c.latestCode); set('updName', c.latestName); set('updUrl', c.url); set('updNotes', c.notes); set('updMin', c.minCode || '');
    const t = document.getElementById('updThis');
    if (t) t.textContent = `This phone: v${window.APEX_APP.version} (code ${window.APEX_APP.build || '?'})` + (c.latestCode ? ` - published: v${c.latestName || c.latestCode} (code ${c.latestCode})` : ' - nothing published yet');
  }

  /* ---- after the app script has loaded ---- */
  window.addEventListener('DOMContentLoaded', () => {
    appInfoReady.then(() => ['buildTagLobby', 'buildTagHud'].forEach(id => {
      const el = document.getElementById(id);
      if (el && !/ANDROID/.test(el.textContent)) el.textContent += ` \u00b7 ANDROID v${window.APEX_APP.version}`;
    }));

    if (TTS && typeof Voice !== 'undefined' && Voice) {
      Voice.speak = function (text) {
        if (!Voice.on || !text) return;
        TTS.stop().catch(() => {}).then(() => TTS.speak({ text: String(text), lang: 'en-IN', rate: 1.0, pitch: 1.0, volume: 1.0, category: 'playback', queueStrategy: 0 }))
          .catch(() => TTS.speak({ text: String(text), lang: 'en-US', rate: 1.0 }).catch(() => {}));
      };
    }

    const ALERT = /SOS|ping|joined the ride|left the ride|Voice message|\u{1F399}|km from you|off the planned route|closed the lobby|ride leader|went offline|Race posted|Back in the ride/iu;
    if (typeof window.toast === 'function') {
      const orig = window.toast;
      window.toast = function (msg) {
        try { const m = String(msg); if (!appActive && ALERT.test(m)) notify(/SOS/.test(m) ? '\u{1F198} SOS ALERT' : 'Apex Convoy', m); } catch (e) {}
        return orig.apply(this, arguments);
      };
    }
    if (typeof window.addChatMsg === 'function') {
      const origChat = window.addChatMsg;
      window.addChatMsg = function (m) {
        try { if (m && !m.self) notify('\u{1F4AC} ' + m.name, m.text); } catch (e) {}
        return origChat.apply(this, arguments);
      };
    }

    if (AppP) {
      const vis = sel => { const el = document.querySelector(sel); return !!el && !el.classList.contains('hide'); };
      const click = sel => { const el = document.querySelector(sel); if (el) el.click(); return !!el; };
      let hintShown = false;
      const minimise = () => {
        const inRide = typeof S !== 'undefined' && S && S.mode && S.mode !== 'lobby';
        if (inRide && !hintShown && typeof window.toast === 'function') { hintShown = true; window.toast('Ride keeps running in the background. Tap Leave to end it.'); }
        AppP.minimizeApp().catch(() => {});
      };
      AppP.addListener('backButton', () => {
        try {
          if (vis('#crashModal')) return;
          const popups = [['#modal', '#mNo'], ['#moreSheet', '#moreSheet [data-close]'], ['#vehiclePicker', '#vpCancel'], ['#profileModal', '#profileClose'], ['#chatModal', '#chatClose'],
            ['#pingModal', '#pingClose'], ['#summaryModal', '#summaryClose'], ['#adminModal', '#adminClose'], ['#planner', '#pClose']];
          for (const [m, b] of popups) if (vis(m)) { click(b); return; }
          if (typeof P !== 'undefined' && P && P.pick && typeof cancelPick === 'function') { cancelPick(); if (typeof openPlanner === 'function') openPlanner(); return; }
          if (vis('#preview')) { click('#previewBack'); return; }
          if (vis('#auth')) {
            if ((vis('#resetForm') || vis('#newPassForm')) && typeof authView === 'function') { authView('login'); return; }
            minimise(); return;
          }
          if (vis('#lobby')) {
            if (document.body.classList.contains('riding') && document.getElementById('backToRide')) { click('#backToRide'); return; }
            if (typeof UI !== 'undefined' && UI && UI.tab !== 'ride' && typeof showTab === 'function') { showTab('ride'); return; }
          }
          minimise();
        } catch (e) { AppP.minimizeApp().catch(() => {}); }
      });
    }

    buildAdmin();
    Upd.start();

    if (!BG) setTimeout(() => { if (typeof window.toast === 'function') window.toast('Setup issue: background location plugin missing -- run "npm run sync" and rebuild.'); }, 2500);
  });
})();
