(function() {
  var BACKEND_URL_P1 = 'https://puerta1-ecuador1438.enyoecd.workers.dev/';
  var BACKEND_URL_P2 = 'https://puerta2-ecuador1438.enyoecd.workers.dev/';
  var LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutos por defecto si no especifica el backend

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

  function applyLock(door, minutes) {
    var durationMs = (minutes && minutes > 0) ? (minutes * 60 * 1000) : LOCK_DURATION_MS;
    var state = getState(door);
    state.lockUntil = Date.now() + durationMs;
    saveState(door, state);
  }

  function updateButtonState(btn, door) {
    var state = getState(door);
    var now = Date.now();

    // Comprobar si el bloqueo ya expiró
    if (state.lockUntil && now >= state.lockUntil) {
      state.count = 0;
      state.lockUntil = null;
      saveState(door, state);
    }

    var remainingMin = getRemainingMinutes(state.lockUntil);

    if (remainingMin > 0) {
      btn.disabled = true;
      btn.classList.add('timbre-disabled', 'opacity-50', 'cursor-not-allowed', 'pointer-events-auto');
      var tooltip = "Faltan " + remainingMin + (remainingMin === 1 ? " minuto" : " minutos") + " para volver a habilitar el timbre.";
      btn.title = tooltip;
      btn.setAttribute('aria-label', tooltip);
    } else {
      btn.disabled = false;
      btn.classList.remove('timbre-disabled', 'opacity-50', 'cursor-not-allowed');
      btn.removeAttribute('title');
      btn.setAttribute('aria-label', 'Tocar timbre Puerta ' + door);
    }
  }

  async function triggerDoorbell(door, onResponse) {
    var state = getState(door);
    var now = Date.now();

    if (state.lockUntil && now < state.lockUntil) {
      return { allowed: false, remainingMin: getRemainingMinutes(state.lockUntil) };
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
        // En caso de respuesta ok por defecto
        if (typeof onResponse === 'function') {
          onResponse({ allowed: true, isThird: isThirdLocal });
        }
        return { allowed: true, isThird: isThirdLocal };
      }
    } catch (error) {
      console.error('Error enviando notificación de timbre:', error);
      // Si falla la red, mantenemos el comportamiento visual local
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
    applyLock: applyLock,
    sendForm: sendForm
  };
})();
