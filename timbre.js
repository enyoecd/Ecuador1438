(function() {
  var LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutos en milisegundos
  var MAX_TOUCHES = 3;

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

  function triggerDoorbell(door, onSuccess) {
    var state = getState(door);
    var now = Date.now();

    if (state.lockUntil && now < state.lockUntil) {
      return { allowed: false, remainingMin: getRemainingMinutes(state.lockUntil) };
    }

    if (state.lockUntil && now >= state.lockUntil) {
      state.count = 0;
      state.lockUntil = null;
    }

    state.count = (state.count || 0) + 1;
    var isThird = state.count >= MAX_TOUCHES;

    if (isThird) {
      state.lockUntil = now + LOCK_DURATION_MS;
    }

    saveState(door, state);

    if (typeof onSuccess === 'function') {
      onSuccess(isThird);
    }

    return { allowed: true, isThird: isThird };
  }

  window.TimbreManager = {
    getState: getState,
    saveState: saveState,
    updateButtonState: updateButtonState,
    triggerDoorbell: triggerDoorbell,
    getRemainingMinutes: getRemainingMinutes
  };
})();
