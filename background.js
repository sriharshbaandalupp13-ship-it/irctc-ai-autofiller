try {
  importScripts("local-config.js");
} catch (error) {
  /* Local-only config is optional. */
}

importScripts("utils.js");

/* global IRCTCUtils, STORAGE_KEYS, IRCTC_URLS, chrome */

/* Functions extracted from IRCTCUtils — constants STORAGE_KEYS/IRCTC_URLS are already global from utils.js */
const {
  getStorage,
  setStorage,
  getDataBundle,
  buildJourneyConfig,
  computeTatkalTime,
  createStatusStep,
  formatTimestamp
} = IRCTCUtils;

const ALARM_NAMES = {
  TATKAL_START: "tatkal-start",
  TATKAL_REMINDER: "tatkal-reminder",
  TATKAL_PRE_POSITION: "tatkal-pre-position",
  TATKAL_START_SLEEPER: "tatkal-start-sleeper",
  TATKAL_REMINDER_SLEEPER: "tatkal-reminder-sleeper",
  TATKAL_PRE_POSITION_SLEEPER: "tatkal-pre-position-sleeper",
  AVAILABILITY_POLL: "availability-alert-poll"
};

initializeLocalSecrets();

const memoryState = {
  pendingPopupPort: null,
  inflightAvailabilityTabs: new Map()
};

