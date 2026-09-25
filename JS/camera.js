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
  var errorBox = document.getElementById('cam-error');

  var controller = null;
  var mediaStream = null;
  var remoteStream = null;
  var remoteAudioTrack = null;
  var telegramNotified = false;
  var micOn = true;
  var callActive = false;
  var returnFrameShown = false;
  var onReturnPlaying = null;
  var returnFrameFallback = null;
  var gestureRetryAttached = false;

  function setHint(text) {
    if (hintText) hintText.textContent = text;
  }

  function setPlaceholder(visible) {
    if (placeholder) placeholder.classList.toggle('is-hidden', !visible);
  }

  function showPill(visible) {
    if (statusPill) statusPill.classList.toggle('is-hidden', !visible);
  }

  function resetReturn() {
    callActive = false;
    remoteAudioTrack = null;
    remoteStream = new MediaStream();
    returnFrameShown = false;
    if (returnFrameFallback) { clearTimeout(returnFrameFallback); returnFrameFallback = null; }
    if (onReturnPlaying) {
      if (returnVideo) returnVideo.removeEventListener('playing', onReturnPlaying);
      onReturnPlaying = null;
    }
    if (returnVideo) {
      returnVideo.srcObject = remoteStream;
      returnVideo.muted = false;
      if (btnSpeaker) btnSpeaker.textContent = '🔊';
    }
    if (returnPane) returnPane.classList.add('is-hidden');
    if (callPill) callPill.classList.add('is-hidden');
    if (returnPlaceholder) returnPlaceholder.classList.add('is-hidden');
    if (camControls) camControls.classList.add('is-hidden');
    if (camStage) camStage.classList.remove('has-call');
  }

  function showReturnPane(visible) {
    if (!returnPane || !camStage || !camControls) return;
    returnPane.classList.toggle('is-hidden', !visible);
    camStage.classList.toggle('has-call', visible);
    camControls.classList.toggle('is-hidden', !visible);
    if (returnPlaceholder) {
      // El indicador "Esperando al visitante" solo se muestra mientras el
      // primer fotograma de la cámara del visor aún no se renderizó. Una vez
      // oculto, ningún estado posterior (p. ej. onReturnState('connected'),
      // que llega después de las pistas y de que el video ya se reprodujo)
      // debe volver a mostrarlo.
      returnPlaceholder.classList.toggle('is-hidden', !visible || returnFrameShown);
    }
  }

  // ── Reproducción robusta del video del visitante ─────────
  // El <video> de retorno no está silenciado, así que el primer
  // play() puede bloquearse por la política de autoplay. Mostramos
  // el placeholder hasta que el primer fotograma se renderiza de
  // verdad y reintentamos play() con el próximo gesto si falla.
  function onReturnFirstFrame() {
    if (returnFrameShown) return;
    returnFrameShown = true;
    if (returnFrameFallback) { clearTimeout(returnFrameFallback); returnFrameFallback = null; }
    if (returnPlaceholder) returnPlaceholder.classList.add('is-hidden');
    if (callPill) callPill.classList.remove('is-hidden');
  }

  function scheduleReturnFrameFallback() {
    if (returnFrameShown) return;
    if (returnFrameFallback) clearTimeout(returnFrameFallback);
    returnFrameFallback = setTimeout(onReturnFirstFrame, 1200);
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
        if (returnPlaceholder) returnPlaceholder.classList.remove('is-hidden');
        attachGestureRetry();
      });
    }
  }

  function attachReturnStream(stream) {
    if (!returnVideo) return;
    if (onReturnPlaying) {
      returnVideo.removeEventListener('playing', onReturnPlaying);
      onReturnPlaying = null;
    }
    if (returnVideo.srcObject !== stream) {
      returnVideo.srcObject = stream;
      // Nueva transmisión (reconexión): el indicador vuelve a mostrarse solo
      // mientras se restablece la imagen y se oculta de nuevo al primer fotograma.
      returnFrameShown = false;
      if (returnPlaceholder) returnPlaceholder.classList.remove('is-hidden');
      scheduleReturnFrameFallback();
    }
    onReturnPlaying = onReturnFirstFrame;
    returnVideo.addEventListener('playing', onReturnPlaying);
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
              notifyTelegram(info.viewUrl);
            }
          },
          onReturnState: function (state) {
            if (state === 'connected') {
              callActive = true;
              showReturnPane(true);
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
              if (remoteStream) remoteStream.addTrack(track);
            }
            if (!callActive) {
              callActive = true;
              showReturnPane(true);
            }
            attachReturnStream(remoteStream);
          },
          onFail: function (err) {
            console.error('SFU broadcast error', err);
            showError('Se perdió la transmisión. Reintentando…');
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
    micOn = true;
    if (btnMic) btnMic.textContent = '🎙️';
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
  }

  function toggleMic() {
    if (!mediaStream) return;
    var audio = mediaStream.getAudioTracks()[0];
    if (!audio) return;
    micOn = !micOn;
    audio.enabled = micOn;
    if (btnMic) {
      btnMic.textContent = micOn ? '🎙️' : '🔇';
      btnMic.classList.toggle('is-muted', !micOn);
    }
  }

  function toggleSpeaker() {
    if (!returnVideo) return;
    returnVideo.muted = !returnVideo.muted;
    if (btnSpeaker) btnSpeaker.textContent = returnVideo.muted ? '🔇' : '🔊';
  }

  if (btnOpen) {
    btnOpen.addEventListener('click', openCamera);
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
})();