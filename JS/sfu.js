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

  // Nombres de pista que el SFU aceptó realmente. Si la respuesta
  // trae error por alguna pista, esa se descarta: pedir una pista
  // inexistente (p. ej. audio sin micrófono concedido) hace fallar
  // la negociación entera.
  function acceptedTrackNames(res, requestedNames) {
    var list = res && Array.isArray(res.tracks) ? res.tracks : null;
    if (!list || !list.length) return requestedNames.slice();
    var names = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i] || {};
      if (t.errorCode) continue;
      var name = typeof t.trackName === 'string' && t.trackName ? t.trackName : requestedNames[i];
      if (name) names.push(String(name));
    }
    return names.length ? names : requestedNames.slice();
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
  // El registro se reintenta y se renueva con un heartbeat: si el
  // registro se pierde, la puerta lo redescubre sola.
  // ─────────────────────────────────────────────────────────────
  function registerReturn(doorId, returnSessionId, trackNames) {
    return api('pair', 'POST', {
      door: String(doorId),
      session: String(returnSessionId),
      tracks: (trackNames && trackNames.length ? trackNames : ['video', 'audio']).map(String),
    });
  }

  function registerReturnReliable(doorId, returnSessionId, trackNames, tries) {
    var left = tries == null ? 4 : tries;
    return registerReturn(doorId, returnSessionId, trackNames).catch(function (err) {
      if (left <= 0) throw err;
      return delay(700).then(function () {
        return registerReturnReliable(doorId, returnSessionId, trackNames, left - 1);
      });
    });
  }

  function announceStream(doorId, streamSessionId, trackNames) {
    if (!doorId || !streamSessionId) return Promise.resolve(null);
    return api('pair', 'POST', {
      door: String(doorId),
      streamSession: String(streamSessionId),
      tracks: (trackNames || []).map(String),
    });
  }

  // waitMs > 0 → long-poll: el Worker responde en cuanto el visor
  // se registra, en lugar de obligar a la puerta a sondear.
  function getReturnStatus(doorId, waitMs) {
    var q = 'pair-status?door=' + encodeURIComponent(String(doorId));
    if (waitMs) q += '&wait=' + Math.round(waitMs);
    return api(q, 'GET');
  }

  function getStreamStatus(doorId) {
    return api('stream-status?door=' + encodeURIComponent(String(doorId)), 'GET');
  }

  // La puerta deja de emitir: su anuncio se borra para que un visor
  // con el enlace viejo no intente mirar una sesión ya cerrada.
  function clearStream(doorId, streamSessionId) {
    if (!doorId) return Promise.resolve(null);
    var body = { door: String(doorId) };
    if (streamSessionId) body.streamSession = String(streamSessionId);
    return api('stream-clear', 'POST', body);
  }

  // Con session solo se libera si sigue siendo la misma: una segunda
  // pestaña o un segundo visitante no tumba la llamada del otro.
  function clearReturn(doorId, session) {
    var body = { door: String(doorId) };
    if (session) body.session = String(session);
    return api('pair-cancel', 'POST', body);
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC — SFU.broadcast (emisor)
  // options: { videoTrack, audioTrack, onStatus, onLive, onUpdate,
  //            onFail, onReturnTrack, onReturnState,
  //            door, waitReturn, returnTracks, silent }
  //
  //  · silent    → no tocar la URL de vista almacenada (usado por
  //                el visor cuando publica su stream de retorno).
  //  · door/waitReturn → la puerta espera a que el visor conteste
  //                y, en cuanto lo hace, jala las pistas de
  //                retorno DENTRO de esta misma sesión (renegociación
  //                sobre este mismo PeerConnection) → WHEP+WHIP
  //                simultáneo sobre el SFU de Cloudflare.
  //  · pairHeartbeatMs → el emisor renueva su emparejamiento para
  //                que la puerta no se quede esperando si el
  //                registro se perdió (usado por el visor).
  //  · announceReturn → este emisor PUBLICA su stream como retorno
  //                (visor). La puerta no lo pone: solo consume.
  //  · onReturnTrack(track, kind) → pistas devueltas por el visor.
  //  · onReturnState('connected'|'waiting') → estado de la llamada.
  //  · onReturnFail(err) → falló solo la negociación del retorno.
  //  · onUpdate({sessionId, viewUrl, trackNames}) → cambió la sesión.
  // ─────────────────────────────────────────────────────────────
  function broadcast(options) {
    var opts = options || {};
    var runningRef = { running: true };
    var pc = null;
    var sessionId = null;
    var hasBeenLive = false;
    var attempt = 0;

    var silent = !!opts.silent;
    var waitReturn = !!opts.waitReturn && !!opts.door;
    var announceReturn = !!opts.announceReturn && !!opts.door;
    var returnTracks = opts.returnTracks || ['video', 'audio'];
    var activeReturnSession = null;
    var subscribedReturnNames = null;
    var returnPolling = false;
    var subscribing = false;
    var needsResubscribe = false;
    var returnFailures = 0;
    var retryNotBefore = 0;
    var returnPollTimer = null;
    var stopHeartbeat = null;

    var trackEntries = []; // [{name, kind}]
    if (opts.videoTrack) trackEntries.push({ name: 'video', track: opts.videoTrack });
    if (opts.audioTrack) trackEntries.push({ name: 'audio', track: opts.audioTrack });

    function status(s) { if (opts.onStatus) opts.onStatus(s); }

    function returnState(s) { if (opts.onReturnState) opts.onReturnState(s); }

    // Enruta las pistas que llegan desde el visor (retorno)
    function routeTrack(ev) {
      if (opts.onReturnTrack) opts.onReturnTrack(ev.track, ev.track.kind);
    }

    // ── Publicación del stream propio y renovación del pairing ──
    // Solo el visor (announceReturn) publica y renueva el
    // emparejamiento. Si lo hiciera la puerta, se anunciaría a sí
    // misma como respuesta del visitante.
    function startPairHeartbeat(session, names) {
      stopPairHeartbeat();
      var every = opts.pairHeartbeatMs || 0;
      if (!announceReturn || !every || !session) return;
      var id = setInterval(function () {
        if (!runningRef.running) return;
        registerReturn(opts.door, session, names).catch(function () {});
      }, every);
      if (id && typeof id.unref === 'function') id.unref();
      stopHeartbeat = function () { clearInterval(id); };
    }

    function stopPairHeartbeat() {
      if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
    }

    async function connectOnce() {
      var newSessionId = await createSession();
      var newPc = createPeerConnection(await getIceServers());
      pc = newPc;
      sessionId = newSessionId;

      // Toda pista remota que aparezca aquí es retorno del visor
      newPc.addEventListener('track', routeTrack);

      var entries = trackEntries.map(function (t) {
        var tr = newPc.addTransceiver(t.track, { direction: 'sendonly' });
        return { trackName: t.name, transceiver: tr };
      });

      var published = await pushTracks(newPc, newSessionId, entries);
      // Nombres reales: es lo que la contraparte debe pedir. Si el
      // SFU aceptó solo el video (sin micro), se publica solo eso.
      var names = acceptedTrackNames(published, trackEntries.map(function (t) { return t.name; }));

      // La puerta anuncia su sesión para que el visor pueda re-apuntarse.
      // Solo el emisor principal lo hace: si lo hiciera el visor, el
      // otro visitante se apuntaría a la sesión equivocada.
      if (opts.door && !silent) {
        announceStream(opts.door, newSessionId, names).catch(function () {});
      }

      resumeReturnSubscription();
      return { sessionId: newSessionId, trackNames: names };
    }

    // ── Espera / suscripción del stream de retorno del visor ──
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
        .then(function (res) {
          subscribing = false;
          // Si el SFU rechazó alguna pista (p. ej. no hay audio
          // publicado) se sigue con las que sí entraron: el video no
          // debe depender de que el micro exista.
          var got = acceptedTrackNames(res, names);
          if (!got.length) throw new Error('El SFU no entregó ninguna pista de retorno');
          activeReturnSession = returnSessionId;
          subscribedReturnNames = got;
          needsResubscribe = false;
          returnFailures = 0;
          retryNotBefore = 0;
          returnState('connected');
          return true;
        })
        .catch(function (err) {
          subscribing = false;
          // Falla solo la renegociación del retorno: el stream de ida
          // sigue bien, así que no se trata como error de transmisión.
          if (opts.onReturnFail) opts.onReturnFail(err);
          else if (opts.onFail) opts.onFail(err);
          // Backoff: evita renegociar en bucle cerrado si el SFU
          // rechaza las pistas (p. ej. el visitante no tiene micro).
          returnFailures++;
          retryNotBefore = Date.now() + Math.min(2000 * Math.min(returnFailures, 4), 15000);
          if (activeReturnSession) {
            // Ya había llamada: se reintenta la renegociación.
            if (runningRef.running) {
              setTimeout(function () {
                if (runningRef.running) {
                  subscribeReturn(activeReturnSession, subscribedReturnNames || returnTracks);
                }
              }, 2000);
            }
          } else {
            // Nunca hubo conexión: el sondeo sigue esperando al visor.
            needsResubscribe = true;
          }
          return false;
        });
    }

    function startReturnWait() {
      if (!waitReturn || returnPolling || subscribing || !runningRef.running) return;
      returnPolling = true;
      pollReturn();
    }

    // Sondeo persistente con long-poll: detecta tanto la primera
    // contestación como llamadas nuevas (un nuevo visor responde tras
    // terminar la anterior) sin castigar al Worker con requests.
    function pollReturn() {
      if (!runningRef.running) { returnPolling = false; return; }
      if (subscribing) {
        returnPollTimer = setTimeout(pollReturn, 2000);
        return;
      }
      // 10 s de long-poll: suficiente para responder al instante y
      // por debajo del límite de duración de una request del DO.
      getReturnStatus(opts.door, activeReturnSession ? 0 : 10000)
        .then(function (st) {
          if (!runningRef.running) { returnPolling = false; return; }
          if (
            st && st.active &&
            (needsResubscribe || st.returnSession !== activeReturnSession)
          ) {
            if (Date.now() >= retryNotBefore) {
              needsResubscribe = false;
              subscribeReturn(st.returnSession, st.tracks || returnTracks);
            }
            returnPollTimer = setTimeout(pollReturn, 2000);
            return;
          }
          // Sigue en llamada: sondeo corto para detectar relevos.
          returnPollTimer = setTimeout(pollReturn, st && st.active ? 3000 : 2000);
        })
        .catch(function () {
          if (runningRef.running) returnPollTimer = setTimeout(pollReturn, 3000);
          else returnPolling = false;
        });
    }

    // Re-suscita la suscripción de retorno tras una reconexión
    function resumeReturnSubscription() {
      startReturnWait();
    }

    async function run() {
      while (runningRef.running && trackEntries.length > 0) {
        try {
          status('connecting');
          var conn = await connectOnce();
          var sid = conn.sessionId;
          var names = conn.trackNames;
          var viewUrl = buildViewUrl(sid, names, opts.door);
          if (!silent) setActiveViewUrl(viewUrl);

          var first = !hasBeenLive;
          hasBeenLive = true;
          attempt = 0;
          status('live');
          if (opts.onLive) {
            opts.onLive({ sessionId: sid, viewUrl: silent ? '' : viewUrl, trackNames: names, first: first });
          }
          if (opts.onUpdate && !silent) {
            opts.onUpdate({ sessionId: sid, viewUrl: viewUrl, trackNames: names });
          }
          // El visor renueva su emparejamiento mientras esté en llamada.
          startPairHeartbeat(sid, names);

          // Esperar a que se caiga la conexión (o que nos detengan)
          await waitForConnectionToEnd(pc, runningRef);
          if (!runningRef.running) break;

          needsResubscribe = true;
          stopPairHeartbeat();
          status('reconnecting');
          attempt++;
          await backoff(attempt);
        } catch (err) {
          if (!runningRef.running) break;
          if (opts.onFail) opts.onFail(err);
          if (pc) { try { pc.close(); } catch (e) {} pc = null; }
          needsResubscribe = true;
          stopPairHeartbeat();
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
      get returnSession() { return activeReturnSession; },
      stop: function () {
        runningRef.running = false;
        if (returnPollTimer) { clearTimeout(returnPollTimer); returnPollTimer = null; }
        stopPairHeartbeat();
        if (pc) { try { pc.close(); } catch (e) {} pc = null; }
        // Solo el lado que publicó el emparejamiento lo libera. La
        // puerta no debe borrar la respuesta del visitante, y la
        // validación por `session` evita tumbar la de otro.
        if (announceReturn && sessionId) {
          clearReturn(opts.door, sessionId).catch(function () {});
        }
        // La puerta sí publica su sesión de emisión: se retira al parar.
        if (!silent && opts.door && sessionId) {
          clearStream(opts.door, sessionId).catch(function () {});
        }
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
    registerReturn: registerReturn,
    registerReturnReliable: registerReturnReliable,
    announceStream: announceStream,
    getReturnStatus: getReturnStatus,
    getStreamStatus: getStreamStatus,
    clearStream: clearStream,
    clearReturn: clearReturn,
    broadcast: broadcast,
    watch: watch,
    notifyTelegram: notifyTelegram,
  };
})(window);