chrome.runtime.onInstalled.addListener(async () => {
  await initializeLocalSecrets();
  await seedStorageDefaults();
  await chrome.alarms.create(ALARM_NAMES.AVAILABILITY_POLL, { periodInMinutes: 30 });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup-channel") {
    memoryState.pendingPopupPort = port;
    port.onDisconnect.addListener(() => {
      if (memoryState.pendingPopupPort === port) {
        memoryState.pendingPopupPort = null;
      }
    });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) {
    return;
  }

  if (isSearchPage(tab.url) || isTrainListPage(tab.url) || isPaxDetailsPage(tab.url) || isPaymentPage(tab.url)) {
    await safeSendToTab(tabId, {
      type: "BACKGROUND_PAGE_READY",
      url: tab.url
    });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const tatkalAlarm = getTatkalAlarmContext(alarm.name);

  if (tatkalAlarm?.phase === "reminder") {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXlUQAAAAASUVORK5CYII=",
      title: "IRCTC AutoFill Assistant",
      message: "Tatkal opens in 5 minutes — get ready."
    });
    return;
  }

  if (tatkalAlarm?.phase === "pre") {
    const { [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: tatkalRushConfig } = await getStorage([STORAGE_KEYS.TATKAL_RUSH_CONFIG]);
    if (!tatkalRushConfig?.enabled || !tatkalRushConfig?.journeyConfig) {
      return;
    }

    const journeyConfig = buildTatkalJourneyConfig(tatkalRushConfig.journeyConfig, tatkalAlarm.slotType, {
      mode: "pre-position",
      tatkalPrePositioned: true
    });

    const tabId = await openOrNavigateToIrctcTab(IRCTC_URLS.SEARCH);
    if (!tabId) {
      return;
    }

    await setStorage({
      [STORAGE_KEYS.ACTIVE_BOOKING]: {
        mode: "tatkalPrePosition",
        journeyConfig,
        sourceTabId: tabId,
        triggeredBy: "tatkal-pre-position",
        lastUpdatedAt: new Date().toISOString()
      }
    });

    await safeSendToTab(tabId, {
      type: "TATKAL_PRE_FILL_SEARCH",
      journeyConfig
    });
    return;
  }

  if (tatkalAlarm?.phase === "start") {
    const { [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: tatkalRushConfig } = await getStorage([STORAGE_KEYS.TATKAL_RUSH_CONFIG]);
    if (!tatkalRushConfig?.enabled || !tatkalRushConfig?.journeyConfig) {
      return;
    }

    await chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXlUQAAAAASUVORK5CYII=",
      title: "IRCTC AutoFill Assistant",
      message: "Tatkal booking starting now!"
    });

    const tabId = await openOrNavigateToIrctcTab(IRCTC_URLS.SEARCH);
    if (!tabId) {
      return;
    }

    const journeyConfig = buildTatkalJourneyConfig(tatkalRushConfig.journeyConfig, tatkalAlarm.slotType, {
      mode: "booking",
      tatkalPrePositioned: true,
      tatkalTriggeredAt: new Date().toISOString()
    });

    await setStorage({
      [STORAGE_KEYS.ACTIVE_BOOKING]: {
        mode: "booking",
        journeyConfig,
        sourceTabId: tabId,
        triggeredBy: "tatkal-alarm",
        lastUpdatedAt: new Date().toISOString()
      }
    });

    await safeSendToTab(tabId, {
      type: "START_PAGE_AUTOMATION",
      journeyConfig
    });
    return;
  }

  if (alarm.name === ALARM_NAMES.AVAILABILITY_POLL) {
    const data = await getDataBundle();
    const activeAlerts = data.availabilityAlerts.filter((alert) => alert.enabled);
    for (const alert of activeAlerts) {
      await runAvailabilityCheck(alert, { silent: true, alertId: alert.id });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_EXTENSION_STATE":
      return getPopupState();
    case "SAVE_JOURNEY_DRAFT":
      return saveJourneyDraft(message.payload);
    case "START_BOOKING_FLOW":
      return startBookingFlow(message.payload, sender);
    case "UPDATE_STATUS":
      return updateRuntimeStatus(message.payload);
    case "SHOW_NOTIFICATION":
      return showNotification(message.payload);
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return {};
    case "SAVE_RECOMMENDATION":
      await setStorage({
        [STORAGE_KEYS.LATEST_RECOMMENDATION]: {
          ...message.payload,
          updatedAt: new Date().toISOString()
        }
      });
      return {};
    case "RUN_AVAILABILITY_CHECK":
      return runAvailabilityCheck(message.payload, { silent: false });
    case "AVAILABILITY_RESULTS":
      return handleAvailabilityResults(message.payload, sender);
    case "SAVE_AVAILABILITY_ALERT":
      return saveAvailabilityAlert(message.payload);
    case "DELETE_AVAILABILITY_ALERT":
      return deleteAvailabilityAlert(message.payload?.id);
    case "SAVE_QUICK_WIDGET_SETTINGS":
      return saveQuickWidgetSettings(message.payload);
    case "SET_TATKAL_ALARM":
      return setTatkalAlarm(message.payload);
    case "CLEAR_TATKAL_ALARM":
      return clearTatkalAlarm();
    case "GEMINI_SELECTOR_QUERY":
      return runGeminiSelectorQuery(message.payload);
    case "PAGE_READY":
      return handlePageReady(message.payload, sender);
    case "SERVER_DOWN_NOTIFY":
      return showNotification({
        title: "🔴 IRCTC Down",
        message: "IRCTC is down. Extension is monitoring and will alert you when it's back."
      });
    case "SERVER_BACK_NOTIFY":
      return showNotification({
        title: "✅ IRCTC is back",
        message: "IRCTC is back online — resuming booking now."
      });
    case "BOOKING_COMPLETED":
      return finalizeBooking(message.payload);
    case "GET_ACTIVE_BOOKING":
      return getActiveBooking();
    case "CLEAR_ACTIVE_BOOKING":
      await setStorage({ [STORAGE_KEYS.ACTIVE_BOOKING]: null });
      return {};
    case "GET_RECOMMENDATION":
      return getRecommendation();
    default:
      return {};
  }
}

async function initializeLocalSecrets() {
  const localGeminiKey = globalThis.IRCTCLocalConfig?.geminiApiKey?.trim();
  if (!localGeminiKey) {
    return;
  }

  const existing = await getStorage([STORAGE_KEYS.GEMINI_API_KEY]);
  if (existing[STORAGE_KEYS.GEMINI_API_KEY]) {
    return;
  }

  await setStorage({
    [STORAGE_KEYS.GEMINI_API_KEY]: localGeminiKey
  });
}

async function getPopupState() {
  const data = await getDataBundle();
  return {
    passengers: data.passengers,
    groups: data.groups,
    savedStations: data.savedStations,
    defaultPreferences: data.defaultPreferences,
    bookingHistory: data.bookingHistory.slice(0, 10),
    journeyDraft: data.journeyDraft,
    runtimeStatus: data.runtimeStatus,
    tatkalRushConfig: data.tatkalRushConfig,
    availabilityAlerts: data.availabilityAlerts,
    latestRecommendation: data.latestRecommendation,
    quickWidgetSettings: data.quickWidgetSettings
  };
}

