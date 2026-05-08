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
  GEMINI_API_KEY: "GEMINI_API_KEY",
  PRE_POSITION_ONLY: "PRE_POSITION_ONLY"
};

const ALARM_NAMES = {
  TATKAL_START: "TATKAL_START",
  TATKAL_REMINDER: "TATKAL_REMINDER",
  TATKAL_PRE_POSITION: "TATKAL_PRE_POSITION"
};

const NOTIFICATION_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAeElEQVR4AWNgsP///z4DAwMDAyNDQxmBsbGxkYGhgYGBgYGBgkFJYWBkirhJQwMjAwMDAwMDAwMLKwsLCwsDA0NDRwBWQc8gf8I0gQ5jEJGEWDhEow6MgAAghUzTHGASo0GgAAKQ0Qe3hTQHYAAAAASUVORK5CYII=";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("IRCTC_HEALTH_POLL", { periodInMinutes: 30 });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then((result) => sendResponse({ ok: true, ...result })).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === ALARM_NAMES.TATKAL_REMINDER) {
      await sendNotification("Tatkal opens in 5 minutes. Get ready.");
      return;
    }
    if (alarm.name === ALARM_NAMES.TATKAL_PRE_POSITION) {
      await chrome.storage.local.set({ [STORAGE_KEYS.PRE_POSITION_ONLY]: true });
      await openIrctcTab();
      return;
    }
    if (alarm.name === ALARM_NAMES.TATKAL_START) {
      await sendNotification("Tatkal is open NOW.");
      await chrome.storage.local.set({ [STORAGE_KEYS.PRE_POSITION_ONLY]: false });
      return;
    }
  } catch (error) {
    console.error("Alarm handling failed", error);
  }
});

async function handleMessage(message) {
  if (!message || !message.type) {
    return {};
  }
  switch (message.type) {
    case "CALL_GEMINI":
      return await callGemini(message.prompt, message.domContext);
    case "SET_TATKAL_ALARM":
      await setTatkalAlarm(message.payload);
      return {};
    case "CLEAR_TATKAL_ALARM":
      await clearTatkalAlarm();
      return {};
    case "SERVER_DOWN_NOTIFY":
      await sendNotification("IRCTC appears to be down. Will retry automatically.");
      return {};
    case "SERVER_BACK_NOTIFY":
      await sendNotification("IRCTC is back. Resuming your booking.");
      return {};
    default:
      return {};
  }
}

async function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

async function setStorage(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => resolve());
  });
}

function sendNotification(message) {
  return new Promise((resolve) => {
    chrome.notifications.create({
      type: "basic",
      iconUrl: NOTIFICATION_ICON,
      title: "IRCTC AutoFill Assistant",
      message
    }, () => resolve());
  });
}

async function openIrctcTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.irctc.co.in/*" });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { url: "https://www.irctc.co.in", active: true });
    return tabs[0].id;
  }
  const created = await chrome.tabs.create({ url: "https://www.irctc.co.in", active: true });
  return created.id;
}

function parseGeminiSelector(text) {
  if (!text) {
    return "";
  }
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.selector) {
        return parsed.selector;
      }
    }
  } catch (error) {
    // ignore malformed parse
  }
  const selectorMatch = text.match(/([.#]?[a-zA-Z0-9_-]+[\w\s>\.:\[\]=\"'_-]*)/);
  return selectorMatch ? selectorMatch[0].trim() : "";
}

async function callGemini(prompt, domContext) {
  const storage = await getStorage([STORAGE_KEYS.GEMINI_API_KEY]);
  const apiKey = String(storage[STORAGE_KEYS.GEMINI_API_KEY] || "").trim();
  if (!apiKey) {
    throw new Error("Gemini API key is not configured.");
  }
  const requestBody = {
    prompt: { text: `${prompt}\nDOM CONTEXT:\n${domContext}` },
    temperature: 0.2,
    candidateCount: 1
  };
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.0:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody)
  });
  if (!response.ok) {
    throw new Error(`Gemini API returned ${response.status}`);
  }
  const payload = await response.json();
  const text = String(payload?.candidates?.[0]?.content?.[0]?.text || payload?.candidates?.[0]?.content || "");
  return { selector: parseGeminiSelector(text) };
}

async function setTatkalAlarm(payload) {
  const journeyConfig = payload?.journeyConfig || {};
  const classType = payload?.tatkalClassType || "ac";
  const now = new Date();
  const startHour = classType === "sleeper" ? 11 : 10;
  const reminderHour = startHour - 1;
  const startAt = new Date(now);
  startAt.setHours(startHour, 0, 0, 0);
  const reminderAt = new Date(now);
  reminderAt.setHours(reminderHour, 55, 0, 0);
  const prePositionAt = new Date(startAt.getTime() - 15 * 60 * 1000);
  if (startAt <= now) {
    startAt.setDate(startAt.getDate() + 1);
  }
  if (reminderAt <= now) {
    reminderAt.setDate(reminderAt.getDate() + 1);
  }
  if (prePositionAt <= now) {
    prePositionAt.setDate(prePositionAt.getDate() + 1);
  }
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_START);
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_REMINDER);
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_PRE_POSITION);
  chrome.alarms.create(ALARM_NAMES.TATKAL_START, { when: startAt.getTime() });
  chrome.alarms.create(ALARM_NAMES.TATKAL_REMINDER, { when: reminderAt.getTime() });
  chrome.alarms.create(ALARM_NAMES.TATKAL_PRE_POSITION, { when: prePositionAt.getTime() });
  await setStorage({
    [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: {
      enabled: true,
      tatkalClassType: classType,
      startAt: startAt.toISOString(),
      reminderAt: reminderAt.toISOString(),
      prePositionAt: prePositionAt.toISOString(),
      journeyConfig
    }
  });
}

async function clearTatkalAlarm() {
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_START);
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_REMINDER);
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_PRE_POSITION);
  await setStorage({
    [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: null,
    [STORAGE_KEYS.PRE_POSITION_ONLY]: false
  });
}
