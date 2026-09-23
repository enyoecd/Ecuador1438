/* ═══════════════════════════════════════════════════
   puerta1.js — Lógica específica de Puerta 1
   Ecuador 1438
   ─────────────────────────────────────────────────
   Depende de TimbreManager (definido en JS/timbre.js);
   por lo tanto este archivo debe cargarse después de
   timbre.js en la página.

   Secciones:
     1.  Utilidades de fecha / hora
     2.  Referencias del modal de timbre
     3.  Sonido del timbre (Ding-Dong)
     4.  Estado visual del botón de timbre (bloqueo/límite)
     5.  Acción del botón de timbre al hacerle clic
     6.  Envío del formulario
     7.  Modal Ampliar Imagen
     8.  Selección y subida de fotos (vista previa)
   ═══════════════════════════════════════════════════ */

(function () {
  // ───────── 1. UTILIDADES DE FECHA / HORA ─────────
  function formatDate(d) {
    var date = d || new Date();
    var dd = String(date.getDate()).padStart(2, '0');
    var mm = String(date.getMonth() + 1).padStart(2, '0');
    var yyyy = date.getFullYear();
    return dd + '/' + mm + '/' + yyyy;
  }

  function formatTime(d) {
    var date = d || new Date();
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    var ss = String(date.getSeconds()).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }

  // ───────── 2. REFERENCIAS DEL MODAL DE TIMBRE ─────────
  var modal = document.getElementById('timbre-modal');
  var modalText = modal ? modal.querySelector('.timbre-modal-text') : null;
  var btnTimbre = document.getElementById('btn-timbre-p1');
  var timerId = null;

  // ───────── 3. SONIDO DEL TIMBRE (Ding-Dong) ─────────
  function playChime() {
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      var ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume();

      var osc1 = ctx.createOscillator();
      var gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(659.25, ctx.currentTime);
      gain1.gain.setValueAtTime(0.3, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.9);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(ctx.currentTime);
      osc1.stop(ctx.currentTime + 0.9);

      var osc2 = ctx.createOscillator();
      var gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(523.25, ctx.currentTime + 0.35);
      gain2.gain.setValueAtTime(0.35, ctx.currentTime + 0.35);
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.4);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(ctx.currentTime + 0.35);
      osc2.stop(ctx.currentTime + 1.4);
    } catch (e) { }
  }

  // ───────── 4. ESTADO VISUAL DEL BOTÓN DE TIMBRE (BLOQUEO/LÍMITE) ─────────
  function refreshButton() {
    if (btnTimbre) {
      window.TimbreManager.updateButtonState(btnTimbre, '1');
    }
  }

  // ───────── 5. ACCIÓN DEL BOTÓN DE TIMBRE AL HACERLE CLIC ─────────
  if (btnTimbre) {
    refreshButton();
    setInterval(refreshButton, 1000);

    btnTimbre.addEventListener('click', function () {
      window.TimbreManager.triggerDoorbell('1', function (result) {
        if (!result.allowed) {
          refreshButton();
          return;
        }

        if (modalText) {
          if (result.isThird) {
            modalText.textContent = "Timbre sonando. Vuelve a usarlo en 30 minutos.";
          } else {
            modalText.textContent = "Timbre sonando";
          }
        }

        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
        playChime();

        if (timerId) clearTimeout(timerId);
        timerId = setTimeout(function () {
          modal.classList.remove('active');
          modal.setAttribute('aria-hidden', 'true');
        }, result.isThird ? 4000 : 2500);

        refreshButton();
      });
    });
  }

  // ───────── 6. ENVÍO DEL FORMULARIO ─────────
  // Envía los datos del contacto al backend (Cloudflare Worker)
  // mediante TimbreManager.sendForm e integra las fechas de
  // ingreso (sessionStorage) y de envío en el mensaje final.
  var contactForm = document.querySelector('form');
  var msgModal = document.getElementById('msg-modal');
  var msgTimerId = null;

  function showMessageSentNotification() {
    if (!msgModal) return;
    msgModal.classList.add('active');
    msgModal.setAttribute('aria-hidden', 'false');
    if (msgTimerId) clearTimeout(msgTimerId);
    msgTimerId = setTimeout(function () {
      msgModal.classList.remove('active');
      msgModal.setAttribute('aria-hidden', 'true');
    }, 5000);
  }

  if (contactForm) {
    contactForm.addEventListener('submit', async function (e) {
      e.preventDefault();

      var nowEnvio = new Date();
      var fechaEnvio = formatDate(nowEnvio);
      var horaEnvio = formatTime(nowEnvio);

      var fechaIngreso = sessionStorage.getItem('fechaIngreso') || fechaEnvio;
      var horaIngreso = sessionStorage.getItem('horaIngreso') || horaEnvio;

      var submitBtn = contactForm.querySelector('button[type="submit"]');
      var originalBtnText = submitBtn ? submitBtn.textContent : 'Enviar Mensaje';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Enviando...';
      }

      var formData = new FormData();
      var fullNameVal = document.getElementById('fullName') ? document.getElementById('fullName').value.trim() : '';
      var emailVal = document.getElementById('email') ? document.getElementById('email').value.trim() : '';
      var phoneVal = document.getElementById('phone') ? document.getElementById('phone').value.trim() : '';
      var contactReasonVal = document.getElementById('contactReason') ? document.getElementById('contactReason').value.trim() : '';
      var messageVal = document.getElementById('message') ? document.getElementById('message').value.trim() : '';
      var photosInput = document.getElementById('photos');

      var finalMessage = messageVal +
        '\n\nMotivo de contacto: ' + contactReasonVal +
        '\n\nFecha ingreso: ' + fechaIngreso +
        '\nHora ingreso: ' + horaIngreso +
        '\n\nFecha envío: ' + fechaEnvio +
        '\nHora envío: ' + horaEnvio;

      formData.append('nombre', fullNameVal);
      formData.append('email', emailVal);
      formData.append('telefono', phoneVal);
      formData.append('motivo', contactReasonVal);
      formData.append('mensaje', finalMessage);
      formData.append('puerta', 'Puerta 1');

      if (photosInput && photosInput.files && photosInput.files.length > 0) {
        formData.append('foto', photosInput.files[0]);
      }

      try {
        var response = await window.TimbreManager.sendForm(formData, '1');
        if (response.ok) {
          showMessageSentNotification();
          contactForm.reset();
          var photosPreview = document.getElementById('photos-preview');
          if (photosPreview) photosPreview.innerHTML = '';
        } else {
          console.error('Hubo un problema al enviar el mensaje');
        }
      } catch (err) {
        console.error('Error al enviar el formulario:', err);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalBtnText;
        }
      }
    });
  }

  // ───────── 7. MODAL AMPLIAR IMAGEN ─────────
  // Muestra la foto de la puerta en grande al hacer clic/teclado
  // sobre el avatar, y la cierra al tocar fuera, con la X o Escape.
  var imgModal = document.getElementById('image-modal');
  var doorAvatar = document.getElementById('door-avatar');
  var btnCloseImg = document.getElementById('btn-close-image');
  var imageTimerId = null;

  function openImageModal() {
    if (!imgModal) return;
    imgModal.classList.add('active');
    imgModal.setAttribute('aria-hidden', 'false');

    if (imageTimerId) clearTimeout(imageTimerId);
    imageTimerId = setTimeout(function () {
      closeImageModal();
    }, 3000);
  }

  function closeImageModal() {
    if (!imgModal) return;
    imgModal.classList.remove('active');
    imgModal.setAttribute('aria-hidden', 'true');
    if (imageTimerId) {
      clearTimeout(imageTimerId);
      imageTimerId = null;
    }
  }

  if (doorAvatar) {
    doorAvatar.addEventListener('click', openImageModal);
    doorAvatar.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openImageModal();
      }
    });
  }

  if (imgModal) {
    imgModal.addEventListener('click', closeImageModal);
  }

  if (btnCloseImg) {
    btnCloseImg.addEventListener('click', function (e) {
      e.stopPropagation();
      closeImageModal();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && imgModal && imgModal.classList.contains('active')) {
      closeImageModal();
    }
  });

  // ───────── 8. SELECCIÓN Y SUBIDA DE FOTOS (VISTA PREVIA) ─────────
  // Al elegir archivos en el input de fotos se genera una vista
  // previa en miniatura por cada imagen seleccionada.
  var photosInput = document.getElementById('photos');
  var photosPreview = document.getElementById('photos-preview');

  if (photosInput && photosPreview) {
    photosInput.addEventListener('change', function () {
      photosPreview.innerHTML = '';
      var files = Array.from(this.files);

      files.forEach(function (file) {
        if (!file.type.startsWith('image/')) return;
        var reader = new FileReader();
        reader.onload = function (e) {
          var container = document.createElement('div');
          container.className = 'relative w-12 h-12 rounded-lg overflow-hidden border border-sky-400/40 shrink-0 bg-gray-900';

          var img = document.createElement('img');
          img.src = e.target.result;
          img.className = 'w-full h-full object-cover';
          img.alt = file.name;

          container.appendChild(img);
          photosPreview.appendChild(container);
        };
        reader.readAsDataURL(file);
      });
    });
  }
})();