async function saveJourneyDraft(payload) {
  const data = await getDataBundle();
  const journeyConfig = buildJourneyConfig({
    ...payload,
    selectedPassengers: data.passengers.filter((passenger) => (payload.selectedPassengerIds || []).includes(passenger.id)),
    preferences: {
      ...data.defaultPreferences,
      ...(payload.preferences || {})
    }
  });

  const savedStations = IRCTCUtils.upsertSavedStations(data.savedStations, [journeyConfig.fromStation, journeyConfig.toStation]);
  const write = {
    [STORAGE_KEYS.JOURNEY_DRAFT]: journeyConfig,
    [STORAGE_KEYS.SAVED_STATIONS]: savedStations
  };

  if (journeyConfig.tatkalRushMode) {
    const tatkalClassType = journeyConfig.tatkalClassType || payload?.tatkalClassType || inferTatkalClassType(journeyConfig);
    const schedule = computeTatkalTime(getTatkalScheduleJourney(journeyConfig, tatkalClassType === "both" ? "ac" : tatkalClassType));
    const tatkalRushConfig = {
      enabled: true,
      tatkalClassType,
      slotLabel: tatkalClassType === "both" ? "10:00:00 AM / 11:00:00 AM" : schedule.slotLabel,
      scheduledFor: schedule.startAt.toISOString(),
      reminderFor: schedule.reminderAt.toISOString(),
      journeyConfig
    };
    write[STORAGE_KEYS.TATKAL_RUSH_CONFIG] = tatkalRushConfig;
    await scheduleTatkalAlarms(tatkalRushConfig);
  } else {
    write[STORAGE_KEYS.TATKAL_RUSH_CONFIG] = null;
    await clearTatkalAlarm();
  }

  await setStorage(write);
  return { journeyDraft: journeyConfig, savedStations };
}

async function startBookingFlow(payload, sender) {
  const data = await getDataBundle();
  const sourceTabId = sender.tab?.id || payload?.tabId;
  const journeyConfig = buildJourneyConfig({
    ...payload,
    selectedPassengers: data.passengers.filter((passenger) => (payload.selectedPassengerIds || []).includes(passenger.id)),
    preferences: {
      ...data.defaultPreferences,
      ...(payload.preferences || {})
    }
  });

  await setStorage({
    [STORAGE_KEYS.BOOKING_CHECKPOINT]: null,
    [STORAGE_KEYS.ACTIVE_BOOKING]: {
      mode: "booking",
      journeyConfig,
      sourceTabId,
      triggeredBy: "popup",
      lastUpdatedAt: new Date().toISOString()
    },
    [STORAGE_KEYS.RUNTIME_STATUS]: {
      phase: "queued",
      message: "Booking flow queued",
      steps: [
        createStatusStep("Search page queued", "complete"),
        createStatusStep("Waiting for train search automation", "active")
      ],
      updatedAt: new Date().toISOString()
    }
  });

  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (currentTab?.id && currentTab.url?.startsWith("https://www.irctc.co.in/")) {
    await safeSendToTab(currentTab.id, {
      type: "START_PAGE_AUTOMATION",
      journeyConfig
    });
  } else if (currentTab?.id) {
    await chrome.tabs.update(currentTab.id, { url: IRCTC_URLS.SEARCH });
  } else {
    await chrome.tabs.create({ url: IRCTC_URLS.SEARCH, active: true });
  }

  return { journeyConfig };
}

async function updateRuntimeStatus(payload) {
  await setStorage({
    [STORAGE_KEYS.RUNTIME_STATUS]: {
      ...(payload || {}),
      updatedAt: new Date().toISOString()
    }
  });
  pushPopupEvent("status-updated", payload);
  return {};
}

async function showNotification(payload) {
  await chrome.notifications.create({
    type: "basic",
    iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXlUQAAAAASUVORK5CYII=",
    title: payload?.title || "IRCTC AutoFill Assistant",
    message: payload?.message || "Notification"
  });
  return {};
}

