import { KioskLimiterDurableObject } from "./limiter.js";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function getKioskId(url, body) {
  return (
    body?.kioskId ||
    url.searchParams.get("kioskId") ||
    "kiosk-front-01"
  );
}

function getLimiterStub(env, kioskId) {
  const id = env.KIOSK_LIMITER.idFromName(kioskId);
  return env.KIOSK_LIMITER.get(id);
}

function envNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function createRequestId() {
  return crypto.randomUUID();
}

function log(level, event, data = {}) {
  console[level](
    JSON.stringify({
      level,
      event,
      service: "sinpe-bridge-kiosk",
      timestamp: new Date().toISOString(),
      ...data,
    }),
  );
}

function normalizeProxyUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function normalizeTokenResponse(payload, env) {
  const token =
    payload?.token ||
    payload?.code ||
    payload?.correlation_token ||
    payload?.correlationToken;

  if (!token) {
    return null;
  }

  const ttlMs = envNumber(env.TOKEN_TTL_MS, 90000);
  const expiresAt =
    payload?.expires_at ||
    payload?.expiresAt ||
    new Date(Date.now() + ttlMs).toISOString();

  return {
    token: String(token).toUpperCase(),
    expiresAt,
    message:
      payload?.message || "Coloque este codigo en el comprobante SINPE.",
    raw: payload,
  };
}

async function proxyGenerateToken(env, requestId, kioskId) {
  const targetUrl = normalizeProxyUrl(
    env.WORKER_PROXY_URL,
    env.TOKEN_ENDPOINT_PATH || "/api/v1/kiosk/token",
  );

  const upstreamResponse = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": env.API_KEY,
      "x-request-id": requestId,
      "x-correlation-id": requestId,
      "x-kiosk-id": kioskId,
    },
    body: JSON.stringify({
      kiosk_id: kioskId,
      channel: "kiosk",
      source: "sinpe-bridge-kiosk",
      requested_at: new Date().toISOString(),
    }),
  });

  const payload = await upstreamResponse.json().catch(() => ({}));

  if (!upstreamResponse.ok) {
    throw new Error(
      payload?.detail ||
        payload?.message ||
        `Proxy returned status ${upstreamResponse.status}`,
    );
  }

  return normalizeTokenResponse(payload, env);
}

async function fetchLimiter(stub, path, init = {}) {
  const response = await stub.fetch(`https://limiter${path}`, init);
  return response.json();
}

async function handleGenerateToken(request, env) {
  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const kioskId = getKioskId(url, body);
  const requestId = createRequestId();
  const limiter = getLimiterStub(env, kioskId);
  const cooldownMs = envNumber(env.COOLDOWN_MS, 8000);

  const preparation = await fetchLimiter(limiter, "/prepare", {
    method: "POST",
    body: JSON.stringify({
      requestId,
      cooldownMs,
      pendingWindowMs: 10000,
    }),
  });

  if (!preparation.allowed) {
    if (preparation.reason === "active_token") {
      log("info", "token_reused", { kioskId, requestId });
      return json({
        ok: true,
        kioskId,
        token: preparation.token,
        expiresAt: preparation.expiresAt,
        message: "Este codigo sigue vigente. Puede usarlo en el comprobante.",
        reused: true,
      });
    }

    log("info", "cooldown_active", {
      kioskId,
      requestId,
      retryAfterMs: preparation.retryAfterMs || 0,
    });

    return json(
      {
        ok: false,
        kioskId,
        message: "Espere unos segundos antes de solicitar otro codigo.",
        retryAfterMs: preparation.retryAfterMs || 0,
      },
      429,
    );
  }

  try {
    const tokenPayload = await proxyGenerateToken(env, requestId, kioskId);

    if (!tokenPayload) {
      throw new Error("Proxy response did not include a token");
    }

    await fetchLimiter(limiter, "/commit", {
      method: "POST",
      body: JSON.stringify({
        requestId,
        token: tokenPayload.token,
        expiresAt: tokenPayload.expiresAt,
        issuedAt: new Date().toISOString(),
      }),
    });

    log("info", "token_generated", {
      kioskId,
      requestId,
      expiresAt: tokenPayload.expiresAt,
    });

    return json({
      ok: true,
      kioskId,
      token: tokenPayload.token,
      expiresAt: tokenPayload.expiresAt,
      message: tokenPayload.message,
    });
  } catch (error) {
    await fetchLimiter(limiter, "/release", {
      method: "POST",
      body: JSON.stringify({ requestId }),
    });

    log("error", "api_unavailable", {
      kioskId,
      requestId,
      error: String(error),
    });

    return json(
      {
        ok: false,
        kioskId,
        message: "No fue posible generar el codigo SINPE en este momento.",
        detail: String(error),
      },
      502,
    );
  }
}

async function handleCheckStatus(request, env) {
  const url = new URL(request.url);
  const kioskId = getKioskId(url, null);
  const limiter = getLimiterStub(env, kioskId);
  const payload = await fetchLimiter(limiter, "/status");

  return json({
    ok: true,
    kioskId,
    active: payload.active,
    token: payload.token,
    expiresAt: payload.expiresAt,
    generationCount: payload.generationCount,
    message: payload.active
      ? "Este codigo sigue vigente. Puede usarlo en el comprobante."
      : null,
  });
}

async function ping(url, init) {
  const startedAt = Date.now();

  try {
    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      error: String(error),
    };
  }
}

async function handleHealth(env) {
  const proxyHealthUrl = normalizeProxyUrl(env.WORKER_PROXY_URL, "/health");
  const apiHealthUrl = normalizeProxyUrl(env.API_BASE_URL, "/health");

  const [proxy, api] = await Promise.all([
    ping(proxyHealthUrl, {
      headers: {
        "x-api-key": env.API_KEY,
      },
    }),
    ping(apiHealthUrl, {}),
  ]);

  const status = proxy.ok ? 200 : 503;
  log("info", "kiosk_connected", { proxyStatus: proxy.status, apiStatus: api.status });

  return json(
    {
      ok: proxy.ok,
      service: "sinpe-bridge-kiosk",
      proxy,
      api,
    },
    status,
  );
}

async function handleStatic(request, env) {
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/generate-token" && request.method === "POST") {
      return handleGenerateToken(request, env);
    }

    if (url.pathname === "/check-status" && request.method === "GET") {
      return handleCheckStatus(request, env);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env);
    }

    return handleStatic(request, env);
  },
};

export { KioskLimiterDurableObject };
