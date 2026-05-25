const screens = {
  home: document.querySelector('[data-screen="home"]'),
  loading: document.querySelector('[data-screen="loading"]'),
  token: document.querySelector('[data-screen="token"]'),
  error: document.querySelector('[data-screen="error"]'),
};

const elements = {
  clock: document.getElementById("clock"),
  connectionBadge: document.getElementById("connection-badge"),
  generateButton: document.getElementById("generate-button"),
  retryButton: document.getElementById("retry-button"),
  tokenValue: document.getElementById("token-value"),
  tokenInstruction: document.getElementById("token-instruction"),
  countdownText: document.getElementById("countdown-text"),
  countdownBar: document.getElementById("countdown-bar"),
  errorTitle: document.getElementById("error-title"),
  errorMessage: document.getElementById("error-message"),
};

const kioskId =
  new URLSearchParams(window.location.search).get("kioskId") || "kiosk-front-01";

let countdownTimer = null;

function setScreen(name) {
  Object.entries(screens).forEach(([key, node]) => {
    const isActive = key === name;
    node.classList.toggle("is-active", isActive);
    node.setAttribute("aria-hidden", String(!isActive));
  });
}

function setConnectionState(label) {
  elements.connectionBadge.textContent = label;
}

function updateClock() {
  const now = new Date();
  elements.clock.textContent = now.toLocaleTimeString("es-CR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function resetHome() {
  clearCountdown();
  elements.generateButton.disabled = false;
  setConnectionState("listo");
  setScreen("home");
}

function showError(title, message) {
  clearCountdown();
  elements.generateButton.disabled = false;
  elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  setConnectionState("alerta");
  setScreen("error");
}

function startTokenCountdown(token, expiresAt, message) {
  clearCountdown();

  const expiryTime = new Date(expiresAt).getTime();
  const total = Math.max(expiryTime - Date.now(), 1000);

  elements.tokenValue.textContent = token;
  elements.tokenInstruction.textContent =
    message || "Coloque este codigo en el comprobante.";
  elements.generateButton.disabled = false;
  setConnectionState("activo");
  setScreen("token");

  const tick = () => {
    const remaining = expiryTime - Date.now();

    if (remaining <= 0) {
      resetHome();
      return;
    }

    const seconds = Math.ceil(remaining / 1000);
    const ratio = Math.max(remaining / total, 0);
    elements.countdownText.textContent = `${seconds}s`;
    elements.countdownBar.style.transform = `scaleX(${ratio})`;
  };

  tick();
  countdownTimer = window.setInterval(tick, 250);
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return { message: await response.text() };
}

async function checkStatus() {
  try {
    const response = await fetch(`/check-status?kioskId=${encodeURIComponent(kioskId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      setConnectionState("listo");
      return;
    }

    if (payload?.active && payload?.token && payload?.expiresAt) {
      startTokenCountdown(payload.token, payload.expiresAt, payload.message);
      return;
    }

    setConnectionState("listo");
  } catch {
    setConnectionState("offline");
  }
}

async function generateToken() {
  elements.generateButton.disabled = true;
  setConnectionState("procesando");
  setScreen("loading");

  try {
    const response = await fetch("/generate-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ kioskId }),
    });

    const payload = await parseResponse(response);

    if (!response.ok) {
      const title =
        response.status === 429
          ? "Espere unos segundos"
          : "No fue posible generar el codigo";

      showError(
        title,
        payload?.message || "El servicio no pudo generar un token temporal."
      );
      return;
    }

    startTokenCountdown(payload.token, payload.expiresAt, payload.message);
  } catch {
    showError(
      "Servicio no disponible",
      "No hay comunicacion con el Worker o con la API en este momento."
    );
  }
}

elements.generateButton.addEventListener("click", generateToken);
elements.retryButton.addEventListener("click", generateToken);

updateClock();
window.setInterval(updateClock, 1000);
checkStatus();