async function runAvailabilityCheck(payload, options = {}) {
  const config = {
    id: payload?.id || IRCTCUtils.generateId("availability"),
    fromStation: payload?.fromStation || "",
    toStation: payload?.toStation || "",
    journeyDate: payload?.journeyDate || IRCTCUtils.todayISO(),
    journeyClass: payload?.journeyClass || "3A",
    quota: payload?.quota || "General",
    silent: Boolean(options.silent),
    alertId: options.alertId || null
  };

  const createdTab = await chrome.tabs.create({
    url: IRCTC_URLS.SEARCH,
    active: !options.silent
  });

  memoryState.inflightAvailabilityTabs.set(createdTab.id, {
    requestId: config.id,
    config
  });

  await setStorage({
    [STORAGE_KEYS.PENDING_AVAILABILITY_REQUEST]: {
      ...config,
      tabId: createdTab.id,
      createdAt: new Date().toISOString()
    },
    [STORAGE_KEYS.ACTIVE_BOOKING]: {
      mode: "availabilityCheck",
      journeyConfig: config,
      sourceTabId: createdTab.id,
      triggeredBy: options.silent ? "availability-alert" : "popup",
      lastUpdatedAt: new Date().toISOString()
    }
  });

  return {
    requestId: config.id,
    tabId: createdTab.id
  };
}

async function handleAvailabilityResults(payload, sender) {
  const tabId = sender.tab?.id || payload?.tabId;
  if (tabId && memoryState.inflightAvailabilityTabs.has(tabId)) {
    memoryState.inflightAvailabilityTabs.delete(tabId);
  }

  const { [STORAGE_KEYS.AVAILABILITY_ALERTS]: alerts = [] } = await getStorage([STORAGE_KEYS.AVAILABILITY_ALERTS]);
  if (payload?.alertId) {
    const matchingAlert = alerts.find((alert) => alert.id === payload.alertId);
    const hasSeats = Object.values(payload.results || {}).some((value) => /available|avl|rac/i.test(String(value || "")));
    if (matchingAlert && hasSeats) {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXlUQAAAAASUVORK5CYII=",
        title: "IRCTC Availability Alert",
        message: `${matchingAlert.fromStation} -> ${matchingAlert.toStation} on ${matchingAlert.journeyDate}: seats appear available.`
      });
    }
  }

  pushPopupEvent("availability-result", payload);

  if (tabId) {
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
  await setStorage({
    [STORAGE_KEYS.PENDING_AVAILABILITY_REQUEST]: null,
    [STORAGE_KEYS.ACTIVE_BOOKING]: null
  });
  return {};
}

async function saveAvailabilityAlert(payload) {
  const data = await getDataBundle();
  const nextAlerts = [...data.availabilityAlerts];
  const alert = {
    id: payload?.id || IRCTCUtils.generateId("alert"),
    fromStation: payload?.fromStation || "",
    toStation: payload?.toStation || "",
    journeyDate: payload?.journeyDate || IRCTCUtils.todayISO(),
    journeyClass: payload?.journeyClass || "3A",
    quota: payload?.quota || "General",
    enabled: payload?.enabled !== false,
    createdAt: payload?.createdAt || new Date().toISOString()
  };

  const index = nextAlerts.findIndex((item) => item.id === alert.id);
  if (index >= 0) {
    nextAlerts[index] = alert;
  } else {
    nextAlerts.unshift(alert);
  }

  await setStorage({ [STORAGE_KEYS.AVAILABILITY_ALERTS]: nextAlerts.slice(0, 20) });
  return { availabilityAlerts: nextAlerts.slice(0, 20) };
}

async function deleteAvailabilityAlert(id) {
  const data = await getDataBundle();
  const nextAlerts = data.availabilityAlerts.filter((alert) => alert.id !== id);
  await setStorage({ [STORAGE_KEYS.AVAILABILITY_ALERTS]: nextAlerts });
  return { availabilityAlerts: nextAlerts };
}

async function saveQuickWidgetSettings(payload) {
  const data = await getDataBundle();
  const nextSettings = {
    ...data.quickWidgetSettings,
    ...(payload || {})
  };

  const savedStations = IRCTCUtils.upsertSavedStations(data.savedStations, [
    nextSettings.favoriteFromStation,
    nextSettings.favoriteToStation
  ]);

  await setStorage({
    [STORAGE_KEYS.QUICK_WIDGET_SETTINGS]: nextSettings,
    [STORAGE_KEYS.SAVED_STATIONS]: savedStations
  });

  return {
    quickWidgetSettings: nextSettings,
    savedStations
  };
}

