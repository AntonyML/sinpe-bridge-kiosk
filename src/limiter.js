const DEFAULT_STATE = {
  cooldownUntil: 0,
  lastToken: null,
  expiresAt: null,
  lastIssuedAt: null,
  pendingRequestId: null,
  pendingUntil: 0,
  generationCount: 0,
};

async function loadState(storage) {
  const stored = await storage.get("session");
  return { ...DEFAULT_STATE, ...(stored || {}) };
}

async function saveState(storage, state) {
  await storage.put("session", state);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export class KioskLimiterDurableObject {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === "/status" && method === "GET") {
      return this.handleStatus();
    }

    if (url.pathname === "/prepare" && method === "POST") {
      return this.handlePrepare(request);
    }

    if (url.pathname === "/commit" && method === "POST") {
      return this.handleCommit(request);
    }

    if (url.pathname === "/release" && method === "POST") {
      return this.handleRelease(request);
    }

    return json({ ok: false, message: "Not found" }, 404);
  }

  async handleStatus() {
    const current = await loadState(this.state.storage);
    const now = Date.now();
    const active =
      Boolean(current.lastToken) &&
      Boolean(current.expiresAt) &&
      new Date(current.expiresAt).getTime() > now;

    return json({
      active,
      token: active ? current.lastToken : null,
      expiresAt: active ? current.expiresAt : null,
      cooldownUntil: current.cooldownUntil || 0,
      generationCount: current.generationCount || 0,
      lastIssuedAt: current.lastIssuedAt || null,
    });
  }

  async handlePrepare(request) {
    const body = await request.json();
    const now = Date.now();
    const current = await loadState(this.state.storage);
    const cooldownMs = Number(body.cooldownMs || 8000);
    const pendingWindowMs = Number(body.pendingWindowMs || 10000);

    const hasActiveToken =
      Boolean(current.lastToken) &&
      Boolean(current.expiresAt) &&
      new Date(current.expiresAt).getTime() > now;

    if (hasActiveToken) {
      return json({
        allowed: false,
        reason: "active_token",
        token: current.lastToken,
        expiresAt: current.expiresAt,
      });
    }

    if (current.pendingRequestId && current.pendingUntil > now) {
      return json({
        allowed: false,
        reason: "pending_generation",
        retryAfterMs: current.pendingUntil - now,
      }, 429);
    }

    if ((current.cooldownUntil || 0) > now) {
      return json({
        allowed: false,
        reason: "cooldown_active",
        retryAfterMs: current.cooldownUntil - now,
      }, 429);
    }

    current.pendingRequestId = body.requestId;
    current.pendingUntil = now + pendingWindowMs;
    current.cooldownUntil = now + cooldownMs;
    await saveState(this.state.storage, current);

    return json({
      allowed: true,
      cooldownUntil: current.cooldownUntil,
    });
  }

  async handleCommit(request) {
    const body = await request.json();
    const current = await loadState(this.state.storage);

    current.lastToken = body.token;
    current.expiresAt = body.expiresAt;
    current.lastIssuedAt = body.issuedAt || new Date().toISOString();
    current.generationCount = (current.generationCount || 0) + 1;
    current.pendingRequestId = null;
    current.pendingUntil = 0;

    await saveState(this.state.storage, current);

    return json({
      ok: true,
      token: current.lastToken,
      expiresAt: current.expiresAt,
      generationCount: current.generationCount,
    });
  }

  async handleRelease(request) {
    const body = await request.json();
    const current = await loadState(this.state.storage);

    if (!body.requestId || current.pendingRequestId === body.requestId) {
      current.pendingRequestId = null;
      current.pendingUntil = 0;
      await saveState(this.state.storage, current);
    }

    return json({ ok: true });
  }
}
