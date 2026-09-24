/* ═══════════════════════════════════════════════
   camera.js — Cámara de la puerta en vivo (SFU)
   Ecuador 1438 · Puerta 1
   ─────────────────────────────────────────────
   Depende de JS/sfu.js (motor SFU). Abre una modal
   sobre la propia página sin redirigir y arranca la
   transmisión al instante con la cámara frontal y el
   audio. El enlace de visualización se genera solo y
   se notifica por Telegram de forma automática.
   ═══════════════════════════════════════════════ */
(function () {
  'use strict';

  var DOOR = '1';

  var modal = document.getElementById('camera-modal');
  var btnOpen = document.getElementById('btn-live-p1');
  var btnClose = document.getElementById('btn-close-camera');
  var video = document.getElementById('cam-live-video');
  var placeholder = document.getElementById('cam-live-placeholder');
  var hintText = document.getElementById('cam-hint-text');
  var statusPill = document.getElementById('cam-status-pill');
  var errorBox = document.getElementById('cam-error');

  var controller = null;
  var mediaStream = null;
  var telegramNotified = false;

  function setHint(text) {
    if (hintText) hintText.textContent = text;
  }

  function setPlaceholder(visible) {
    if (placeholder) placeholder.classList.toggle('is-hidden', !visible);
  }

  function showPill(visible) {
    if (statusPill) statusPill.classList.toggle('is-hidden', !visible);
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

        if (!window.SFU) {
          showError('No se encontró el módulo SFU (JS/sfu.js).');
          return;
        }

        var videoTrack = stream.getVideoTracks()[0];
        var audioTrack = stream.getAudioTracks()[0];

        controller = SFU.broadcast({
          videoTrack: videoTrack,
          audioTrack: audioTrack,
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
    telegramNotified = false;
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
    setHint('Activando la cámara…');
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

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal && modal.classList.contains('active')) {
      closeCamera();
    }
  });
})();