async function handlePageReady(payload, sender) {
  const data = await getDataBundle();
  const activeBooking = data.activeBooking;

  if (!sender.tab?.id || !payload?.url || !activeBooking) {
    return {};
  }

  const tabId = sender.tab.id;
  const journeyConfig = activeBooking.journeyConfig;

  if (isSearchPage(payload.url) && activeBooking.mode === "tatkalPrePosition") {
    await safeSendToTab(tabId, {
      type: "TATKAL_PRE_FILL_SEARCH",
      journeyConfig
    });
  }

  if (isSearchPage(payload.url) && (activeBooking.mode === "booking" || activeBooking.mode === "availabilityCheck")) {
    await safeSendToTab(tabId, {
      type: activeBooking.mode === "availabilityCheck" ? "RUN_AVAILABILITY_PAGE1" : "START_PAGE_AUTOMATION",
      journeyConfig
    });
  }

  if (isPaxDetailsPage(payload.url) && activeBooking.mode === "booking") {
    await safeSendToTab(tabId, {
      type: "RUN_PAX_AUTOMATION",
      journeyConfig
    });
  }

  if (isTrainListPage(payload.url)) {
    await safeSendToTab(tabId, {
      type: activeBooking.mode === "availabilityCheck" ? "SCRAPE_AVAILABILITY_RESULTS" : "SHOW_READY_BADGE",
      journeyConfig
    });
  }

  if (isPaymentPage(payload.url)) {
    await safeSendToTab(tabId, {
      type: "SHOW_PAYMENT_TOAST",
      journeyConfig
    });
  }

  return {};
}

async function finalizeBooking(payload) {
  const data = await getDataBundle();
  const activeBooking = data.activeBooking;
  const journeyConfig = activeBooking?.journeyConfig || data.journeyDraft;
  if (!journeyConfig) {
    return {};
  }

  const historyEntry = {
    id: IRCTCUtils.generateId("history"),
    fromStation: journeyConfig.fromStation,
    toStation: journeyConfig.toStation,
    journeyDate: journeyConfig.journeyDate,
    trainName: payload?.trainName || journeyConfig.metadata?.selectedTrainName || "Selected on IRCTC",
    journeyClass: journeyConfig.journeyClass,
    passengers: (journeyConfig.selectedPassengers || []).map((passenger) => passenger.fullName),
    timestamp: new Date().toISOString(),
    journeyConfig
  };

  const latestEntry = data.bookingHistory[0];
  const isDuplicateRecentEntry = latestEntry
    && latestEntry.fromStation === historyEntry.fromStation
    && latestEntry.toStation === historyEntry.toStation
    && latestEntry.journeyDate === historyEntry.journeyDate
    && latestEntry.journeyClass === historyEntry.journeyClass
    && latestEntry.trainName === historyEntry.trainName
    && JSON.stringify(latestEntry.passengers || []) === JSON.stringify(historyEntry.passengers || [])
    && Math.abs(new Date(latestEntry.timestamp).getTime() - new Date(historyEntry.timestamp).getTime()) < 10 * 60 * 1000;

  const nextHistory = isDuplicateRecentEntry
    ? data.bookingHistory.slice(0, 10)
    : [historyEntry, ...data.bookingHistory].slice(0, 10);
  await setStorage({
    [STORAGE_KEYS.BOOKING_HISTORY]: nextHistory,
    [STORAGE_KEYS.ACTIVE_BOOKING]: null,
    [STORAGE_KEYS.RUNTIME_STATUS]: {
      phase: "complete",
      message: `Reached payment page at ${formatTimestamp(historyEntry.timestamp)}`,
      steps: [
        createStatusStep("Search completed", "complete"),
        createStatusStep("Train selected manually", "complete"),
        createStatusStep("Passenger details autofilled", "complete"),
        createStatusStep("Handed off at payment page", "complete")
      ],
      updatedAt: new Date().toISOString()
    }
  });
  pushPopupEvent("history-updated", historyEntry);
  return { historyEntry };
}

async function getActiveBooking() {
  const { [STORAGE_KEYS.ACTIVE_BOOKING]: activeBooking } = await getStorage([STORAGE_KEYS.ACTIVE_BOOKING]);
  return { activeBooking };
}

