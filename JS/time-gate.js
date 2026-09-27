/* ═══════════════════════════════════════════════
   time-gate.js — Capa local de control de tiempo
   Ecuador 1438 · Puerta 1 (emisor) y visor
   ─────────────────────────────────────────────
   Cronómetro de 2 minutos (02:00 → 00:00) con
   parpadeo rojo en los últimos 10 segundos, más el
   bloqueo de 5 minutos en localStorage que usa la
   puerta cuando se agota el tiempo.

   Es 100 % local: no hace fetch, no abre WebSocket,
   no crea DataChannels y no toca la señalización
   WebRTC. El contador de cada lado lleva su propia
   cuenta; nada de lo que hay aquí empuja vídeo ni
   mensajes de un lado al otro.

   Para que el visor no vaya con un 02:00 inventado,
   la puerta sí comunica una cosa: el instante en que
   su contador se agota. Lo hace por el enlace que ya
   viaja al visor (ver JS/camera.js), y el visor pinta
   la diferencia entre ese instante y su reloj. Es el
   mínimo dato posible —una fecha, sin audio ni
   vídeo— y aun así corrige el desfase de los
   navegadores.

   Usa una duración (ms), no un instante compartido:
   cada uno arranca la suya con el plazo que le llega.

   API:
     TimeGate.create(el, {onEnd}) → {start, hide, deadline}
     TimeGate.toast(el, texto, ms)
     TimeGate.bloqueoVigente()  → {hasta, min} | null
     TimeGate.guardarBloqueo(hasta)
     TimeGate.formatearMinutos(min)
   ═══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var LIMITE_MS = 2 * 60 * 1000;   // Uso máximo de la cámara.
  var BLOQUEO_MS = 5 * 60 * 1000;  // Espera tras agotarse el tiempo.
  var AVISO_MS = 10 * 1000;        // Aquí el contador se pone rojo.
  var MINUTO_MS = 60 * 1000;
  var LS_KEY = 'tiempo_camara_puerta1';

  /* ═════════ Formato ═════════ */

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // Redondeo hacia arriba: 9.4 s se ve como 10 y 0.4 s como 01, para que
  // 00:00 sea el último valor y coincida con el final real de la cuenta.
  function formatar(ms) {
    if (!(ms > 0)) return '00:00';
    var total = Math.ceil(ms / 1000);
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  // Solo minutos enteros, sin segundos. El singular va en "1 minuto".
  function formatearMinutos(min) {
    var m = min > 0 ? min : 1;
    return m + (m === 1 ? ' minuto' : ' minutos');
  }

  /* ═════════ Bloqueo en localStorage ═════════ */

  // Se guarda el instante de desbloqueo (epoch ms), no los minutos que
  // faltan: el tiempo se recalcula al leer y así sigue siendo exacto
  // aunque la página se recargue o el navegador ralentice los temporizadores.
  function leerBloqueo() {
    try {
      var d = localStorage.getItem(LS_KEY);
      if (d) {
        var s = JSON.parse(d);
        if (s && typeof s === 'object') return s;
      }
    } catch (e) {}
    return {};
  }

  function escribirBloqueo(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function minutosRestantes(hasta) {
    var diff = hasta - Date.now();
    return diff > 0 ? Math.ceil(diff / MINUTO_MS) : 0;
  }

  // Bloqueo vigente o null. Si ya expiró, se limpia el registro.
  function bloqueoVigente() {
    var s = leerBloqueo();
    if (!s.lockUntil) return null;
    if (Date.now() >= s.lockUntil) {
      escribirBloqueo({ lockStart: null, lockUntil: null });
      return null;
    }
    return { hasta: s.lockUntil, min: minutosRestantes(s.lockUntil) };
  }

  function guardarBloqueo(hasta) {
    escribirBloqueo({ lockStart: Date.now(), lockUntil: Number(hasta) || 0 });
  }

  /* ═════════ Aviso flotante ═════════ */

  // El temporizador se guarda en el propio elemento: así cada aviso
  // lleva su cuenta sin interferir con ningún otro de la página.
  function toast(el, texto, ms) {
    if (!el) return;
    if (el._tgTimer) { clearTimeout(el._tgTimer); el._tgTimer = null; }
    if (!texto) {
      el.textContent = '';
      el.classList.add('is-hidden');
      return;
    }
    el.textContent = texto;
    el.classList.remove('is-hidden');
    el._tgTimer = setTimeout(function () {
      el.classList.add('is-hidden');
      el._tgTimer = null;
    }, ms || 5000);
  }

  /* ═════════ Cronómetro ═════════ */

  function create(el, options) {
    var opts = options || {};
    var onEnd = opts.onEnd || null;

    var restante = 0;   // Milisegundos que faltan.
    var hasta = 0;      // Instante en que se agota (epoch ms).
    var activo = false;
    var terminado = false;
    var rafId = null;
    var timerId = null;

    var valorEl = el ? el.querySelector('.tg-clock-value') : null;

    function pintar() {
      if (restante < 0) restante = 0;
      var texto = formatar(restante);
      // Solo se toca el DOM cuando el número cambia de verdad.
      if (valorEl && valorEl.textContent !== texto) valorEl.textContent = texto;
      if (!el) return;
      el.classList.toggle('is-urgent', activo && restante > 0 && restante <= AVISO_MS);
      el.classList.toggle('is-over', terminado);
    }

    function limpiarReloj() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (timerId) { clearTimeout(timerId); timerId = null; }
    }

    // Un solo disparo aunque el plazo, la pista y el reloj lo pidan a la vez.
    function terminar() {
      if (terminado) return;
      terminado = true;
      activo = false;
      limpiarReloj();
      restante = 0;
      pintar();
      if (onEnd) onEnd();
    }

    // requestAnimationFrame da el segundo fluido, pero se CONGELA con la
    // pestaña en segundo plano: por eso el fin se arma también con un
    // temporizador propio, y al volver se contrasta el reloj.
    function paso() {
      if (!activo) return;
      restante = hasta - Date.now();
      pintar();
      if (restante <= 0) { terminar(); return; }
      rafId = requestAnimationFrame(paso);
    }

    function programar() {
      if (timerId) { clearTimeout(timerId); timerId = null; }
      if (!activo) return;
      timerId = setTimeout(function () {
        timerId = null;
        restante = hasta - Date.now();
        if (restante <= 0) terminar();
        else programar();
      }, Math.max(0, restante));
    }

    // El plazo puede venir de dos sitios: el de la puerta (el que hay en
    // el enlace) o el de 2 minutos por defecto. Un plazo ya vencido (0 o
    // negativo) significa que al abrir el enlace ya no quedaba tiempo:
    // se agota en el acto en vez de inventar dos minutos nuevos.
    function start(ms) {
      if (!el) return;
      limpiarReloj();
      var dur = Number(ms);
      if (isNaN(dur)) dur = LIMITE_MS;
      if (dur <= 0) {
        activo = false;
        restante = 0;
        el.classList.remove('is-hidden');
        pintar();
        terminar();
        return;
      }
      terminado = false;
      activo = true;
      hasta = Date.now() + dur;
      restante = dur;
      el.classList.remove('is-hidden');
      pintar();
      rafId = requestAnimationFrame(paso);
      programar();
    }

    function hide() {
      activo = false;
      terminado = true;
      limpiarReloj();
      restante = 0;
      pintar();
      if (el) el.classList.add('is-hidden');
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !activo) return;
      restante = hasta - Date.now();
      if (restante <= 0) terminar();
      else pintar();
    });
    global.addEventListener('pageshow', function () {
      if (!activo) return;
      restante = hasta - Date.now();
      if (restante <= 0) terminar();
      else pintar();
    });

    // Instante en que se agota el contador, o 0 si no está corriendo.
    // La puerta lo lee para ponerlo en el enlace del visor.
    function deadline() {
      return activo && hasta > 0 ? hasta : 0;
    }

    return { start: start, hide: hide, deadline: deadline };
  }

  global.TimeGate = {
    LIMITE_MS: LIMITE_MS,
    BLOQUEO_MS: BLOQUEO_MS,
    AVISO_MS: AVISO_MS,
    formatar: formatar,
    formatearMinutos: formatearMinutos,
    create: create,
    toast: toast,
    bloqueoVigente: bloqueoVigente,
    guardarBloqueo: guardarBloqueo,
    minutosRestantes: minutosRestantes,
  };
})(window);
