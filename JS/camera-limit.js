/* ═══════════════════════════════════════════════
   camera-limit.js — Límite de uso de la cámara
   Ecuador 1438 · Puerta 1
   ─────────────────────────────────────────────
   Gestiona los tiempos de la cámara SIN tocar la
   lógica de transmisión (JS/camera.js):

     · Corte automático a los 2 minutos de uso.
     · Bloqueo de 5 minutos tras ese corte.
     · El botón "En vivo" no enciende la cámara
       durante el bloqueo y avisa el tiempo que
       resta en minutos enteros (nunca segundos).
     · El bloqueo se guarda en localStorage, así
       sobrevive a recargas de la página.

   Se conecta a camera.js con tres llamadas:
     CameraLimit.puedeIniciar()  → en openCamera()
     CameraLimit.alIniciar(fn)   → al obtener el stream
     CameraLimit.alDetener()     → en closeCamera()
   ═══════════════════════════════════════════════ */
(function () {
  'use strict';

  var LIMITE_MS = 2 * 60 * 1000;   // Uso máximo continuo de la cámara.
  var BLOQUEO_MS = 5 * 60 * 1000;  // Espera tras cumplir el límite.
  var AVISO_MS = 5000;             // El aviso se cierra solo (como el del timbre).
  var MINUTO_MS = 60 * 1000;
  var LS_KEY = 'camara_state_puerta1';

  var btn = document.getElementById('btn-live-p1');

  var timerCorte = null;    // Corte automático de los 2 minutos.
  var timerAviso = null;    // Autocierre del modal de aviso.
  var timerRefresco = null; // Cambio de minuto del contador.
  var corteEnMs = 0;        // Instante límite del corte, para resincronizar.
  var fnCerrar = null;      // closeCamera() de camera.js.

  /* ═════════ Estado persistente ═════════ */

  // Se guardan instantes absolutos (epoch ms), no minutos restantes: el tiempo
  // que falta se recalcula al leer, así sigue siendo exacto tras recargar.
  function getState() {
    try {
      var data = localStorage.getItem(LS_KEY);
      if (data) {
        var s = JSON.parse(data);
        if (s && typeof s === 'object') return s;
      }
    } catch (e) {}
    return { lockStart: null, lockUntil: null };
  }

  function saveState(state) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // Minutos enteros restantes. El redondeo hacia arriba hace que "5 minutos"
  // se vea durante el primer minuto completo y luego baje a 4, 3, 2, 1.
  function minutosRestantes(hasta) {
    if (!hasta) return 0;
    var diff = hasta - Date.now();
    if (diff <= 0) return 0;
    return Math.ceil(diff / MINUTO_MS);
  }

  function formatear(min) {
    if (min <= 0) min = 1;
    return min + (min === 1 ? ' minuto' : ' minutos');
  }

  // Bloqueo vigente, o null. Si ya expiró, limpia el registro.
  function bloqueoVigente() {
    var s = getState();
    if (s.lockUntil && Date.now() >= s.lockUntil) {
      s.lockStart = null;
      s.lockUntil = null;
      saveState(s);
      return null;
    }
    if (!s.lockUntil) return null;
    return { hasta: s.lockUntil, min: minutosRestantes(s.lockUntil) };
  }

  /* ═════════ Aviso al usuario ═════════ */

  function asegurarAviso() {
    var modal = document.getElementById('cam-limit-modal');
    if (!modal) {
      // Reutiliza los estilos del aviso de límite del timbre.
      modal = document.createElement('div');
      modal.id = 'cam-limit-modal';
      modal.className = 'timbre-modal';
      modal.setAttribute('aria-hidden', 'true');
      modal.setAttribute('role', 'dialog');
      modal.innerHTML =
        '<div class="timbre-modal-card timbre-limit-card">' +
          '<div class="timbre-limit-header">' +
            '<div class="timbre-limit-icon">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>' +
                '<line x1="12" y1="9" x2="12" y2="13"></line>' +
                '<line x1="12" y1="17" x2="12.01" y2="17"></line>' +
              '</svg>' +
            '</div>' +
            '<h3 class="timbre-limit-title">Tiempo de uso agotado</h3>' +
          '</div>' +
          '<p class="timbre-limit-text" id="cam-limit-text"></p>' +
        '</div>';
      document.body.appendChild(modal);

      modal.addEventListener('click', function () { ocultarAviso(); });
    }
    return modal;
  }

  function mostrarAviso(min) {
    var modal = asegurarAviso();
    var texto = modal.querySelector('#cam-limit-text');
    if (texto) {
      texto.textContent = 'Tu tiempo de cámara de 2 minutos terminó. ' +
        'Vuelve a usarla en ' + formatear(min) + '.';
    }
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');

    if (timerAviso) clearTimeout(timerAviso);
    timerAviso = setTimeout(ocultarAviso, AVISO_MS);
  }

  function ocultarAviso() {
    var modal = document.getElementById('cam-limit-modal');
    if (modal) {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
    }
    if (timerAviso) { clearTimeout(timerAviso); timerAviso = null; }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') ocultarAviso();
  });

  /* ═════════ Botón "En vivo" ═════════ */

  function pintarBoton(bloq) {
    if (!btn) return;
    // Nunca se deshabilita: debe seguir recibiendo clics para poder avisar.
    btn.disabled = false;
    if (bloq) {
      var aviso = 'Cámara en uso limitado. Vuelve a usarla en ' + formatear(bloq.min) + '.';
      btn.classList.add('opacity-50', 'cursor-not-allowed');
      btn.title = aviso;
      btn.setAttribute('aria-label', aviso);
    } else {
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
      btn.removeAttribute('title');
      btn.setAttribute('aria-label', 'Activar cámara de la puerta en vivo');
    }
  }

  // Reprograma el texto justo en el instante en que cambia el minuto, sin
  // cuenta regresiva segundo a segundo.
  function refrescar(hasta) {
    var min = minutosRestantes(hasta);
    if (timerRefresco) { clearTimeout(timerRefresco); timerRefresco = null; }
    if (min <= 0) { pintarBoton(null); return; }
    pintarBoton({ hasta: hasta, min: min });
    var diff = hasta - Date.now();
    timerRefresco = setTimeout(function () { refrescar(hasta); }, (diff % MINUTO_MS) || MINUTO_MS);
  }

  /* ═════════ Límite de 2 minutos ═════════ */

  function cortar() {
    timerCorte = null;
    corteEnMs = 0;

    var ahora = Date.now();
    var s = getState();
    s.lockStart = ahora;              // Inicio del bloqueo.
    s.lockUntil = ahora + BLOQUEO_MS;
    saveState(s);

    // Reutiliza el cierre ya existente en camera.js.
    var cerrar = fnCerrar;
    fnCerrar = null;
    if (typeof cerrar === 'function') cerrar();

    var bloq = bloqueoVigente();
    pintarBoton(bloq);
    if (bloq) refrescar(bloq.hasta);
    mostrarAviso(bloq ? bloq.min : 1);
  }

  /* ═════════ API pública ═════════ */

  // Llamar al inicio de openCamera(): si devuelve false, la cámara no abre.
  function puedeIniciar() {
    var bloq = bloqueoVigente();
    pintarBoton(bloq);
    if (!bloq) return true;
    mostrarAviso(bloq.min);
    return false;
  }

  // Llamar cuando la cámara ya está emitiendo; fnCorte cierra la transmisión.
  function alIniciar(fnCorte) {
    fnCerrar = fnCorte;
    if (timerCorte) clearTimeout(timerCorte);
    corteEnMs = Date.now() + LIMITE_MS;
    timerCorte = setTimeout(cortar, LIMITE_MS);
  }

  // Llamar en closeCamera(): si el usuario cerró antes de los 2 minutos, el
  // límite no se aplica (el bloqueo solo nace del corte por tiempo).
  function alDetener() {
    if (timerCorte) { clearTimeout(timerCorte); timerCorte = null; }
    corteEnMs = 0;
    fnCerrar = null;
  }

  // Los navegadores ralentizan los temporizadores en segundo plano: al volver
  // a la pestaña se contrasta el reloj con el instante límite.
  function sincronizar() {
    if (fnCerrar && corteEnMs && Date.now() >= corteEnMs) { cortar(); return; }
    var bloq = bloqueoVigente();
    pintarBoton(bloq);
    if (timerRefresco) { clearTimeout(timerRefresco); timerRefresco = null; }
    if (bloq) refrescar(bloq.hasta);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) sincronizar();
  });
  window.addEventListener('pageshow', sincronizar);

  // Al cargar: si el bloqueo guardado sigue vigente, el botón aparece
  // restringido y el aviso muestra el tiempo restante.
  (function init() {
    var bloq = bloqueoVigente();
    pintarBoton(bloq);
    if (bloq) {
      refrescar(bloq.hasta);
      mostrarAviso(bloq.min);
    }
  })();

  window.CameraLimit = {
    puedeIniciar: puedeIniciar,
    alIniciar: alIniciar,
    alDetener: alDetener,
    getState: getState,
    formatear: formatear,
    minutosRestantes: minutosRestantes
  };
})();