async function getRecommendation() {
  const { [STORAGE_KEYS.LATEST_RECOMMENDATION]: latestRecommendation } = await getStorage([STORAGE_KEYS.LATEST_RECOMMENDATION]);
  return { latestRecommendation };
}

async function runGeminiSelectorQuery(payload) {
  const { [STORAGE_KEYS.GEMINI_API_KEY]: geminiApiKey } = await getStorage([STORAGE_KEYS.GEMINI_API_KEY]);
  if (!geminiApiKey) {
    return { selector: null };
  }

  const result = await IRCTCUtils.callGeminiSelector({
    apiKey: geminiApiKey,
    purpose: payload?.purpose || "Recover a selector",
    domSummary: payload?.domSummary || "",
    url: payload?.url || "",
    selectorHints: payload?.selectorHints || []
  });

  return {
    selector: result?.selector || null,
    reason: result?.reason || ""
  };
}

async function seedStorageDefaults() {
  const data = await getDataBundle();
  const write = {};

  if (!(await hasStoredValue(STORAGE_KEYS.DEFAULT_PREFERENCES))) {
    write[STORAGE_KEYS.DEFAULT_PREFERENCES] = data.defaultPreferences;
  }
  if (!(await hasStoredValue(STORAGE_KEYS.PASSENGERS))) {
    write[STORAGE_KEYS.PASSENGERS] = data.passengers;
  }
  if (!(await hasStoredValue(STORAGE_KEYS.GROUPS))) {
    write[STORAGE_KEYS.GROUPS] = data.groups;
  }
  if (!(await hasStoredValue(STORAGE_KEYS.SAVED_STATIONS))) {
    write[STORAGE_KEYS.SAVED_STATIONS] = data.savedStations;
  }
  if (!(await hasStoredValue(STORAGE_KEYS.BOOKING_HISTORY))) {
    write[STORAGE_KEYS.BOOKING_HISTORY] = data.bookingHistory;
  }
  if (!(await hasStoredValue(STORAGE_KEYS.AVAILABILITY_ALERTS))) {
    write[STORAGE_KEYS.AVAILABILITY_ALERTS] = data.availabilityAlerts;
  }
  if (!(await hasStoredValue(STORAGE_KEYS.QUICK_WIDGET_SETTINGS))) {
    write[STORAGE_KEYS.QUICK_WIDGET_SETTINGS] = data.quickWidgetSettings;
  }

  if (Object.keys(write).length) {
    await setStorage(write);
  }
}

async function hasStoredValue(key) {
  const values = await getStorage([key]);
  return Object.prototype.hasOwnProperty.call(values, key);
}

async function setTatkalAlarm(payload) {
  const journeyConfig = buildJourneyConfig(payload?.journeyConfig || {});
  const tatkalClassType = payload?.tatkalClassType || journeyConfig.tatkalClassType || inferTatkalClassType(journeyConfig);
  const schedule = computeTatkalTime(getTatkalScheduleJourney(journeyConfig, tatkalClassType === "both" ? "ac" : tatkalClassType));
  const tatkalRushConfig = {
    enabled: true,
    tatkalClassType,
    slotLabel: tatkalClassType === "both" ? "10:00:00 AM / 11:00:00 AM" : schedule.slotLabel,
    scheduledFor: schedule.startAt.toISOString(),
    reminderFor: schedule.reminderAt.toISOString(),
    journeyConfig
  };

  await scheduleTatkalAlarms(tatkalRushConfig);
  await setStorage({
    [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: tatkalRushConfig
  });

  return { tatkalRushConfig };
}

async function clearTatkalAlarm() {
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_START);
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_REMINDER);
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_PRE_POSITION);
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_START_SLEEPER);
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_REMINDER_SLEEPER);
  await chrome.alarms.clear(ALARM_NAMES.TATKAL_PRE_POSITION_SLEEPER);
  return {};
}

async function scheduleTatkalAlarms(tatkalRushConfig) {
  const journeyConfig = tatkalRushConfig?.journeyConfig || {};
  const tatkalClassType = tatkalRushConfig?.tatkalClassType || inferTatkalClassType(journeyConfig);

  await clearTatkalAlarm();
  for (const definition of getTatkalAlarmDefinitions(tatkalClassType)) {
    const schedule = computeTatkalTime(getTatkalScheduleJourney(journeyConfig, definition.slotType));
    await chrome.alarms.create(definition.prePositionName, { when: schedule.startAt.getTime() - 15 * 60 * 1000 });
    await chrome.alarms.create(definition.startName, { when: schedule.startAt.getTime() - 3000 });
    await chrome.alarms.create(definition.reminderName, { when: schedule.reminderAt.getTime() });
  }
}

