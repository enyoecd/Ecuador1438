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
               → el SFU responde con un OFFER
               → setRemoteDescription(offer) → createAnswer()
               → PUT /sessions/{id}/renegotiate (answer)
     Bidireccional: la misma sesión publica (sendonly) y jala
     (remote) → renegociación sobre un PeerConnection estable.

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

  // ─────────────────────────────────────────────────────────────
  // Tiempos (ms). Centralizados para poder ajustarlos en un punto.
  // ─────────────────────────────────────────────────────────────
  var SIGNAL_TIMEOUT_MS = 10000;        // negociación SDP en curso
  var ICE_CACHE_MS = 10 * 60 * 1000;    // caché de credenciales ICE/TURN
  var PAIR_WAIT_MS = 20000;             // espera activa en /pair-status
  var POLL_IDLE_MS = 1200;              // respaldo si el long-poll no responde
  var POLL_WAITING_MS = 900;            // emparejado pero sin media aún
  var POLL_CALLING_MS = 2000;           // en llamada (detecta que cuelgue)
  var RETURN_TRACK_TIMEOUT_MS = 9000;   // suscrito y sin pistas → reintentar
  var RETURN_REBUILD_AFTER = 3;         // reintentos fallidos → PeerConnection nuevo
  var HANGUP_CONFIRM_POLLS = 2;         // sondeos sin activity antes de soltar la llamada

  function baseUrl() {
    var u = BACKEND_URL;
    if (u.charAt(u.length - 1) !== '/') u += '/';
    return u;
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers de red
  // ─────────────────────────────────────────────────────────────
  async function api(path, method, body, timeoutMs) {
    var init = { method: method || 'POST', headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var abort = null;
    if (timeoutMs) {
      abort = new AbortController();
      init.signal = abort.signal;
    }
    var timer = abort ? setTimeout(function () { abort.abort(); }, timeoutMs) : null;
    try {
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
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Retraso con retroceso exponencial (máx. 5 s)
  function backoff(attempt) {
    return delay(Math.min(400 * Math.pow(2, Math.min(attempt, 4)), 5000));
  }

  function waitForStable(pc, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (pc.signalingState === 'stable') return resolve();
      var timer = setTimeout(function () {
        pc.removeEventListener('signalingstatechange', handler);
        reject(new Error('La negociación de señal no se estabilizó'));
      }, timeoutMs || SIGNAL_TIMEOUT_MS);
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

  // Cierra una negociación que quedó a medias (offer del SFU sin
  // responder). Sin esto, el siguiente tracks/new se manda con el
  // PeerConnection en 'have-remote-offer', el SFU lo rechaza y la
  // suscripción de retorno queda muerta para siempre.
  async function settlePendingOffer(pc, sessionId) {
    if (!pc || pc.signalingState !== 'have-remote-offer') return false;
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    var res = await api(callPrefix + '/sessions/' + sessionId + '/renegotiate', 'PUT', {
      sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp },
    });
    if (res && res.errorCode) throw new Error(res.errorDescription || res.errorCode);
    return true;
  }

  // Resuelve cuando la conexión falla, se cierra o se pide reconstruirla
  function waitForConnectionToEnd(pc, runningRef, rebuildRef) {
    return new Promise(function (resolve) {
      if (!runningRef.running || rebuildRef.rebuild ||
        pc.connectionState === 'failed' || pc.connectionState === 'closed') {
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
      if (rebuildRef) {
        var pending = check;
        rebuildRef.listeners.push(pending);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Sesión y PeerConnection
  // ─────────────────────────────────────────────────────────────
  var iceCache = { at: 0, servers: null };

  // Las credenciales TURN se emiten con TTL largo: cachearlas evita un
  // round-trip al Worker (y una llamada a la API de Cloudflare) en cada
  // reconexión.
  async function getIceServers(force) {
    var now = Date.now();
    if (!force && iceCache.servers && now - iceCache.at < ICE_CACHE_MS) {
      return iceCache.servers;
    }
    var data = await api(callPrefix + '/generate-ice-servers');
    var servers = (data && data.iceServers) || [];
    iceCache = { at: now, servers: servers };
    return servers;
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

  // Aplica la descripción que devuelve el SFU y deja la negociación
  // cerrada (stable). El SFU puede contestar con answer o con offer:
  // en el caso del offer hay que devolver un answer por renegotiate.
  async function applySfuDescription(pc, sessionId, desc) {
    if (!desc) return;
    // El SFU siempre manda type; si algún día no lo hiciera, en un offer la
    // línea de setup es actpass y en un answer active/passive.
    var type = desc.type ||
      (/a=setup:actpass/.test(desc.sdp || '') ? 'offer' : 'answer');
    if (type !== 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
      await waitForStable(pc);
      return;
    }
    // renegotiate puede devolver otra oferta: se atiene hasta 3 veces.
    for (var i = 0; i < 3; i++) {
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
      var answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      var res = await api(callPrefix + '/sessions/' + sessionId + '/renegotiate', 'PUT', {
        sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp },
      });
      if (res && res.errorCode) throw new Error(res.errorDescription || res.errorCode);
      if (!res || !res.sessionDescription) break;
      desc = res.sessionDescription;
    }
    await waitForStable(pc);
  }

  // ─────────────────────────────────────────────────────────────
  // Emisor: sube (push) pistas locales → envío media
  // ─────────────────────────────────────────────────────────────
  async function pushTracks(pc, sessionId, entries) {
    // entries = [ { trackName, transceiver } ]
    await settlePendingOffer(pc, sessionId);
    if (pc.signalingState !== 'stable') {
      throw new Error('No se puede publicar con la señal en ' + pc.signalingState);
    }
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    var body = {
      sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
      tracks: entries.map(function (e) {
        return { location: 'local', trackName: e.trackName, mid: e.transceiver.mid };
      }),
    };
    var res = await api(callPrefix + '/sessions/' + sessionId + '/tracks/new', 'POST', body);
    if (res && res.errorCode) throw new Error(res.errorDescription || res.errorCode);
    if (!res || !res.sessionDescription) throw new Error('El SFU no devolvió respuesta SDP');
    await applySfuDescription(pc, sessionId, res.sessionDescription);
    return (res.tracks) || [];
  }

  // ─────────────────────────────────────────────────────────────
  // Receptor: baja (pull) pistas remotas → recepción media
  // ─────────────────────────────────────────────────────────────
  async function pullTracks(pc, sessionId, remoteTracks) {
    // remoteTracks = [ { location:'remote', sessionId, trackName } ]
    await settlePendingOffer(pc, sessionId);
    if (pc.signalingState !== 'stable') {
      throw new Error('No se puede jalar pistas con la señal en ' + pc.signalingState);
    }
    var res = await api(callPrefix + '/sessions/' + sessionId + '/tracks/new', 'POST', {
      tracks: remoteTracks,
    });
    if (res && res.errorCode) throw new Error(res.errorDescription || res.errorCode);
    // Al jalar pistas remotas el SFU devuelve un OFFER: sin
    // contestarlo con renegotiate las pistas nunca llegan.
    await applySfuDescription(pc, sessionId, res && res.sessionDescription);
    return (res && res.tracks) || [];
  }

  // ─────────────────────────────────────────────────────────────
  // URL de visualización + almacenamiento local
  // ─────────────────────────────────────────────────────────────
  function buildViewUrl(sessionId, trackNames, doorId) {
    var names = trackNames && trackNames.length ? trackNames.join(',') : 'video,audio';
    var path = location.pathname;
    var dir = path.substring(0, path.lastIndexOf('/') + 1);
    var url =
      location.origin +
      dir +
      'view.html?session=' + encodeURIComponent(sessionId) +
      '&tracks=' + encodeURIComponent(names);
    if (doorId) url += '&door=' + encodeURIComponent(String(doorId));
    return url;
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
    return { session: session, tracks: tracks, door: p.get('door') || p.get('d') || '' };
  }

  // ─────────────────────────────────────────────────────────────
  // Emparejamiento bidireccional (el visor publica su stream de
  // retorno; la puerta lo consulta para jalarlo hacia su sesión).
  // ─────────────────────────────────────────────────────────────
  function registerReturn(doorId, returnSessionId, trackNames) {
    if (!doorId || !returnSessionId) return Promise.resolve({ success: false });
    return api('pair', 'POST', {
      door: String(doorId),
      session: String(returnSessionId),
      tracks: (trackNames && trackNames.length ? trackNames : ['video', 'audio']).map(String),
    });
  }

  // Reintenta el registro: una sola llamada fallida dejaba a la puerta
  // esperando para siempre, sin ninguna señal de error en la UI.
  function registerReturnReliable(doorId, returnSessionId, trackNames, attempts) {
    var tries = attempts == null ? 4 : attempts;
    return registerReturn(doorId, returnSessionId, trackNames).catch(function (err) {
      if (tries <= 1) throw err;
      return backoff(tries - 1).then(function () {
        return registerReturnReliable(doorId, returnSessionId, trackNames, tries - 1);
      });
    });
  }

  // waitMs > 0: el Worker mantiene la petición abierta hasta que haya
  // emparejamiento (o se agote el tiempo). Menos peticiones y sin
  // esperar al siguiente sondeo para enterarse de la respuesta.
  function getReturnStatus(doorId, waitMs) {
    var q = 'pair-status?door=' + encodeURIComponent(String(doorId));
    var wait = waitMs || 0;
    if (wait) q += '&wait=' + wait;
    return api(q, 'GET', undefined, wait ? wait + 8000 : 15000);
  }

  // sessionId opcional: solo se suelta el emparejamiento si sigue siendo
  // el mismo, para que una pantalla no cancele la llamada de otra.
  function clearReturn(doorId, sessionId) {
    var q = 'pair-cancel?door=' + encodeURIComponent(String(doorId));
    if (sessionId) q += '&session=' + encodeURIComponent(String(sessionId));
    return api(q, 'DELETE');
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC — SFU.broadcast (emisor)
  // options: { videoTrack, audioTrack, onStatus, onLive, onUpdate,
  //            onFail, onReturnTrack, onReturnState,
  //            door, waitReturn, returnTracks, silent, pairHeartbeatMs }
  //
  //  · silent    → no tocar la URL de vista almacenada (usado por
  //                el visor cuando publica su stream de retorno).
  //  · door/waitReturn → la puerta espera a que el visor conteste
  //                y, en cuanto lo hace, jala las pistas de
  //                retorno DENTRO de esta misma sesión (renegociación
  //                sobre este mismo PeerConnection) → WHEP+WHIP
  //                simultáneo sobre el SFU de Cloudflare.
  //  · onReturnState:
  //      'waiting'   → la puerta está esperando al visitante
  //      'connected' → negociación de retorno aceptada (media en camino)
  //      'live'      → llegó la primera pista del visitante
  //      'stalled'   → suscrito pero sin media; se reintenta
  //      'ended'     → el visitante colgó / se soltó la suscripción
  //  · pairHeartbeatMs → el emisor vuelve a publicar su emparejamiento
  //                cada N ms (el visor), para que la puerta pueda
  //                redescubrirlo aunque el registro se pierda.
  // ─────────────────────────────────────────────────────────────
  function broadcast(options) {
    var opts = options || {};
    var runningRef = { running: true };
    var rebuildRef = { rebuild: false, listeners: [] };
    var pc = null;
    var sessionId = null;
    var hasBeenLive = false;
    var attempt = 0;

    var silent = !!opts.silent;
    var waitReturn = !!opts.waitReturn && !!opts.door;
    var returnTracks = opts.returnTracks || ['video', 'audio'];
    var activeReturnSession = null;   // sesión del visor ya suscrita
    var pendingReturnSession = null;  // sesión del visor conocida, aún no suscrita
    var pendingReturnNames = null;
    var returnPolling = false;
    var subscribing = false;
    var needsResubscribe = false;
    var returnPollTimer = null;
    var returnWatchdog = null;
    var returnStallCount = 0;
    var returnTrackSeen = false;
    var inactivePolls = 0;

    var trackEntries = []; // [{name, track}]
    if (opts.videoTrack) trackEntries.push({ name: 'video', track: opts.videoTrack });
    if (opts.audioTrack) trackEntries.push({ name: 'audio', track: opts.audioTrack });

    function status(s) { if (opts.onStatus) opts.onStatus(s); }
    function returnState(s) { if (opts.onReturnState) opts.onReturnState(s); }

    function clearReturnWatchdog() {
      if (returnWatchdog) { clearTimeout(returnWatchdog); returnWatchdog = null; }
    }

    // Toda pista remota que aparezca en esta sesión es retorno del visor.
    function routeTrack(ev) {
      if (returnWatchdog) { clearReturnWatchdog(); returnWatchdog = null; }
      if (!returnTrackSeen) {
        returnTrackSeen = true;
        returnStallCount = 0;
        returnState('live');
      }
      if (opts.onReturnTrack) opts.onReturnTrack(ev.track, ev.track.kind);
    }

    // Reconstruye el PeerConnection: última instancia cuando el SFU y el
    // navegador no se ponen de acuerdo en la renegociación.
    function requestRebuild() {
      rebuildRef.rebuild = true;
      var pending = rebuildRef.listeners;
      rebuildRef.listeners = [];
      for (var i = 0; i < pending.length; i++) {
        try { pending[i](); } catch (e) {}
      }
    }

    function dropReturnSubscription(announce) {
      clearReturnWatchdog();
      activeReturnSession = null;
      returnTrackSeen = false;
      inactivePolls = 0;
      if (announce) returnState('ended');
    }

    // Suscrito pero sin media: el SFU aceptó la negociación y el track
    // nunca llegó (sesión caída, pista no encontrada, TURN que no abre).
    // Sin este control la llamada se queda en silencio para siempre.
    function onReturnWatchdog() {
      returnWatchdog = null;
      if (!runningRef.running || returnTrackSeen || !activeReturnSession) return;
      var stalledSession = activeReturnSession;
      var stalledNames = pendingReturnNames || returnTracks;
      returnStallCount++;
      dropReturnSubscription(false);
      returnState('stalled');
      if (returnStallCount >= RETURN_REBUILD_AFTER) {
        returnStallCount = 0;
        needsResubscribe = true;
        requestRebuild();
        return;
      }
      // Reintento soon: la pista podría haberse perdido al reconectar.
      pendingReturnSession = stalledSession;
      pendingReturnNames = stalledNames;
      setTimeout(function () {
        if (runningRef.running) subscribeReturn(stalledSession, stalledNames);
      }, 700 * returnStallCount);
    }

    function armReturnWatchdog() {
      clearReturnWatchdog();
      if (!runningRef.running) return;
      returnWatchdog = setTimeout(onReturnWatchdog, RETURN_TRACK_TIMEOUT_MS);
    }

    async function connectOnce() {
      var newSessionId = await createSession();
      var newPc = createPeerConnection(await getIceServers());
      pc = newPc;
      sessionId = newSessionId;
      rebuildRef.rebuild = false;

      // Toda pista remota que aparezca aquí es retorno del visor
      newPc.addEventListener('track', routeTrack);

      var entries = trackEntries.map(function (t) {
        var tr = newPc.addTransceiver(t.track, { direction: 'sendonly' });
        return { trackName: t.name, transceiver: tr };
      });

      var published = await pushTracks(newPc, newSessionId, entries);
      // Se usan los nombres que devolvió el SFU, no los supuestos: el
      // otro extremo los jala tal cual y así no hay que adivinar.
      var names = (published || [])
        .map(function (t) { return t && t.trackName; })
        .filter(Boolean);
      if (!names.length) names = trackEntries.map(function (t) { return t.name; });
      resumeReturnSubscription();
      return { sessionId: newSessionId, trackNames: names };
    }

    // ── Suscripción del stream de retorno del visor ──
    function subscribeReturn(returnSessionId, trackNames) {
      if (subscribing || !pc || !sessionId || !returnSessionId || !runningRef.running) {
        return Promise.resolve(false);
      }
      subscribing = true;
      var names = (trackNames && trackNames.length ? trackNames : returnTracks).map(String);
      var remoteTracks = names.map(function (name) {
        return { location: 'remote', sessionId: returnSessionId, trackName: name };
      });
      return pullTracks(pc, sessionId, remoteTracks)
        .then(function () {
          subscribing = false;
          if (!runningRef.running) return false;
          // Solo se marca como subscribed cuando la negociación cerró
          // de verdad: marcarlo antes hacía que el sondeo dejara de
          // reintentar y la llamada moría en silencio.
          activeReturnSession = returnSessionId;
          pendingReturnSession = returnSessionId;
          pendingReturnNames = names;
          needsResubscribe = false;
          // OJO: returnStallCount NO se reinicia aquí. negotiated ≠ media;
          // si se reiniciara, una negociación que siempre funciona pero
          // nunca entrega pista se reintentaría para siempre sin llegar
          // nunca al criterio de reconstruir el PeerConnection. Se
          // reinicia solo cuando llega la pista (routeTrack).
          returnState('connected');
          armReturnWatchdog();
          return true;
        })
        .catch(function (err) {
          subscribing = false;
          if (opts.onFail) opts.onFail(err);
          // activeReturnSession sigue vacío → el siguiente sondeo reintenta.
          pendingReturnSession = returnSessionId;
          pendingReturnNames = names;
          needsResubscribe = true;
          return false;
        });
    }

    function startReturnWait() {
      if (!waitReturn || returnPolling || !runningRef.running) return;
      returnPolling = true;
      returnState('waiting');
      pollReturn();
    }

    // Sondeo persistente: detecta tanto la primera contestación como
    // llamadas nuevas (un nuevo visor responde tras terminar la anterior).
    function pollReturn() {
      returnPolling = true;
      if (!runningRef.running) { returnPolling = false; return; }
      if (subscribing) {
        returnPollTimer = setTimeout(pollReturn, 500);
        return;
      }
      // Con la llamada ya consolidada solo se comprueba de vez en cuando
      // que el visitante siga al otro lado. Esperando a que contesten se
      // usa el long-poll del Worker (se entera en el acto, sin gastar
      // peticiones); si ya está suscrito pero sin imagen, sondeos cortos
      // porque el long-poll retrasaría el reintento.
      var settled = activeReturnSession && returnTrackSeen && !needsResubscribe;
      var waitMs = settled || activeReturnSession ? 0 : PAIR_WAIT_MS;
      getReturnStatus(opts.door, waitMs)
        .then(function (st) {
          if (!runningRef.running) { returnPolling = false; return; }
          var next = POLL_IDLE_MS;
          if (st && st.active && st.returnSession) {
            inactivePolls = 0;
            var names = (st.tracks && st.tracks.length ? st.tracks : returnTracks);
            pendingReturnSession = st.returnSession;
            pendingReturnNames = names;
            if (needsResubscribe || st.returnSession !== activeReturnSession) {
              subscribeReturn(st.returnSession, names);
              next = POLL_WAITING_MS;
            } else if (!returnTrackSeen) {
              // Suscrito pero todavía sin media: se insiste pronto.
              next = POLL_WAITING_MS;
            } else {
              next = POLL_CALLING_MS;
            }
          } else {
            next = POLL_IDLE_MS;
            // El visitante colgó. Se confirma un par de sondeos para no
            // tumbar una llamada por una lectura perdida.
            if (activeReturnSession) {
              inactivePolls++;
              if (inactivePolls >= HANGUP_CONFIRM_POLLS) {
                dropReturnSubscription(true);
              }
            }
          }
          returnPollTimer = setTimeout(pollReturn, next);
        })
        .catch(function () {
          if (runningRef.running) returnPollTimer = setTimeout(pollReturn, POLL_IDLE_MS);
          else returnPolling = false;
        });
    }

    // Re-suscita la suscripción de retorno tras una reconexión
    function resumeReturnSubscription() {
      if (!waitReturn) return;
      if (activeReturnSession || pendingReturnSession) needsResubscribe = true;
      startReturnWait();
    }

    // El visor republica su emparejamiento cada N ms: si el registro se
    // pierde (Worker frío, KV aún no propagado) la puerta lo redescubre
    // solo, sin depender de un único POST.
    function startPairHeartbeat(session, names) {
      var every = opts.pairHeartbeatMs || 0;
      if (!every || !opts.door || !session) return function () {};
      var stop = false;
      (function tick() {
        if (stop || !runningRef.running) return;
        setTimeout(function () {
          if (stop || !runningRef.running) return;
          registerReturn(opts.door, session, names).catch(function () {});
          tick();
        }, every);
      })();
      return function () { stop = true; };
    }
    var stopHeartbeat = function () {};

    async function run() {
      while (runningRef.running && trackEntries.length > 0) {
        var rebuilt = false;
        try {
          status('connecting');
          var info = await connectOnce();
          var sid = info.sessionId;
          var viewUrl = buildViewUrl(sid, info.trackNames, opts.door);
          if (!silent) setActiveViewUrl(viewUrl);

          var first = !hasBeenLive;
          hasBeenLive = true;
          attempt = 0;
          status('live');
          if (opts.onLive) {
            opts.onLive({
              sessionId: sid,
              trackNames: info.trackNames,
              viewUrl: silent ? '' : viewUrl,
              first: first,
            });
          }
          if (opts.onUpdate && !silent) {
            opts.onUpdate({ sessionId: sid, trackNames: info.trackNames, viewUrl: viewUrl });
          }
          stopHeartbeat();
          stopHeartbeat = startPairHeartbeat(sid, info.trackNames);

          // Esperar a que se caiga la conexión (o que nos detengan)
          await waitForConnectionToEnd(pc, runningRef, rebuildRef);
          rebuildRef.listeners = [];
          if (!runningRef.running) break;
          rebuilt = rebuildRef.rebuild;
          rebuildRef.rebuild = false;

          needsResubscribe = true;
          status('reconnecting');
          if (rebuilt) {
            // La conexión estaba bien: solo se reconstruye el PC, sin
            // penalización de red.
            attempt = 0;
            await delay(250);
          } else {
            attempt++;
            await backoff(attempt);
          }
        } catch (err) {
          if (!runningRef.running) break;
          if (opts.onFail) opts.onFail(err);
          if (pc) { try { pc.close(); } catch (e) {} pc = null; }
          rebuildRef.listeners = [];
          rebuildRef.rebuild = false;
          needsResubscribe = true;
          dropReturnSubscription(false);
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
        stopHeartbeat();
        if (returnPollTimer) { clearTimeout(returnPollTimer); returnPollTimer = null; }
        clearReturnWatchdog();
        rebuildRef.listeners = [];
        if (pc) { try { pc.close(); } catch (e) {} pc = null; }
        if (waitReturn && opts.door) clearReturn(opts.door, activeReturnSession || undefined).catch(function () {});
        if (!silent) clearActiveViewUrl();
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

          await waitForConnectionToEnd(pc, runningRef, null);
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
    TIMEOUTS: {
      signal: SIGNAL_TIMEOUT_MS,
      pairWait: PAIR_WAIT_MS,
      returnTrack: RETURN_TRACK_TIMEOUT_MS,
    },
    getIceServers: getIceServers,
    createSession: createSession,
    buildViewUrl: buildViewUrl,
    setActiveViewUrl: setActiveViewUrl,
    getActiveViewUrl: getActiveViewUrl,
    clearActiveViewUrl: clearActiveViewUrl,
    parseViewParams: parseViewParams,
    registerReturn: registerReturn,
    registerReturnReliable: registerReturnReliable,
    getReturnStatus: getReturnStatus,
    clearReturn: clearReturn,
    broadcast: broadcast,
    watch: watch,
    notifyTelegram: notifyTelegram,
  };
})(window);
