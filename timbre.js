(function() {
  var BACKEND_URL_P1 = 'https://puerta1-ecuador1438.enyoecd.workers.dev/';
  var BACKEND_URL_P2 = 'https://puerta2-ecuador1438.enyoecd.workers.dev/';
  var LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutos por defecto si no especifica el backend
  var limitTimerId = null;

  function getBackendUrl(door) {
    var doorStr = String(door);
    if (doorStr === '2' || doorStr.toLowerCase().indexOf('puerta 2') !== -1) {
      return BACKEND_URL_P2;
    }
    return BACKEND_URL_P1;
  }

  function getState(door) {
    var key = 'timbre_state_door_' + door;
    try {
      var data = localStorage.getItem(key);
      if (data) {
        return JSON.parse(data);
      }
    } catch (e) {}
    return { count: 0, lockUntil: null };
  }

  function saveState(door, state) {
    var key = 'timbre_state_door_' + door;
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (e) {}
  }

  function getRemainingMinutes(lockUntil) {
    if (!lockUntil) return 0;
    var diffMs = lockUntil - Date.now();
    if (diffMs <= 0) return 0;
    return Math.ceil(diffMs / (60 * 1000));
  }

  function formatRemainingTime(diffMsOrLockUntil) {
    var diffMs = 0;
    if (typeof diffMsOrLockUntil === 'number') {
      // Si el número es mayor a una fecha de timestamp (~1e11), calculamos diff con now
      if (diffMsOrLockUntil > 100000000000) {
        diffMs = diffMsOrLockUntil - Date.now();
      } else {
        diffMs = diffMsOrLockUntil;
      }
    }
    if (diffMs <= 0) return '0 segundos';
    var totalSec = Math.ceil(diffMs / 1000);
    var min = Math.floor(totalSec / 60);
    var sec = totalSec % 60;

    if (min > 0 && sec > 0) {
      return min + (min === 1 ? ' minuto' : ' minutos') + ' y ' + sec + (sec === 1 ? ' segundo' : ' segundos');
    } else if (min > 0) {
      return min + (min === 1 ? ' minuto' : ' minutos');
    } else {
      return sec + (sec === 1 ? ' segundo' : ' segundos');
    }
  }

  function applyLock(door, minutes) {
    var durationMs = (minutes && minutes > 0) ? (minutes * 60 * 1000) : LOCK_DURATION_MS;
    var state = getState(door);
    state.lockUntil = Date.now() + durationMs;
    saveState(door, state);
  }

  var globalDismissHandler = null;

  function detachGlobalDismiss() {
    if (globalDismissHandler) {
      document.removeEventListener('click', globalDismissHandler, true);
      document.removeEventListener('touchstart', globalDismissHandler, true);
      globalDismissHandler = null;
    }
  }

  function attachGlobalDismiss() {
    detachGlobalDismiss();
    setTimeout(function() {
      globalDismissHandler = function(e) {
        hideLimitModal();
      };
      document.addEventListener('click', globalDismissHandler, true);
      document.addEventListener('touchstart', globalDismissHandler, true);
    }, 50);
  }

  function ensureLimitModalInDom() {
    var modal = document.getElementById('timbre-limit-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'timbre-limit-modal';
      modal.className = 'timbre-modal';
      modal.setAttribute('aria-hidden', 'true');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-live', 'assertive');
      modal.innerHTML = 
        '<div class="timbre-modal-card timbre-limit-card">' +
          '<div class="timbre-limit-header">' +
            '<div class="timbre-limit-icon">' +
              '<svg class="w-5 h-5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>' +
                '<line x1="12" y1="9" x2="12" y2="13"></line>' +
                '<line x1="12" y1="17" x2="12.01" y2="17"></line>' +
              '</svg>' +
            '</div>' +
            '<h3 class="timbre-limit-title">Timbre limitado</h3>' +
          '</div>' +
          '<p class="timbre-limit-text" id="timbre-limit-text"></p>' +
        '</div>';
      document.body.appendChild(modal);

      modal.addEventListener('click', function() {
        hideLimitModal();
      });
    }
    return modal;
  }

  function showLimitModal(door, lockUntil) {
    var modal = ensureLimitModalInDom();
    var textEl = modal.querySelector('#timbre-limit-text') || modal.querySelector('.timbre-limit-text');
    var diffMs = lockUntil ? (lockUntil - Date.now()) : (30 * 60 * 1000);
    if (diffMs < 0) diffMs = 0;
    var remainingStr = formatRemainingTime(diffMs);

    if (textEl) {
      textEl.textContent = 'Espera ' + remainingStr + ' para volver a usarlo.';
    }

    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');

    attachGlobalDismiss();

    if (limitTimerId) {
      clearTimeout(limitTimerId);
    }
    // El aviso permanece en pantalla 5 segundos o se cierra al tocar la pantalla
    limitTimerId = setTimeout(function() {
      hideLimitModal();
    }, 5000);
  }

  function hideLimitModal() {
    var modal = document.getElementById('timbre-limit-modal');
    if (modal) {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
    }
    if (limitTimerId) {
      clearTimeout(limitTimerId);
      limitTimerId = null;
    }
    detachGlobalDismiss();
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      hideLimitModal();
    }
  });

  function updateButtonState(btn, door) {
    if (!btn) return;
    var state = getState(door);
    var now = Date.now();

    // Comprobar si el bloqueo ya expiró
    if (state.lockUntil && now >= state.lockUntil) {
      state.count = 0;
      state.lockUntil = null;
      saveState(door, state);
    }

    var isLocked = !!(state.lockUntil && now < state.lockUntil);

    // El botón NO debe quedar deshabilitado realmente para seguir recibiendo clics
    btn.disabled = false;

    if (isLocked) {
      var diffMs = state.lockUntil - now;
      var remainingText = formatRemainingTime(diffMs);
      btn.classList.add('timbre-locked', 'timbre-disabled', 'opacity-50');
      var tooltip = "Timbre limitado. Podrás volver a usarlo en " + remainingText + ".";
      btn.title = tooltip;
      btn.setAttribute('aria-label', tooltip);
    } else {
      btn.classList.remove('timbre-locked', 'timbre-disabled', 'opacity-50');
      btn.removeAttribute('title');
      btn.setAttribute('aria-label', 'Tocar timbre Puerta ' + door);
    }
  }

  async function triggerDoorbell(door, onResponse) {
    var state = getState(door);
    var now = Date.now();

    // Si ya está bloqueado, NO enviar ningún mensaje y mostrar el aviso visual
    if (state.lockUntil && now < state.lockUntil) {
      showLimitModal(door, state.lockUntil);
      if (typeof onResponse === 'function') {
        onResponse({ allowed: false, isBlocked: true, lockUntil: state.lockUntil, remainingMin: getRemainingMinutes(state.lockUntil) });
      }
      return { allowed: false, isBlocked: true, lockUntil: state.lockUntil, remainingMin: getRemainingMinutes(state.lockUntil) };
    }

    if (state.lockUntil && now >= state.lockUntil) {
      state.count = 0;
      state.lockUntil = null;
    }

    // Incrementar contador local
    state.count = (state.count || 0) + 1;
    var isThirdLocal = state.count >= 3;
    if (isThirdLocal) {
      state.lockUntil = now + LOCK_DURATION_MS;
    }
    saveState(door, state);

    // Enviar solicitud POST al backend específico de la puerta
    var backendUrl = getBackendUrl(door);
    var formData = new FormData();
    formData.append('tipo', 'timbre');
    formData.append('puerta', door);

    try {
      var response = await fetch(backendUrl, {
        method: 'POST',
        body: formData
      });

      var data = {};
      try {
        data = await response.json();
      } catch (e) {}

      if (response.status === 429 || data.bloqueado) {
        var min = data.minutos_restantes || getRemainingMinutes(state.lockUntil) || 30;
        applyLock(door, min);
        showLimitModal(door, state.lockUntil || (Date.now() + min * 60 * 1000));
        if (typeof onResponse === 'function') {
          onResponse({ allowed: false, isBlocked: true, remainingMin: min });
        }
        return { allowed: false, isBlocked: true, remainingMin: min };
      }

      if (response.ok && (data.success || data.ok)) {
        var isThird = isThirdLocal || (data.bloqueado_proximamente === true);
        if (typeof onResponse === 'function') {
          onResponse({ allowed: true, isThird: isThird });
        }
        return { allowed: true, isThird: isThird };
      } else {
        if (typeof onResponse === 'function') {
          onResponse({ allowed: true, isThird: isThirdLocal });
        }
        return { allowed: true, isThird: isThirdLocal };
      }
    } catch (error) {
      console.error('Error enviando notificación de timbre:', error);
      if (typeof onResponse === 'function') {
        onResponse({ allowed: true, isThird: isThirdLocal });
      }
      return { allowed: true, isThird: isThirdLocal };
    }
  }

  async function sendForm(formData, door) {
    formData.append('tipo', 'formulario');
    var doorValue = door || formData.get('puerta') || '1';
    var backendUrl = getBackendUrl(doorValue);
    return await fetch(backendUrl, {
      method: 'POST',
      body: formData
    });
  }

  window.TimbreManager = {
    getState: getState,
    saveState: saveState,
    updateButtonState: updateButtonState,
    triggerDoorbell: triggerDoorbell,
    getRemainingMinutes: getRemainingMinutes,
    formatRemainingTime: formatRemainingTime,
    showLimitModal: showLimitModal,
    hideLimitModal: hideLimitModal,
    applyLock: applyLock,
    sendForm: sendForm
  };
})();
