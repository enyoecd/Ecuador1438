/* ═══════════════════════════════════════════════════
   puerta2.js — Lógica específica de Puerta 2
   Ecuador 1438
   ─────────────────────────────────────────────────
   Depende de TimbreManager (definido en JS/timbre.js);
   por lo tanto este archivo debe cargarse después de
   timbre.js en la página.

   Secciones:
     1.  Referencias del modal de timbre
     2.  Sonido del timbre (Ding-Dong)
     3.  Estado visual del botón de timbre (bloqueo/límite)
     4.  Acción del botón de timbre al hacerle clic
     5.  Envío del formulario
     6.  Modal Ampliar Imagen
     7.  Selección y subida de fotos (vista previa)
   ═══════════════════════════════════════════════════ */

(function () {
  // ───────── 1. REFERENCIAS DEL MODAL DE TIMBRE ─────────
  var modal = document.getElementById('timbre-modal');
  var modalText = modal ? modal.querySelector('.timbre-modal-text') : null;
  var btnTimbre = document.getElementById('btn-timbre-p2');
  var timerId = null;

  // ───────── 2. SONIDO DEL TIMBRE (Ding-Dong) ─────────
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

  // ───────── 3. ESTADO VISUAL DEL BOTÓN DE TIMBRE (BLOQUEO/LÍMITE) ─────────
  function refreshButton() {
    if (btnTimbre) {
      window.TimbreManager.updateButtonState(btnTimbre, '2');
    }
  }

  // ───────── 4. ACCIÓN DEL BOTÓN DE TIMBRE AL HACERLE CLIC ─────────
  if (btnTimbre) {
    refreshButton();
    setInterval(refreshButton, 1000);

    btnTimbre.addEventListener('click', function () {
      window.TimbreManager.triggerDoorbell('2', function (result) {
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

  // ───────── 5. ENVÍO DEL FORMULARIO ─────────
  // Envía los datos del contacto al backend (Cloudflare Worker)
  // mediante TimbreManager.sendForm.
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
      var messageVal = document.getElementById('message') ? document.getElementById('message').value.trim() : '';
      var photosInput = document.getElementById('photos');

      formData.append('nombre', fullNameVal);
      formData.append('email', emailVal);
      formData.append('telefono', phoneVal);
      formData.append('mensaje', messageVal);
      formData.append('puerta', 'Puerta 2');

      if (photosInput && photosInput.files && photosInput.files.length > 0) {
        formData.append('foto', photosInput.files[0]);
      }

      try {
        var response = await window.TimbreManager.sendForm(formData, '2');
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

  // ───────── 6. MODAL AMPLIAR IMAGEN ─────────
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

  // ───────── 7. SELECCIÓN Y SUBIDA DE FOTOS (VISTA PREVIA) ─────────
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
          container.className = 'relative w-12 h-12 rounded-lg overflow-hidden border border-red-400/40 shrink-0 bg-gray-900';

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