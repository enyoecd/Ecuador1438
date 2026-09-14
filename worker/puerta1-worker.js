// Ejemplo de Cloudflare Worker para añadir validación por token a los endpoints de cámara
// NOTA: Esto es un ejemplo mínimo. Para producción se recomienda:
//  - Usar Tokens por sesión (generados al iniciar transmisión) y almacenarlos en Workers KV con TTL
//  - No usar un "SECRET" estático compartido si necesitas revocar tokens individualmente
//  - Agregar autenticación y limitación de velocidad para los endpoints de control

// Configurar una variable de entorno/Secret en Cloudflare: SECRET_VIEWER_TOKEN
// wrangler.toml -> env -> "vars" o usar el Dashboard -> Worker -> Variables de entorno

// ENDPOINTS esperados (compatibles con el frontend modificado):
//  - GET /?tipo=camara&accion=estado&token=...  => valida token (si está configurado) y responde {ocupado: boolean}
//  - POST (form): { tipo: 'camara', accion: 'viewer', token: '...' } => valida token y devuelve initData (sessionId, appId, localMode)
//  - POST (form): { tipo: 'camara', accion: 'iniciar' } => inicia la cámara y puede devolver viewerToken (ej: viewerToken: SECRET_VIEWER_TOKEN)

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// Lectura de secret desde binding. Asegúrate de definir SECRET_VIEWER_TOKEN en el entorno del Worker.
const SECRET = (typeof SECRET_VIEWER_TOKEN !== 'undefined') ? SECRET_VIEWER_TOKEN : null;

async function handleRequest(request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  // Helper para validar token (en query o en body FormData/json)
  async function getTokenFromRequest() {
    const q = url.searchParams.get('token');
    if (q) return q;
    if (method === 'POST') {
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try { const j = await request.json(); return j.token || null } catch(_) { return null }
      }
      if (ct.includes('form')) {
        try { const form = await request.formData(); return form.get('token') || null } catch(_) { return null }
      }
    }
    return null;
  }

  // Modo simple de respuesta JSON
  function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status: status, headers: { 'Content-Type': 'application/json' } });
  }

  // Simple routing por query params
  const tipo = url.searchParams.get('tipo') || null;
  const accion = url.searchParams.get('accion') || null;

  // Permitir una ruta POST con form-data que incluye tipo/accion
  if (method === 'POST') {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try {
        const body = await request.json();
        // Priorizar body.tipo/body.accion
        if (body && body.tipo === 'camara') {
          return handleCamaraAccion(request, body);
        }
      } catch (_) {}
    } else {
      try {
        const form = await request.formData();
        const fTipo = form.get('tipo');
        const fAccion = form.get('accion');
        if (fTipo === 'camara') {
          return handleCamaraAccion(request, { tipo: fTipo, accion: fAccion, form: form });
        }
      } catch (_) {}
    }
  }

  // GET handlers
  if (method === 'GET' && tipo === 'camara' && accion === 'estado') {
    // Validar token si hay un SECRET configurado
    if (SECRET) {
      const token = await getTokenFromRequest();
      if (!token || token !== SECRET) return jsonResponse({ error: 'invalid_token' }, 401);
    }

    // Aquí se devolvería el estado real (ocupado/no) consultando KV o similar
    // Para este ejemplo devolvemos "ocupado: false" como placeholder
    return jsonResponse({ ocupado: false });
  }

  // Si no coincide ninguna ruta
  return jsonResponse({ error: 'not_found' }, 404);

  // Handler interno para acciones de cámara desde POST (form/json)
  async function handleCamaraAccion(req, body) {
    const accionLocal = (body && body.accion) || (body.form && body.form.get('accion')) || null;

    if (!accionLocal) return jsonResponse({ error: 'missing_action' }, 400);

    // Acciones públicas (iniciar, finalizar) - no requieren token para iniciador
    if (accionLocal === 'iniciar') {
      // Lógica de reserva de sesión: aquí deberías integrar con Cloudflare Calls y KV
      // Para el ejemplo devolvemos sessionId/appId falsos y, si hay SECRET, devolvemos viewerToken
      const sessionId = 'session-' + Date.now();
      const appId = 'cf-calls-app-example';

      const resp = { sessionId: sessionId, appId: appId, localMode: false };
      if (SECRET) {
        // En un despliegue real: generar token por sesión y guardar en KV con TTL
        resp.viewerToken = SECRET; // ejemplo simple: usar el secret estático
      }
      return jsonResponse(resp);
    }

    // Acciones que requieren token: viewer (cuando el navegador viewer solicita init)
    if (accionLocal === 'viewer') {
      const token = await getTokenFromRequest();
      if (SECRET) {
        if (!token || token !== SECRET) return jsonResponse({ error: 'invalid_token' }, 401);
      }
      // Si el token es válido, retornar los datos de inicio de viewer (sessionId/appId/localMode)
      // Normalmente aquí el worker llama a Cloudflare Calls para obtener sessionId/appId del viewer
      // Ejemplo de respuesta mínima:
      return jsonResponse({ sessionId: 'viewer-session-example', appId: 'cf-calls-app-example', localMode: true });
    }

    // Otros actions: tracks-new, renegotiate, finalizar, etc., deben implementarse según la integración existente
    return jsonResponse({ error: 'accion_no_implementada' }, 400);
  }
}