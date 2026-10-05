/* ═══════════════════════════════════════════════════
   qr.js — Detección de escaneo de códigos QR
   Ecuador 1438
   ─────────────────────────────────────────────────
   Al cargar la página revisa el parámetro "qr" de la URL:

     https://ecuador1438.pages.dev/?qr=puerta1     → avisa "Puerta 1"
     https://ecuador1438.pages.dev/?qr=reparacion  → avisa "Reparación de Computadoras"

   Si la URL no trae el parámetro (visita normal) no se
   envía ninguna notificación ni se muestra ninguna alerta.

   Reutiliza el endpoint ya existente en el proyecto (Cloudflare
   Worker / Telegram) a través de TimbreManager.sendForm, por lo que
   no requiere ningún cambio en el backend.

   Debe cargarse después de JS/timbre.js.
   ═══════════════════════════════════════════════════ */

(function () {
  var BACKEND_URL = 'https://puerta1-ecuador1438.enyoecd.workers.dev/';

  var QR_TARGETS = {
    puerta1: { id: 'puerta_1', label: 'Puerta 1' },
    reparacion: { id: 'reparacion_computadoras', label: 'Reparación de Computadoras' }
  };

  function formatDate(d) {
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    return dd + '/' + mm + '/' + d.getFullYear();
  }

  function formatTime(d) {
    var hh = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    var ss = String(d.getSeconds()).padStart(2, '0');
    return hh + ':' + mi + ':' + ss;
  }

  function buildFormData(target) {
    var now = new Date();
    var formData = new FormData();
    formData.append('tipo', 'qr');
    formData.append('puerta', target.id);
    formData.append('nombre', 'Escaneo de QR');
    formData.append('email', '—');
    formData.append('telefono', '—');
    formData.append('mensaje',
      'Se escaneó el código QR de ' + target.label + ' (' + target.id + ')' +
      '\n\nFecha escaneo: ' + formatDate(now) +
      '\nHora escaneo: ' + formatTime(now));
    return formData;
  }

  async function notifyQrScan(target) {
    var formData = buildFormData(target);

    try {
      if (window.TimbreManager && typeof window.TimbreManager.sendForm === 'function') {
        await window.TimbreManager.sendForm(formData, '1');
        return;
      }

      await fetch(BACKEND_URL, { method: 'POST', body: formData });
    } catch (error) {
      console.error('Error enviando notificación de QR:', error);
    }
  }

  function checkQrParam() {
    var qr = null;

    try {
      qr = new URLSearchParams(window.location.search).get('qr');
    } catch (e) {
      qr = null;
    }

    if (!qr) return;

    var target = QR_TARGETS[String(qr).trim().toLowerCase()];
    if (!target) return;

    notifyQrScan(target);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkQrParam);
  } else {
    checkQrParam();
  }
})();