function getTatkalScheduleJourney(journeyConfig, tatkalClassType) {
  if (tatkalClassType === "sleeper") {
    return { ...journeyConfig, journeyClass: "SL" };
  }
  return { ...journeyConfig, journeyClass: journeyConfig?.journeyClass || "3A" };
}

function inferTatkalClassType(journeyConfig) {
  return String(journeyConfig?.journeyClass || "").trim().toUpperCase() === "SL" ? "sleeper" : "ac";
}

function getTatkalAlarmDefinitions(tatkalClassType) {
  if (tatkalClassType === "both") {
    return [
      {
        slotType: "ac",
        startName: ALARM_NAMES.TATKAL_START,
        reminderName: ALARM_NAMES.TATKAL_REMINDER,
        prePositionName: ALARM_NAMES.TATKAL_PRE_POSITION
      },
      {
        slotType: "sleeper",
        startName: ALARM_NAMES.TATKAL_START_SLEEPER,
        reminderName: ALARM_NAMES.TATKAL_REMINDER_SLEEPER,
        prePositionName: ALARM_NAMES.TATKAL_PRE_POSITION_SLEEPER
      }
    ];
  }

  if (tatkalClassType === "sleeper") {
    return [{
      slotType: "sleeper",
      startName: ALARM_NAMES.TATKAL_START_SLEEPER,
      reminderName: ALARM_NAMES.TATKAL_REMINDER_SLEEPER,
      prePositionName: ALARM_NAMES.TATKAL_PRE_POSITION_SLEEPER
    }];
  }

  return [{
    slotType: "ac",
    startName: ALARM_NAMES.TATKAL_START,
    reminderName: ALARM_NAMES.TATKAL_REMINDER,
    prePositionName: ALARM_NAMES.TATKAL_PRE_POSITION
  }];
}

function getTatkalAlarmContext(alarmName) {
  const definitions = [
    { phase: "start", slotType: "ac", name: ALARM_NAMES.TATKAL_START },
    { phase: "reminder", slotType: "ac", name: ALARM_NAMES.TATKAL_REMINDER },
    { phase: "pre", slotType: "ac", name: ALARM_NAMES.TATKAL_PRE_POSITION },
    { phase: "start", slotType: "sleeper", name: ALARM_NAMES.TATKAL_START_SLEEPER },
    { phase: "reminder", slotType: "sleeper", name: ALARM_NAMES.TATKAL_REMINDER_SLEEPER },
    { phase: "pre", slotType: "sleeper", name: ALARM_NAMES.TATKAL_PRE_POSITION_SLEEPER }
  ];

  return definitions.find((definition) => definition.name === alarmName) || null;
}

function buildTatkalJourneyConfig(journeyConfig, tatkalClassType, extraMetadata = {}) {
  const scheduledJourney = getTatkalScheduleJourney(journeyConfig, tatkalClassType);
  return buildJourneyConfig({
    ...scheduledJourney,
    metadata: {
      ...(journeyConfig?.metadata || {}),
      ...extraMetadata,
      tatkalClassType
    }
  });
}

function pushPopupEvent(type, payload) {
  if (memoryState.pendingPopupPort) {
    memoryState.pendingPopupPort.postMessage({ type, payload });
  }
}

async function safeSendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    return null;
  }
}

async function openOrNavigateToIrctcTab(url) {
  const tabs = await chrome.tabs.query({ url: "*://www.irctc.co.in/*" });
  let tab = tabs.find((entry) => entry.url && entry.url.includes("irctc.co.in"));
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url, active: true });
    return tab.id;
  }
  const created = await chrome.tabs.create({ url, active: true });
  return created.id;
}

function isSearchPage(url = "") {
  return String(url).includes("/nget/train-search");
}

function isTrainListPage(url = "") {
  return String(url).includes("/train-list");
}

function isPaxDetailsPage(url = "") {
  return String(url).includes("/pax-details");
}

function isPaymentPage(url = "") {
  return String(url).includes("/payment");
}
