/* ═══════════════════════════════════════════════════════════
   sfu.js — Motor WebRTC / Realtime SFU (Cloudflare Calls)
   Ecuador 1438 · Citófono con videollamada
   ─────────────────────────────────────────────────────────────
   Lógica extraída y adaptada del motor que usa el proyecto
   Cloudflare Meet (@cloudflare/orange-meets):
     - partytracks/client  (PartyTracks: push/pull de pistas)
     - ruta partytracks.$.tsx  (proxy -> rtc.live.cloudflare.com)
   Se reimplementa en JS plano (sin dependencias) porque el
   frontend es estático y no hay paso de build.

   Protocolo (Realtime API):
     Emisor  : POST /sessions/new → addTransceiver(sendonly)
               → POST /sessions/{id}/tracks/new  (SDP offer)
               → setRemoteDescription(answer)
     Receptor: POST /sessions/new (propia)
               → POST /sessions/{id}/tracks/new {tracks:[remote]}
               → (requiresImmediateRenegotiation)
               → setRemoteDescription(offer) → createAnswer()
               → PUT /sessions/{id}/renegotiate (answer)

   El backend Worker actúa de proxy autorizado (Bearer con el
   app secret). Nunca se expone la clave al navegador.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  // Backend Worker que implementa /calls/* (proxy SFU + Telegram).
  // Se puede sobrescribir antes de cargar este archivo con:
  //   window.SFU_BACKEND_URL = 'https://tu-worker.workers.dev/';
  var BACKEND_URL = (global.SFU_BACKEND_URL || 'https://puerta1-ecuador1438.enyoecd.workers.dev/');
  var VIEW_STORAGE_KEY = 'ecuador1438_sfu_view_url';

  var callPrefix = 'calls';

  function baseUrl() {
    var u = BACKEND_URL;
    if (u.charAt(u.length - 1) !== '/') u += '/';
    return u;
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers de red
  // ─────────────────────────────────────────────────────────────
  async function api(path, method, body) {
    var init = { method: method || 'POST', headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var res = await fetch(baseUrl() + path, init);
    var text = await res.text();
    var data = null;
    try { data = JSON.parse(text); } catch (e) { /* respuestas no JSON */ }
    if (!res.ok) {
      var err = new Error(
        (data && (data.errorDescription || data.error)) ||
          ('Error del servidor (' + res.status + ')')
      );
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Retraso con retroceso exponencial (máx. 5 s)
  function backoff(attempt) {
    return delay(Math.min(500 * Math.pow(2, Math.min(attempt, 4)), 5000));
  }

  function waitForStable(pc, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (pc.signalingState === 'stable') return resolve();
      var timer = setTimeout(function () {
        pc.removeEventListener('signalingstatechange', handler);
        reject(new Error('La negociación de señal no se estabilizó'));
      }, timeoutMs || 8000);
      function handler() {
        if (pc.signalingState === 'stable') {
          clearTimeout(timer);
          pc.removeEventListener('signalingstatechange', handler);
          resolve();
        }
      }
      pc.addEventListener('signalingstatechange', handler);
    });
  }

  // Resuelve cuando la conexión falla o se cierra
  function waitForConnectionToEnd(pc, runningRef) {
    return new Promise(function (resolve) {
      if (!runningRef.running || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        return resolve();
      }
      function check() {
        cleanup();
        resolve();
      }
      function onConn() {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') check();
      }
      function onIce() {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') check();
      }
      function cleanup() {
        pc.removeEventListener('connectionstatechange', onConn);
        pc.removeEventListener('iceconnectionstatechange', onIce);
      }
      pc.addEventListener('connectionstatechange', onConn);
      pc.addEventListener('iceconnectionstatechange', onIce);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Sesión y PeerConnection
  // ─────────────────────────────────────────────────────────────
  async function getIceServers() {
    var data = await api(callPrefix + '/generate-ice-servers');
    return (data && data.iceServers) || [];
  }

  function createPeerConnection(iceServers) {
    return new RTCPeerConnection({
      iceServers: iceServers || [],
      bundlePolicy: 'max-bundle',
    });
  }

  async function createSession() {
    var data = await api(callPrefix + '/sessions/new');
    if (!data || !data.sessionId) throw new Error('No se pudo crear la sesión SFU');
    return data.sessionId;
  }

  // ─────────────────────────────────────────────────────────────
  // Emisor: sube (push) pistas locales → envío media
  // ─────────────────────────────────────────────────────────────
  async function pushTracks(pc, sessionId, entries) {
    // entries = [ { trackName, transceiver } ]
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    var body = {
      sessionDescription: { type: 'offer', sdp: offer.sdp },
      tracks: entries.map(function (e) {
        return { location: 'local', trackName: e.trackName, mid: e.transceiver.mid };
      }),
    };
    var res = await api(callPrefix + '/sessions/' + sessionId + '/tracks/new', 'POST', body);
    if (res && res.errorCode) throw new Error(res.errorDescription || res.errorCode);
    if (!res || !res.sessionDescription) throw new Error('El SFU no devolvió respuesta SDP');
    await pc.setRemoteDescription(new RTCSessionDescription(res.sessionDescription));
    await waitForStable(pc);
    return (res.tracks) || [];
  }

  // ─────────────────────────────────────────────────────────────
  // Receptor: baja (pull) pistas remotas → recepción media
  // ─────────────────────────────────────────────────────────────
  async function pullTracks(pc, sessionId, remoteTracks) {
    // remoteTracks = [ { location:'remote', sessionId, trackName } ]
    var res = await api(callPrefix + '/sessions/' + sessionId + '/tracks/new', 'POST', {
      tracks: remoteTracks,
    });
    if (res && res.errorCode) throw new Error(res.errorDescription || res.errorCode);

    if (res && res.requiresImmediateRenegotiation && res.sessionDescription) {
      // El SFU devuelve un offer: respondemos con un answer
      await pc.setRemoteDescription(new RTCSessionDescription(res.sessionDescription));
      var answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      var reneg = await api(
        callPrefix + '/sessions/' + sessionId + '/renegotiate',
        'PUT',
        { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp } }
      );
      if (reneg && reneg.errorCode) throw new Error(reneg.errorDescription || reneg.errorCode);
      await waitForStable(pc);
    } else if (res && res.sessionDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(res.sessionDescription));
      await waitForStable(pc);
    }
    return (res && res.tracks) || [];
  }

  // ─────────────────────────────────────────────────────────────
  // URL de visualización + almacenamiento local
  // ─────────────────────────────────────────────────────────────
  function buildViewUrl(sessionId, trackNames) {
    var names = trackNames && trackNames.length ? trackNames.join(',') : 'video,audio';
    var path = location.pathname;
    var dir = path.substring(0, path.lastIndexOf('/') + 1);
    return (
      location.origin +
      dir +
      'view.html?session=' + encodeURIComponent(sessionId) +
      '&tracks=' + encodeURIComponent(names)
    );
  }

  function setActiveViewUrl(url) {
    try { localStorage.setItem(VIEW_STORAGE_KEY, url); } catch (e) {}
  }
  function getActiveViewUrl() {
    try { return localStorage.getItem(VIEW_STORAGE_KEY) || ''; } catch (e) { return ''; }
  }
  function clearActiveViewUrl() {
    try { localStorage.removeItem(VIEW_STORAGE_KEY); } catch (e) {}
  }

  function parseViewParams(search) {
    var p = new URLSearchParams(search == null ? location.search : search);
    var session = p.get('session') || p.get('s') || '';
    var tracksParam = p.get('tracks') || p.get('t') || 'video,audio';
    var tracks = tracksParam
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean)
      .map(function (name) {
        var kind = /audio|mic|sonido/i.test(name) ? 'audio' : 'video';
        return { trackName: name, kind: kind };
      });
    return { session: session, tracks: tracks };
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC — SFU.broadcast (emisor)
  // options: { videoTrack, audioTrack, onStatus, onLive, onUpdate, onFail }
  // ─────────────────────────────────────────────────────────────
  function broadcast(options) {
    var opts = options || {};
    var runningRef = { running: true };
    var pc = null;
    var sessionId = null;
    var hasBeenLive = false;
    var attempt = 0;

    var trackEntries = []; // [{name, kind}]
    if (opts.videoTrack) trackEntries.push({ name: 'video', track: opts.videoTrack });
    if (opts.audioTrack) trackEntries.push({ name: 'audio', track: opts.audioTrack });

    function status(s) { if (opts.onStatus) opts.onStatus(s); }

    async function connectOnce() {
      var newSessionId = await createSession();
      var newPc = createPeerConnection(await getIceServers());
      pc = newPc;
      sessionId = newSessionId;

      var entries = trackEntries.map(function (t) {
        var tr = newPc.addTransceiver(t.track, { direction: 'sendonly' });
        return { trackName: t.name, transceiver: tr };
      });

      await pushTracks(newPc, newSessionId, entries);
      return newSessionId;
    }

    async function run() {
      while (runningRef.running && trackEntries.length > 0) {
        try {
          status('connecting');
          var sid = await connectOnce();
          var viewUrl = buildViewUrl(sid, trackEntries.map(function (t) { return t.name; }));
          setActiveViewUrl(viewUrl);

          var first = !hasBeenLive;
          hasBeenLive = true;
          attempt = 0;
          status('live');
          if (opts.onLive) opts.onLive({ sessionId: sid, viewUrl: viewUrl, first: first });
          if (opts.onUpdate) opts.onUpdate({ sessionId: sid, viewUrl: viewUrl });

          // Esperar a que se caiga la conexión (o que nos detengan)
          await waitForConnectionToEnd(pc, runningRef);
          if (!runningRef.running) break;

          status('reconnecting');
          attempt++;
          await backoff(attempt);
        } catch (err) {
          if (!runningRef.running) break;
          if (opts.onFail) opts.onFail(err);
          if (pc) { try { pc.close(); } catch (e) {} pc = null; }
          status('reconnecting');
          attempt++;
          await backoff(attempt);
        }
      }
      if (!runningRef.running) status('stopped');
    }

    run();

    return {
      get sessionId() { return sessionId; },
      stop: function () {
        runningRef.running = false;
        if (pc) { try { pc.close(); } catch (e) {} pc = null; }
        clearActiveViewUrl();
        status('stopped');
      },
      isRunning: function () { return runningRef.running; },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC — SFU.watch (receptor)
  // options: { session, tracks: [{trackName}], videoEl, onStatus, onLive, onFail }
  // ─────────────────────────────────────────────────────────────
  function watch(options) {
    var opts = options || {};
    var runningRef = { running: true };
    var pc = null;
    var attempt = 0;
    var wasLive = false;

    function status(s) { if (opts.onStatus) opts.onStatus(s); }

    async function connectOnce() {
      var newSessionId = await createSession();
      var newPc = createPeerConnection(await getIceServers());
      pc = newPc;

      var stream = new MediaStream();
      newPc.addEventListener('track', function (ev) {
        stream.addTrack(ev.track);
        if (opts.videoEl && opts.videoEl.srcObject !== stream) {
          opts.videoEl.srcObject = stream;
        }
        if (!wasLive) status('live');
        wasLive = true;
        if (opts.onLive) opts.onLive(ev.track);
      });

      var remoteTracks = opts.tracks.map(function (t) {
        return { location: 'remote', sessionId: opts.session, trackName: t.trackName };
      });

      await pullTracks(newPc, newSessionId, remoteTracks);
      return newSessionId;
    }

    async function run() {
      while (runningRef.running && opts.session) {
        try {
          status(wasLive ? 'reconnecting' : 'connecting');
          var sid = await connectOnce();
          attempt = 0;

          await waitForConnectionToEnd(pc, runningRef);
          if (!runningRef.running) break;

          status('reconnecting');
          attempt++;
          await backoff(attempt);
        } catch (err) {
          if (!runningRef.running) break;
          if (opts.onFail) opts.onFail(err);
          if (pc) { try { pc.close(); } catch (e) {} pc = null; }
          status(wasLive ? 'reconnecting' : 'waiting');
          attempt++;
          await backoff(attempt);
        }
      }
      if (!runningRef.running) status('stopped');
    }

    run();

    return {
      stop: function () {
        runningRef.running = false;
        if (pc) { try { pc.close(); } catch (e) {} pc = null; }
        status('stopped');
      },
      isRunning: function () { return runningRef.running; },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC — Notificación por Telegram (transmisión en vivo)
  // ─────────────────────────────────────────────────────────────
  function notifyTelegram(viewUrl, door) {
    var fd = new FormData();
    fd.append('tipo', 'transmision');
    if (door) fd.append('puerta', String(door));
    if (viewUrl) fd.append('viewUrl', viewUrl);
    return fetch(baseUrl(), { method: 'POST', body: fd }).then(function (res) {
      return res.json();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────────────────────
  global.SFU = {
    BACKEND_URL: BACKEND_URL,
    VIEW_STORAGE_KEY: VIEW_STORAGE_KEY,
    getIceServers: getIceServers,
    createSession: createSession,
    buildViewUrl: buildViewUrl,
    setActiveViewUrl: setActiveViewUrl,
    getActiveViewUrl: getActiveViewUrl,
    clearActiveViewUrl: clearActiveViewUrl,
    parseViewParams: parseViewParams,
    broadcast: broadcast,
    watch: watch,
    notifyTelegram: notifyTelegram,
  };
})(window);