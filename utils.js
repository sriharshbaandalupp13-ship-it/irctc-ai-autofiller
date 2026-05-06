(function () {
  const STORAGE_KEYS = {
    PASSENGERS: "passengers",
    GROUPS: "groups",
    SAVED_STATIONS: "savedStations",
    DEFAULT_PREFERENCES: "defaultPreferences",
    BOOKING_HISTORY: "bookingHistory",
    GEMINI_API_KEY: "geminiApiKey",
    TATKAL_RUSH_CONFIG: "tatkalRushConfig",
    AVAILABILITY_ALERTS: "availabilityAlerts",
    JOURNEY_DRAFT: "journeyDraft",
    ACTIVE_BOOKING: "activeBooking",
    RUNTIME_STATUS: "runtimeStatus",
    LATEST_RECOMMENDATION: "latestRecommendation",
    PENDING_AVAILABILITY_REQUEST: "pendingAvailabilityRequest",
    SIDEBAR_STATE: "sidebarState"
  };

  const DEFAULT_PREFERENCES = {
    travelInsurance: true,
    autoUpgrade: false,
    onlyConfirmBerths: false,
    paymentMode: "BHIM UPI",
    preferredCoach: "",
    reservationChoice: "",
    fallbackMobile: ""
  };

  const QUOTAS = [
    "General",
    "Tatkal",
    "Ladies",
    "Senior Citizen",
    "Premium Tatkal"
  ];

  const JOURNEY_CLASSES = ["SL", "3A", "2A", "1A", "All Classes"];

  const PAYMENT_MODES = ["BHIM UPI", "Credit & Debit Card", "Net Banking"];

  const BERTH_PREFERENCES = [
    "Lower",
    "Middle",
    "Upper",
    "Side Lower",
    "Side Upper",
    "No Preference"
  ];

  const GENDERS = ["Male", "Female", "Transgender"];

  const ID_PROOF_TYPES = [
    "Aadhaar",
    "PAN",
    "Passport",
    "Driving License",
    "Voter ID"
  ];

  const NATIONALITY_DEFAULT = "India";

  const IRCTC_URLS = {
    SEARCH: "https://www.irctc.co.in/nget/train-search",
    TRAIN_LIST: "https://www.irctc.co.in/nget/train-list",
    PAX_DETAILS: "https://www.irctc.co.in/nget/booking/pax-details",
    PAYMENT: "https://www.irctc.co.in/nget/booking/payment"
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function titleCase(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function todayISO() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function humanDelay(min = 100, max = 300) {
    await sleep(randomBetween(min, max));
  }

  function dispatchAllEvents(element) {
    if (!element) {
      return;
    }
    ["input", "change", "blur"].forEach((eventName) => {
      element.dispatchEvent(new Event(eventName, { bubbles: true }));
    });
  }

  async function clearAndType(element, value, options = {}) {
    if (!element) {
      return;
    }
    const text = String(value ?? "");
    const {
      minDelay = 35,
      maxDelay = 75,
      skipClick = false,
      skipSelect = false
    } = options;

    if (!skipClick && typeof element.click === "function") {
      element.click();
    }
    element.focus();

    if (!skipSelect && typeof element.select === "function") {
      element.select();
    }

    element.value = "";
    dispatchAllEvents(element);

    for (const char of text) {
      element.value += char;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: char, inputType: "insertText" }));
      await sleep(randomBetween(minDelay, maxDelay));
    }

    dispatchAllEvents(element);
  }

  function getChromeStorage() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return chrome.storage.local;
    }
    throw new Error("chrome.storage.local is unavailable");
  }

  async function getStorage(keys) {
    return getChromeStorage().get(keys);
  }

  async function setStorage(values) {
    return getChromeStorage().set(values);
  }

  async function removeStorage(keys) {
    return getChromeStorage().remove(keys);
  }

  async function getDataBundle() {
    const data = await getStorage([
      STORAGE_KEYS.PASSENGERS,
      STORAGE_KEYS.GROUPS,
      STORAGE_KEYS.SAVED_STATIONS,
      STORAGE_KEYS.DEFAULT_PREFERENCES,
      STORAGE_KEYS.BOOKING_HISTORY,
      STORAGE_KEYS.GEMINI_API_KEY,
      STORAGE_KEYS.TATKAL_RUSH_CONFIG,
      STORAGE_KEYS.AVAILABILITY_ALERTS,
      STORAGE_KEYS.JOURNEY_DRAFT,
      STORAGE_KEYS.ACTIVE_BOOKING,
      STORAGE_KEYS.RUNTIME_STATUS,
      STORAGE_KEYS.LATEST_RECOMMENDATION
    ]);

    return {
      passengers: Array.isArray(data[STORAGE_KEYS.PASSENGERS]) ? data[STORAGE_KEYS.PASSENGERS] : [],
      groups: Array.isArray(data[STORAGE_KEYS.GROUPS]) ? data[STORAGE_KEYS.GROUPS] : [],
      savedStations: Array.isArray(data[STORAGE_KEYS.SAVED_STATIONS]) ? data[STORAGE_KEYS.SAVED_STATIONS] : [],
      defaultPreferences: {
        ...clone(DEFAULT_PREFERENCES),
        ...(data[STORAGE_KEYS.DEFAULT_PREFERENCES] || {})
      },
      bookingHistory: Array.isArray(data[STORAGE_KEYS.BOOKING_HISTORY]) ? data[STORAGE_KEYS.BOOKING_HISTORY] : [],
      geminiApiKey: data[STORAGE_KEYS.GEMINI_API_KEY] || "",
      tatkalRushConfig: data[STORAGE_KEYS.TATKAL_RUSH_CONFIG] || null,
      availabilityAlerts: Array.isArray(data[STORAGE_KEYS.AVAILABILITY_ALERTS]) ? data[STORAGE_KEYS.AVAILABILITY_ALERTS] : [],
      journeyDraft: data[STORAGE_KEYS.JOURNEY_DRAFT] || null,
      activeBooking: data[STORAGE_KEYS.ACTIVE_BOOKING] || null,
      runtimeStatus: data[STORAGE_KEYS.RUNTIME_STATUS] || null,
      latestRecommendation: data[STORAGE_KEYS.LATEST_RECOMMENDATION] || null
    };
  }

  function generateId(prefix = "id") {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function buildJourneyConfig(raw = {}) {
    const preferences = {
      ...clone(DEFAULT_PREFERENCES),
      ...(raw.preferences || {})
    };

    const passengers = Array.isArray(raw.selectedPassengers) ? raw.selectedPassengers : [];

    return {
      id: raw.id || generateId("journey"),
      fromStation: raw.fromStation || "",
      toStation: raw.toStation || "",
      journeyDate: raw.journeyDate || todayISO(),
      journeyClass: raw.journeyClass || "3A",
      quota: raw.quota || "General",
      passengerCount: Math.max(1, Math.min(6, Number(raw.passengerCount) || passengers.length || 1)),
      selectedPassengerIds: Array.isArray(raw.selectedPassengerIds) ? raw.selectedPassengerIds : passengers.map((passenger) => passenger.id),
      selectedPassengers: passengers.slice(0, 6),
      preferences,
      tatkalRushMode: Boolean(raw.tatkalRushMode),
      metadata: raw.metadata || {},
      createdAt: raw.createdAt || new Date().toISOString()
    };
  }

  function computeTatkalTime(config) {
    const journeyClass = normalizeText(config?.journeyClass);
    const isSleeper = journeyClass === "sl" || journeyClass === "sleeper";
    const openingHour = isSleeper ? 11 : 10;
    const reminderHour = isSleeper ? 10 : 9;
    const reminderMinute = 55;

    const now = new Date();
    const startAt = new Date(now);
    startAt.setHours(openingHour, 0, 0, 0);

    const reminderAt = new Date(now);
    reminderAt.setHours(reminderHour, reminderMinute, 0, 0);

    if (startAt <= now) {
      startAt.setDate(startAt.getDate() + 1);
    }
    if (reminderAt <= now) {
      reminderAt.setDate(reminderAt.getDate() + 1);
    }

    return {
      startAt,
      reminderAt,
      slotLabel: isSleeper ? "11:00:00 AM" : "10:00:00 AM"
    };
  }

  function summarizeConfig(config) {
    if (!config) {
      return "No active journey";
    }
    const passengerNames = (config.selectedPassengers || []).map((passenger) => passenger.fullName).join(", ");
    return `${config.fromStation} -> ${config.toStation} | ${config.journeyDate} | ${config.journeyClass} | ${passengerNames || `${config.passengerCount} passenger(s)`}`;
  }

  function upsertSavedStations(existing = [], values = []) {
    const merged = new Map();
    [...existing, ...values]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .forEach((value) => {
        merged.set(normalizeText(value), value);
      });
    return Array.from(merged.values()).slice(0, 100);
  }

  function createStatusStep(label, state = "pending", detail = "") {
    return {
      id: generateId("step"),
      label,
      state,
      detail,
      timestamp: new Date().toISOString()
    };
  }

  function formatTimestamp(value) {
    try {
      return new Date(value).toLocaleString();
    } catch (error) {
      return String(value || "");
    }
  }

  function serializeDomForGemini(root = document) {
    const nodes = Array.from(root.querySelectorAll("input, button, select, textarea, label, [role='button'], [role='option'], [aria-label], [placeholder]"))
      .slice(0, 160)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        id: node.id || "",
        name: node.getAttribute("name") || "",
        type: node.getAttribute("type") || "",
        text: (node.textContent || "").trim().slice(0, 80),
        placeholder: node.getAttribute("placeholder") || "",
        ariaLabel: node.getAttribute("aria-label") || "",
        className: (node.className || "").toString().slice(0, 120)
      }));
    return JSON.stringify(nodes, null, 2);
  }

  async function callGeminiSelector({ apiKey, purpose, domSummary, url, selectorHints = [] }) {
    if (!apiKey) {
      throw new Error("Gemini API key is missing");
    }

    const prompt = [
      "You help a Chrome extension recover a CSS selector on a live webpage.",
      `Goal: ${purpose}`,
      `URL: ${url}`,
      selectorHints.length ? `Known selector hints: ${selectorHints.join(", ")}` : "No selector hints available.",
      "Return strict JSON only in the form: {\"selector\":\"...\",\"reason\":\"...\"}.",
      "Choose a CSS selector likely to uniquely match the correct interactive element.",
      "DOM summary:",
      domSummary
    ].join("\n");

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed with ${response.status}`);
    }

    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  }

  function scoreTrainRecommendation(trains = [], preferredClass = "3A") {
    const normalizedClass = normalizeText(preferredClass);
    let best = null;

    trains.forEach((train) => {
      const availabilityText = normalizeText(train.availability?.[preferredClass] || train.availability?.[preferredClass.toUpperCase()] || "");
      const departure = train.departure || "";
      const departureHour = /^\d{2}:\d{2}$/.test(departure) ? Number(departure.split(":")[0]) : 12;
      let score = 0;

      if (/available|avl/.test(availabilityText)) {
        score += 50;
      }
      if (/wl|regret|not available/.test(availabilityText)) {
        score -= 40;
      }
      score += Math.max(0, 20 - Math.abs(8 - departureHour));
      if (normalizedClass && normalizeText(Object.keys(train.availability || {}).join(" ")).includes(normalizedClass)) {
        score += 12;
      }
      if ((train.trainName || "").toLowerCase().includes("rajdhani") || (train.trainName || "").toLowerCase().includes("vande")) {
        score += 5;
      }

      if (!best || score > best.score) {
        best = {
          score,
          train
        };
      }
    });

    return best;
  }

  globalThis.IRCTCUtils = {
    STORAGE_KEYS,
    DEFAULT_PREFERENCES,
    QUOTAS,
    JOURNEY_CLASSES,
    PAYMENT_MODES,
    BERTH_PREFERENCES,
    GENDERS,
    ID_PROOF_TYPES,
    NATIONALITY_DEFAULT,
    IRCTC_URLS,
    normalizeText,
    titleCase,
    todayISO,
    randomBetween,
    sleep,
    humanDelay,
    clearAndType,
    dispatchAllEvents,
    getStorage,
    setStorage,
    removeStorage,
    getDataBundle,
    generateId,
    buildJourneyConfig,
    computeTatkalTime,
    summarizeConfig,
    upsertSavedStations,
    createStatusStep,
    formatTimestamp,
    serializeDomForGemini,
    callGeminiSelector,
    scoreTrainRecommendation,
    clone
  };
})();
