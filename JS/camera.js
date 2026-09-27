/* ═══════════════════════════════════════════════
   camera.js — Cámara de la puerta en vivo (SFU)
   Ecuador 1438 · Puerta 1
   ─────────────────────────────────────────────
   Depende de JS/sfu.js (motor SFU). Abre una modal
   sobre la propia página sin redirigir y arranca la
   transmisión al instante con la cámara frontal y el
   audio. El enlace de visualización se genera solo y
   se notifica por Telegram de forma automática.

   Videollamada bidireccional: la puerta queda a la
   espera (waitReturn) de que el visor conteste. Al
   contestar, el SFU entrega las pistas de retorno del
   visor dentro de la misma sesión (WHEP+WHIP) y la
   modal se divide en dos cuadros con controles de audio.
   ═══════════════════════════════════════════════ */
(function () {
  'use strict';

  var DOOR = '1';
  var DOOR_ID = 'puerta1';

  var modal = document.getElementById('camera-modal');
  var btnOpen = document.getElementById('btn-live-p1');
  var btnClose = document.getElementById('btn-close-camera');
  var video = document.getElementById('cam-live-video');
  var camStage = document.getElementById('cam-stage');
  var returnPane = document.getElementById('cam-return-pane');
  var returnVideo = document.getElementById('cam-return-video');
  var returnPlaceholder = document.getElementById('cam-return-placeholder');
  var callPill = document.getElementById('cam-call-pill');
  var camControls = document.getElementById('cam-controls');
  var btnSpeaker = document.getElementById('btn-cam-speaker');
  var btnMic = document.getElementById('btn-cam-mic');
  var placeholder = document.getElementById('cam-live-placeholder');
  var hintText = document.getElementById('cam-hint-text');
  var statusPill = document.getElementById('cam-status-pill');
  var camNote = document.getElementById('cam-note');
  var errorBox = document.getElementById('cam-error');

  var controller = null;
  var mediaStream = null;
  var remoteStream = null;
  var remoteAudioTrack = null;
  var telegramNotified = false;
  var notifiedSession = '';
  var micOn = true;
  var callActive = false;
  var returnFrameShown = false;
  var onReturnPlaying = null;
  var returnFrameFallback = null;
  var playbackWatchdog = null;
  var gestureRetryAttached = false;

  // Avisos hacia la capa local de control de tiempo (JS/time-gate.js).
  // Se rellenan desde window.Puerta1Camera; si ese script no está, aquí
  // no pasa nada y la cámara funciona igual.
  var hookCerrar = null;
  var hookPlazo = null;   // → instante (epoch ms) en que se agota el contador
  var gateInicio = null;   // puede devolver false para no abrir la cámara

  function setHint(text) {
    if (hintText) hintText.textContent = text;
  }

  function setPlaceholder(visible) {
    if (placeholder) placeholder.classList.toggle('is-hidden', !visible);
  }

  function showPill(visible) {
    if (statusPill) statusPill.classList.toggle('is-hidden', !visible);
  }

  // El aviso de pie de la modal es el único texto siempre visible:
  // comunica el estado de la llamada aunque la pantalla todavía no
  // se haya dividido.
  function setNote(text) {
    if (camNote) camNote.textContent = text;
  }

  function resetReturn() {
    callActive = false;
    remoteAudioTrack = null;
    remoteStream = new MediaStream();
    returnFrameShown = false;
    stopFrameWatchdog();
    detachPlaybackWatchdog();
    if (onReturnPlaying) {
      if (returnVideo) {
        returnVideo.removeEventListener('playing', onReturnPlaying);
        returnVideo.removeEventListener('loadeddata', onReturnPlaying);
        returnVideo.removeEventListener('canplay', onReturnPlaying);
      }
      onReturnPlaying = null;
    }
    if (returnVideo) {
      try { returnVideo.pause(); } catch (e) {}
      returnVideo.srcObject = remoteStream;
      returnVideo.muted = false;
      if (btnSpeaker) btnSpeaker.textContent = '🔊';
    }
    if (returnPane) returnPane.classList.add('is-hidden');
    if (callPill) callPill.classList.add('is-hidden');
    if (returnPlaceholder) returnPlaceholder.classList.add('is-hidden');
    if (camControls) camControls.classList.add('is-hidden');
    if (camStage) camStage.classList.remove('has-call');
    setNote('La transmisión se está enviando.');
  }

  // La división solo se muestra cuando hay un frame real del
  // visitante (markFrameRendered). Antes de eso el cuadro inferior
  // queda oculto y se ve el aviso de "Esperando al visitante…",
  // en lugar de un cuadro negro que parece una llamada cortada.
  function showReturnPane(visible) {
    if (!returnPane || !camStage || !camControls) return;
    returnPane.classList.toggle('is-hidden', !visible);
    camStage.classList.toggle('has-call', visible);
    camControls.classList.toggle('is-hidden', !visible);
  }

  // ── Reproducción robusta del video del visitante ─────────
  // El <video> de retorno no está silenciado, así que el primer
  // play() puede bloquearse por la política de autoplay. La pantalla
  // solo se divide cuando hay un fotograma real renderizado: si no,
  // se mantiene el cuadro único con el aviso "Esperando al
  // visitante…", que es la señal honesta de que aún no hay señal.
  function markFrameRendered() {
    if (returnFrameShown) return;
    returnFrameShown = true;
    stopFrameWatchdog();
    if (returnPane) showReturnPane(true);
    if (returnPlaceholder) returnPlaceholder.classList.add('is-hidden');
    if (callPill) callPill.classList.remove('is-hidden');
    setNote('Llamada en curso con el visitante.');
  }

  // Si el primer frame tarda demasiado, se reintenta play(): el
  // navegador a veces resuelve la promesa pero no decodifica nada.
  function scheduleFrameWatchdog() {
    if (returnFrameShown) return;
    if (returnFrameFallback) clearTimeout(returnFrameFallback);
    returnFrameFallback = setTimeout(function () {
      if (returnFrameShown) return;
      playReturnVideo();
      if (returnVideo && returnVideo.readyState >= 2) {
        markFrameRendered();
        return;
      }
      // Sigue sin frame: se reintenta con más margen.
      scheduleFrameWatchdog();
    }, 1500);
  }

  function stopFrameWatchdog() {
    if (returnFrameFallback) { clearTimeout(returnFrameFallback); returnFrameFallback = null; }
  }

  // Si el video se queda congelado o se detiene, se reintenta la
  // reproducción: es lo que hace que la llamada "se prenda y apague".
  function attachPlaybackWatchdog() {
    if (playbackWatchdog) return;
    playbackWatchdog = setInterval(function () {
      if (!returnVideo || !returnVideo.srcObject) return;
      if (document.hidden) return;
      if (returnVideo.paused || returnVideo.readyState < 2) playReturnVideo();
    }, 2000);
    if (playbackWatchdog && typeof playbackWatchdog.unref === 'function') {
      playbackWatchdog.unref();
    }
  }

  function detachPlaybackWatchdog() {
    if (playbackWatchdog) { clearInterval(playbackWatchdog); playbackWatchdog = null; }
  }

  function attachGestureRetry() {
    if (gestureRetryAttached) return;
    gestureRetryAttached = true;
    document.addEventListener(
      'pointerdown',
      function () {
        gestureRetryAttached = false;
        playReturnVideo();
      },
      { once: true }
    );
  }

  function playReturnVideo() {
    if (!returnVideo || !returnVideo.srcObject) return;
    var p = returnVideo.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function () {
        if (!returnFrameShown && returnPlaceholder) {
          returnPlaceholder.classList.remove('is-hidden');
        }
        attachGestureRetry();
      });
    }
  }

  function attachReturnStream(stream) {
    if (!returnVideo || !stream) return;
    if (onReturnPlaying) {
      returnVideo.removeEventListener('playing', onReturnPlaying);
      returnVideo.removeEventListener('loadeddata', onReturnPlaying);
      returnVideo.removeEventListener('canplay', onReturnPlaying);
      onReturnPlaying = null;
    }
    if (returnVideo.srcObject !== stream) {
      returnVideo.srcObject = stream;
      if (returnPlaceholder) returnPlaceholder.classList.remove('is-hidden');
      scheduleFrameWatchdog();
    }
    onReturnPlaying = markFrameRendered;
    returnVideo.addEventListener('playing', onReturnPlaying);
    returnVideo.addEventListener('loadeddata', onReturnPlaying);
    returnVideo.addEventListener('canplay', onReturnPlaying);
    playReturnVideo();
  }

  function hideError() {
    if (errorBox) {
      errorBox.classList.add('is-hidden');
      errorBox.textContent = '';
    }
  }

  function showError(msg) {
    if (errorBox) {
      errorBox.textContent = msg;
      errorBox.classList.remove('is-hidden');
    }
  }

  function stopLocalMedia() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    if (video) video.srcObject = null;
  }

  // Cámara frontal + audio. Si el micrófono no se concede,
  // se intenta solo con la cámara para no interrumpir la emisión.
  function requestMedia() {
    return navigator.mediaDevices
      .getUserMedia({
        audio: true,
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      })
      .catch(function () {
        return navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
      });
  }

  // Aviso transparente por Telegram (una sola vez por sesión)
  function notifyTelegram(viewUrl) {
    if (!window.SFU || !viewUrl) return;

    // Al visor se le manda el instante en que se agota el contador de la
    // puerta, para que no arranque su cuenta desde cero. Viaja como fecha
    // (epoch ms) y no como "quedan N segundos": si el enlace tarda unos
    // segundos en abrirse, la fecha sigue siendo correcta y los segundos
    // ya no lo serían. El visor calcula solo la diferencia.
    var hasta = hookPlazo ? Number(hookPlazo()) || 0 : 0;
    if (hasta > 0) {
      viewUrl += (viewUrl.indexOf('?') >= 0 ? '&' : '?') + 'until=' + hasta;
    }

    SFU.notifyTelegram(viewUrl, DOOR).catch(function () {});
  }

  function startBroadcast() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('Tu navegador no permite usar la cámara. Necesitas una conexión HTTPS.');
      setHint('Permisos no disponibles');
      setPlaceholder(false);
      return;
    }

    hideError();
    setHint('Solicitando permisos…');
    showPill(false);

    requestMedia()
      .then(function (stream) {
        mediaStream = stream;
        if (video) {
          video.srcObject = stream;
          video.play().catch(function () {});
        }
        setPlaceholder(false);
        resetReturn();

        if (!window.SFU) {
          showError('No se encontró el módulo SFU (JS/sfu.js).');
          return;
        }

        var videoTrack = stream.getVideoTracks()[0];
        var audioTrack = stream.getAudioTracks()[0];
        micOn = true;
        setMicMuted(false);

        controller = SFU.broadcast({
          videoTrack: videoTrack,
          audioTrack: audioTrack,
          door: DOOR_ID,
          waitReturn: true,
          returnTracks: ['video', 'audio'],
          onStatus: function (s) {
            if (s === 'connecting') {
              setHint('Conectando la transmisión…');
            } else if (s === 'reconnecting') {
              showPill(false);
              setHint('Reconectando…');
            } else if (s === 'live') {
              showPill(true);
              setPlaceholder(false);
            } else if (s === 'stopped') {
              showPill(false);
              setHint('Transmisión finalizada');
            }
          },
          onLive: function (info) {
            showPill(true);
            setPlaceholder(false);
            // Notificación automática al receptor (una sola vez)
            if (!telegramNotified) {
              telegramNotified = true;
              notifiedSession = info.sessionId;
              notifyTelegram(info.viewUrl);
            }
          },
          onUpdate: function (info) {
            // La puerta reconectó y publicó otra sesión: el enlace
            // viejo ya no sirve, así que se vuelve a avisar. Solo si
            // la sesión es realmente distinta, para no duplicar el
            // aviso en el primer arranque.
            if (info && info.viewUrl && info.sessionId &&
                info.sessionId !== notifiedSession) {
              notifiedSession = info.sessionId;
              notifyTelegram(info.viewUrl);
            }
          },
          onReturnState: function (state) {
            if (state === 'connected') {
              // El SFU ya aceptó la negociación. El cuadro inferior
              // se revela cuando llegue el primer frame real, no
              // ahora: dividir sin imagen se veía como fallo.
              if (camControls) camControls.classList.remove('is-hidden');
              setNote('El visitante contestó: conectando su video…');
              attachPlaybackWatchdog();
            }
          },
          onReturnTrack: function (track, kind) {
            // Cada pista de video de retorno renueva el stream para
            // no quedarnos mostrando un cuadro congelado tras reconectar.
            if (kind === 'video') {
              remoteStream = new MediaStream([track]);
              if (remoteAudioTrack) remoteStream.addTrack(remoteAudioTrack);
            } else if (kind === 'audio') {
              remoteAudioTrack = track;
              if (!remoteStream) remoteStream = new MediaStream();
              remoteStream.addTrack(track);
            }
            if (!callActive) {
              callActive = true;
            }
            attachReturnStream(remoteStream);
          },
          onFail: function (err) {
            console.error('SFU broadcast error', err);
            showError('Se perdió la transmisión. Reintentando…');
          },
          onReturnFail: function (err) {
            // La ida sigue bien; solo falló traer la respuesta del
            // visitante. Se avisa en el texto de la modal, no como
            // error general de la transmisión.
            console.warn('No se pudo traer el retorno del visitante', err);
            if (!returnFrameShown) {
              setNote('El visitante contestó; todavía llega su video…');
            }
          },
        });
      })
      .catch(function (err) {
        console.error('Error de permisos/media', err);
        showError('No se pudo activar la cámara. Revisa los permisos del navegador.');
        setHint('Permisos no disponibles');
        setPlaceholder(false);
      });
  }

  function stopBroadcast() {
    if (controller) {
      controller.stop();
      controller = null;
    }
    stopLocalMedia();
    resetReturn();
    telegramNotified = false;
    notifiedSession = '';
    micOn = true;
    setMicMuted(false);
  }

  function openCamera() {
    if (!modal) return;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    if (controller && controller.isRunning()) return;
    setPlaceholder(true);
    setHint('Activando la cámara…');
    startBroadcast();
  }

  function closeCamera() {
    if (!modal) return;
    stopBroadcast();
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    showPill(false);
    resetReturn();
    setHint('Activando la cámara…');
    // Aviso a la capa local de tiempo (JS/time-gate.js) de que la cámara
    // ya está apagada, para que cancele su cuenta. Notificación local, no
    // forma parte de la conexión.
    if (hookCerrar) hookCerrar();
  }

  // El icono es siempre un micrófono (SVG en el HTML). Al silenciar no se
  // cambia el dibujo: se le añade la tachadura roja con la clase .is-muted,
  // igual que en view.html. Antes se reescribía el textContent con 🔇, que es
  // el icono de bocina apagada y no de micrófono silenciado.
  function setMicMuted(muted) {
    if (!btnMic) return;
    btnMic.classList.toggle('is-muted', muted);
    btnMic.setAttribute('aria-pressed', muted ? 'true' : 'false');
    btnMic.setAttribute('aria-label',
      muted ? 'Activar el micrófono de la puerta' : 'Silenciar el micrófono de la puerta');
  }

  function toggleMic() {
    if (!mediaStream) return;
    var audio = mediaStream.getAudioTracks()[0];
    if (!audio) return;
    micOn = !micOn;
    audio.enabled = micOn;
    setMicMuted(!micOn);
  }

  function toggleSpeaker() {
    if (!returnVideo) return;
    returnVideo.muted = !returnVideo.muted;
    if (btnSpeaker) btnSpeaker.textContent = returnVideo.muted ? '🔇' : '🔊';
  }

  if (btnOpen) {
    btnOpen.addEventListener('click', function () {
      // La capa local de tiempo puede vetar el arranque cuando la función
      // está restringida. Se consulta aquí y no con un listener propio
      // porque, en el nodo del botón, todos los listeners se ejecutan en
      // orden de registro: uno añadido aparte llegaría tarde.
      if (gateInicio && gateInicio() === false) return;
      openCamera();
    });
  }

  if (btnClose) {
    btnClose.addEventListener('click', function (e) {
      e.stopPropagation();
      closeCamera();
    });
  }

  if (btnMic) {
    btnMic.addEventListener('click', toggleMic);
  }

  if (btnSpeaker) {
    btnSpeaker.addEventListener('click', toggleSpeaker);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal && modal.classList.contains('active')) {
      closeCamera();
    }
  });

  // ── Puente con la capa local de control de tiempo ──
  // Se expone la función local que apaga la cámara, un aviso de que se
  // cerró, el veto de arranque y el plazo del contador. Lo único que
  // sale de aquí hacia el visor es ese instante, y va por el enlace.
  window.Puerta1Camera = {
    close: function () { closeCamera(); },
    alCerrar: function (fn) { hookCerrar = typeof fn === 'function' ? fn : null; },
    // fn() → epoch ms en que se agota el contador, o 0 si no corre.
    plazo: function (fn) { hookPlazo = typeof fn === 'function' ? fn : null; },
    // fn() → false impide que se abra la cámara (y avisa del bloqueo).
    puerta: function (fn) { gateInicio = typeof fn === 'function' ? fn : null; },
  };
})();
