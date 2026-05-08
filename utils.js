const STORAGE_KEYS = {
  ACTIVE_BOOKING: "ACTIVE_BOOKING",
  BOOKING_CHECKPOINT: "BOOKING_CHECKPOINT",
  LOGIN_CREDS: "LOGIN_CREDS",
  AUTO_LOGIN: "AUTO_LOGIN",
  TATKAL_RUSH_CONFIG: "TATKAL_RUSH_CONFIG",
  PASSENGERS: "PASSENGERS",
  DEFAULT_PREFERENCES: "DEFAULT_PREFERENCES",
  BOOKING_HISTORY: "BOOKING_HISTORY",
  AVAILABILITY_ALERTS: "AVAILABILITY_ALERTS",
  GEMINI_API_KEY: "GEMINI_API_KEY"
};

function humanDelay(min = 100, max = 300) {
  const ms = Math.max(0, Math.floor(Math.random() * (max - min + 1)) + min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(str) {
  return String(str || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isVisible(el) {
  if (!el || el.nodeType !== 1) {
    return false;
  }
  if (!document.contains(el)) {
    return false;
  }
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
    return false;
  }
  if (el.hidden) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function clone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (error) {
    return null;
  }
}

function dispatchChangeEvents(element) {
  if (!element) {
    return;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function clearAndType(element, text) {
  if (!element) {
    return;
  }
  const value = String(text || "");
  element.focus();
  if (typeof element.select === "function") {
    element.select();
  }
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  if (setter) {
    setter.call(element, "");
  } else {
    element.value = "";
  }
  dispatchChangeEvents(element);
  for (const char of value) {
    const current = element.value + char;
    if (setter) {
      setter.call(element, current);
    } else {
      element.value = current;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: char, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await humanDelay(40, 110);
  }
}

async function safeSendRuntimeMessage(msg) {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      return null;
    }
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("safeSendRuntimeMessage error", chrome.runtime.lastError.message);
          return resolve(null);
        }
        resolve(response);
      });
    });
  } catch (error) {
    return null;
  }
}

function serializeDomForGemini(rootEl) {
  const root = rootEl || document.documentElement;
  const nodes = Array.from(root.querySelectorAll("input,button,select,textarea,label,a,div,span"))
    .slice(0, 120)
    .map((node) => ({
      tag: node.tagName.toLowerCase(),
      id: node.id || "",
      name: node.name || node.getAttribute("name") || "",
      type: node.type || "",
      text: normalizeText(node.textContent || node.innerText || ""),
      placeholder: node.getAttribute("placeholder") || "",
      ariaLabel: node.getAttribute("aria-label") || node.getAttribute("role") || "",
      className: node.className ? String(node.className).slice(0, 120) : ""
    }));
  return JSON.stringify(nodes);
}

async function findWithGeminiFallback(description, context) {
  const response = await safeSendRuntimeMessage({ type: "CALL_GEMINI", prompt: description, domContext: context });
  if (!response || typeof response.selector !== "string") {
    return null;
  }
  return response.selector;
}

function scoreTrainRecommendation(trainCard, config) {
  if (!trainCard) {
    return 0;
  }
  const text = normalizeText(trainCard.textContent || "");
  let score = 0;
  const availabilityMatch = text.match(/(\d+)\s*(?:seats?|available|avail)/i);
  const availableCount = availabilityMatch ? Number(availabilityMatch[1]) : 0;
  score += Math.min(availableCount, 50) * 4;
  const preferredClass = String(config?.journeyClass || "").trim().toUpperCase();
  if (preferredClass) {
    const classButton = Array.from(trainCard.querySelectorAll("button,span,a,div")).find((node) => normalizeText(node.textContent || "") === normalizeText(preferredClass));
    if (classButton && isVisible(classButton) && !classButton.disabled) {
      score += 120;
    }
  }
  const timeMatch = text.match(/(\d{1,2}:\d{2})/);
  if (timeMatch) {
    const [hour, minute] = timeMatch[1].split(":").map(Number);
    if (!Number.isNaN(hour) && !Number.isNaN(minute)) {
      const minutes = hour * 60 + minute;
      const preferredMinutes = 10 * 60;
      score += Math.max(0, 120 - Math.abs(minutes - preferredMinutes));
    }
  }
  if (text.includes("train")) {
    score += 20;
  }
  return score;
}

async function withRetry(asyncFn, stepName, maxRetries = 3) {
  let attempt = 0;
  let lastError = null;
  while (attempt < maxRetries) {
    try {
      return await asyncFn();
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= maxRetries) {
        showContentToast(`Permanent failure: ${stepName}. ${error?.message || error}`, "error", true, 0);
        if (window.contentState && typeof window.contentState === "object") {
          window.contentState.activeConfig = null;
        }
        throw error;
      }
      const backoff = attempt === 1 ? 2000 : attempt === 2 ? 5000 : 12000;
      await humanDelay(backoff, backoff + 400);
    }
  }
  throw lastError;
}

function showContentToast(message, type = "info", dismissable = false, duration = 8000) {
  try {
    let toast = document.getElementById("irctc-autofill-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "irctc-autofill-toast";
      toast.style.cssText = "position:fixed;bottom:20px;right:20px;max-width:320px;padding:14px 16px;border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.22);font:13px/1.4 sans-serif;z-index:99999999;";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.background = type === "error" ? "#D32F2F" : type === "success" ? "#2E7D32" : type === "warning" ? "#F9A825" : "#1976D2";
    toast.style.color = "#fff";
    toast.style.opacity = "1";
    toast.style.cursor = dismissable ? "pointer" : "default";
    if (dismissable) {
      toast.onclick = () => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 250);
      };
    } else {
      toast.onclick = null;
    }
    if (!dismissable) {
      clearTimeout(showContentToast._timer);
      showContentToast._timer = setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 250);
      }, duration);
    }
  } catch (error) {
    console.warn("showContentToast failed", error);
  }
}

async function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (items) => resolve(items || {}));
  });
}

async function setStorage(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => resolve());
  });
}

async function removeStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

window.IRCTCUtils = {
  STORAGE_KEYS,
  humanDelay,
  clearAndType,
  findWithGeminiFallback,
  normalizeText,
  serializeDomForGemini,
  isVisible,
  escapeHtml,
  safeSendRuntimeMessage,
  clone,
  scoreTrainRecommendation,
  withRetry,
  showContentToast,
  getStorage,
  setStorage,
  removeStorage
};
