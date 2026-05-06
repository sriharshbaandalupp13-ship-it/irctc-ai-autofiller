importScripts("utils.js");

/* global IRCTCUtils, chrome */

const {
  STORAGE_KEYS,
  IRCTC_URLS,
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
  AVAILABILITY_POLL: "availability-alert-poll"
};

const memoryState = {
  pendingPopupPort: null,
  inflightAvailabilityTabs: new Map()
};

chrome.runtime.onInstalled.addListener(async () => {
  const data = await getDataBundle();
  await setStorage({
    [STORAGE_KEYS.DEFAULT_PREFERENCES]: data.defaultPreferences,
    [STORAGE_KEYS.PASSENGERS]: data.passengers,
    [STORAGE_KEYS.GROUPS]: data.groups,
    [STORAGE_KEYS.SAVED_STATIONS]: data.savedStations,
    [STORAGE_KEYS.BOOKING_HISTORY]: data.bookingHistory,
    [STORAGE_KEYS.AVAILABILITY_ALERTS]: data.availabilityAlerts
  });
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

  if (tab.url.startsWith(IRCTC_URLS.SEARCH) || tab.url.startsWith(IRCTC_URLS.TRAIN_LIST) || tab.url.startsWith(IRCTC_URLS.PAX_DETAILS) || tab.url.startsWith(IRCTC_URLS.PAYMENT)) {
    await safeSendToTab(tabId, {
      type: "BACKGROUND_PAGE_READY",
      url: tab.url
    });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAMES.TATKAL_REMINDER) {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXlUQAAAAASUVORK5CYII=",
      title: "IRCTC AutoFill Assistant",
      message: "Tatkal opens in 5 minutes — get ready."
    });
    return;
  }

  if (alarm.name === ALARM_NAMES.TATKAL_START) {
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

    const created = await chrome.tabs.create({
      url: IRCTC_URLS.SEARCH,
      active: true
    });

    const journeyConfig = buildJourneyConfig({
      ...tatkalRushConfig.journeyConfig,
      metadata: {
        ...(tatkalRushConfig.journeyConfig.metadata || {}),
        mode: "booking",
        tatkalTriggeredAt: new Date().toISOString()
      }
    });

    await setStorage({
      [STORAGE_KEYS.ACTIVE_BOOKING]: {
        mode: "booking",
        journeyConfig,
        sourceTabId: created.id,
        triggeredBy: "tatkal-alarm",
        lastUpdatedAt: new Date().toISOString()
      }
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
    case "PAGE_READY":
      return handlePageReady(message.payload, sender);
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
    latestRecommendation: data.latestRecommendation
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
    const schedule = computeTatkalTime(journeyConfig);
    const tatkalRushConfig = {
      enabled: true,
      slotLabel: schedule.slotLabel,
      scheduledFor: schedule.startAt.toISOString(),
      reminderFor: schedule.reminderAt.toISOString(),
      journeyConfig
    };
    write[STORAGE_KEYS.TATKAL_RUSH_CONFIG] = tatkalRushConfig;
    await chrome.alarms.create(ALARM_NAMES.TATKAL_START, { when: schedule.startAt.getTime() });
    await chrome.alarms.create(ALARM_NAMES.TATKAL_REMINDER, { when: schedule.reminderAt.getTime() });
  } else {
    write[STORAGE_KEYS.TATKAL_RUSH_CONFIG] = null;
    await chrome.alarms.clear(ALARM_NAMES.TATKAL_START);
    await chrome.alarms.clear(ALARM_NAMES.TATKAL_REMINDER);
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

async function handlePageReady(payload, sender) {
  const data = await getDataBundle();
  const activeBooking = data.activeBooking;

  if (!sender.tab?.id || !payload?.url || !activeBooking) {
    return {};
  }

  const tabId = sender.tab.id;
  const journeyConfig = activeBooking.journeyConfig;

  if (payload.url.startsWith(IRCTC_URLS.SEARCH) && (activeBooking.mode === "booking" || activeBooking.mode === "availabilityCheck")) {
    await safeSendToTab(tabId, {
      type: activeBooking.mode === "availabilityCheck" ? "RUN_AVAILABILITY_PAGE1" : "START_PAGE_AUTOMATION",
      journeyConfig
    });
  }

  if (payload.url.startsWith(IRCTC_URLS.PAX_DETAILS) && activeBooking.mode === "booking") {
    await safeSendToTab(tabId, {
      type: "RUN_PAX_AUTOMATION",
      journeyConfig
    });
  }

  if (payload.url.startsWith(IRCTC_URLS.TRAIN_LIST)) {
    await safeSendToTab(tabId, {
      type: activeBooking.mode === "availabilityCheck" ? "SCRAPE_AVAILABILITY_RESULTS" : "SHOW_READY_BADGE",
      journeyConfig
    });
  }

  if (payload.url.startsWith(IRCTC_URLS.PAYMENT)) {
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

  const nextHistory = [historyEntry, ...data.bookingHistory].slice(0, 10);
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
