# sinpe-bridge-kiosk

Pantalla kiosk premium para comercios fisicos que genera un codigo temporal SINPE con una sola accion.

La arquitectura sigue una regla dura: solo existen dos capas reales.

- `sinpe-bridge-kiosk`: Edge/UI en Cloudflare Pages + Cloudflare Worker + Durable Object mini.
- `sinpe-bridge-api`: Backend central en FastAPI con reglas financieras, seguridad, PostgreSQL, auditoria y logica SINPE.

## Objetivo

Este proyecto no es un POS completo, no es un dashboard y no es una app administrativa.

Hace una sola cosa:

1. Mostrar una interfaz kiosk fullscreen.
2. Permitir tocar `Generar codigo`.
3. Llamar al Worker del kiosk.
4. Reenviar al worker proxy existente.
5. Recibir desde la API un token temporal.
6. Mostrarlo en grande con countdown visual.
7. Volver automaticamente al home cuando expira.

## Arquitectura

```text
Cliente en pantalla kiosk
        |
        v
sinpe-bridge-kiosk/public
        |
        v
sinpe-bridge-kiosk/src/worker.js
        |
        +--> Durable Object mini
        |     - anti spam
        |     - cooldown
        |     - ultimo token
        |
        v
WORKER_PROXY_URL
        |
        v
sinpe-bridge-api
```

## Filosofia

- Menos capas.
- Menos moving parts.
- UI extremadamente rapida.
- Estado edge minimo.
- Logica financiera solo en FastAPI.

## Estructura del proyecto

```text
sinpe-bridge-kiosk/
├── public/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── assets/
├── src/
│   ├── worker.js
│   ├── limiter.js
│   └── templates/
├── wrangler.toml
├── package.json
├── README.md
├── .gitignore
└── .dev.vars.example
```

## UX/UI

La UI toma como inspiracion principal `DESIGN.md` del repo:

- base clara y premium
- tipografia monoespaciada para titulares
- acento azul para accion principal
- look fintech limpio
- botones gigantes tactiles
- countdown con glow sutil
- motion corto y util

## Endpoints del Worker

### `GET /`

Sirve la UI kiosk.

### `POST /generate-token`

Genera un token temporal.

Request:

```json
{
  "kioskId": "kiosk-front-01"
}
```

Response exitosa:

```json
{
  "ok": true,
  "kioskId": "kiosk-front-01",
  "token": "A91K2",
  "expiresAt": "2026-05-25T18:20:00.000Z",
  "message": "Coloque este codigo en el comprobante SINPE."
}
```

### `GET /check-status?kioskId=kiosk-front-01`

Consulta el ultimo token activo almacenado por el Durable Object.

### `GET /health`

Health check del kiosk Worker. Intenta verificar:

- conectividad con `WORKER_PROXY_URL/health`

## Durable Object mini

`src/limiter.js` contiene `KioskLimiterDurableObject`.

Responsabilidades:

- bloquear taps excesivos
- aplicar cooldown corto
- retener el ultimo token activo
- evitar dobles solicitudes simultaneas

No hace:

- logica financiera
- validaciones de negocio
- persistencia transaccional
- seguridad bancaria

## Flujo kiosk -> worker -> api

1. El usuario toca `Generar codigo`.
2. `public/app.js` llama `POST /generate-token`.
3. `src/worker.js` pregunta al Durable Object si puede generar.
4. Si ya existe un token vigente, lo reutiliza.
5. Si hay cooldown, devuelve `429`.
6. Si esta permitido, el Worker llama al proxy usando `WORKER_PROXY_URL`.
7. El proxy llama a FastAPI.
8. FastAPI responde con un token temporal.
9. El Worker lo normaliza y lo almacena en el Durable Object.
10. La UI muestra el codigo con countdown.
11. Al expirar, la UI vuelve sola al home.

## Contrato esperado con proxy / API

El kiosk asume un endpoint de proxy para token temporal:

`POST {WORKER_PROXY_URL}/api/v1/kiosk/token`

Payload enviado:

```json
{
  "kiosk_id": "kiosk-front-01",
  "channel": "kiosk",
  "source": "sinpe-bridge-kiosk",
  "requested_at": "2026-05-25T18:18:00.000Z"
}
```

El Worker acepta cualquiera de estas propiedades en la respuesta:

- `token`
- `code`
- `correlation_token`
- `correlationToken`

Opcionales:

- `expires_at`
- `expiresAt`
- `message`

Ejemplo:

```json
{
  "token": "A91K2",
  "expires_at": "2026-05-25T18:20:00.000Z",
  "message": "Coloque este codigo en el comprobante SINPE."
}
```

## Variables de entorno

Se preparan en `.dev.vars` a partir de `.dev.vars.example`.

```env
API_KEY=replace-with-real-api-key
WORKER_PROXY_URL=api.tonyml.com
```

Uso:

- `API_KEY`: se reenvia al proxy con `x-api-key`.
- `WORKER_PROXY_URL`: upstream unico del kiosk Worker. Puede configurarse como `api.tonyml.com` o `https://api.tonyml.com`.

Variables opcionales ya incluidas en `wrangler.toml`:

- `TOKEN_ENDPOINT_PATH`
- `TOKEN_STATUS_ENDPOINT_PATH`
- `COOLDOWN_MS`
- `TOKEN_TTL_MS`

## Desarrollo local

### 1. Instalar dependencias

```bash
npm install
```

### 2. Copiar variables

```bash
copy .dev.vars.example .dev.vars
```

### 3. Correr el Worker

```bash
npm run dev
```

Disponible normalmente en:

`http://127.0.0.1:8787`

## Despliegue

### Deploy directo con Wrangler

```bash
npm run deploy
```

### Produccion

```bash
wrangler secret put API_KEY
npm run deploy:prod
```

## Observability

El Worker produce logs estructurados utiles para Cloudflare Observability.

Eventos principales:

- `kiosk_connected`
- `token_generated`
- `token_reused`
- `cooldown_active`
- `api_unavailable`

## Cloudflare Pages + Worker

El proyecto esta preparado para que el Worker sirva los assets de `public/` usando el binding `ASSETS`.

Eso mantiene la arquitectura simple:

- una sola UI estatica
- un solo Worker
- un solo Durable Object

## Archivos clave

- [public/index.html](E:/Dev/Proyectos_Universidad/simpe-bridge/sinpe-bridge-kiosk/public/index.html)
- [public/style.css](E:/Dev/Proyectos_Universidad/simpe-bridge/sinpe-bridge-kiosk/public/style.css)
- [public/app.js](E:/Dev/Proyectos_Universidad/simpe-bridge/sinpe-bridge-kiosk/public/app.js)
- [src/worker.js](E:/Dev/Proyectos_Universidad/simpe-bridge/sinpe-bridge-kiosk/src/worker.js)
- [src/limiter.js](E:/Dev/Proyectos_Universidad/simpe-bridge/sinpe-bridge-kiosk/src/limiter.js)

## Notas de implementacion

- El Durable Object almacena solo el minimo estado efimero por kiosk.
- El Worker normaliza distintos formatos de respuesta para facilitar integrar la API actual.
- El kiosk nunca llama directo a FastAPI; todo pasa por el proxy configurado en `WORKER_PROXY_URL`.
- Si el backend aun no expone el endpoint de token temporal, el kiosk ya queda listo y solo necesita alinear ese contrato upstream.
