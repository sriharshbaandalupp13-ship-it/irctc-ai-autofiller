importScripts("local-config.js");
importScripts("utils.js");


/* global IRCTCUtils, STORAGE_KEYS, IRCTC_URLS, chrome */

(function () {
  const ALARM_NAMES = {
    TATKAL_START: "tatkal-start",
    TATKAL_REMINDER: "tatkal-reminder",
    TATKAL_PRE_POSITION: "tatkal-pre-position",
    TATKAL_START_SLEEPER: "tatkal-start-sleeper",
    TATKAL_REMINDER_SLEEPER: "tatkal-reminder-sleeper",
    TATKAL_PRE_POSITION_SLEEPER: "tatkal-pre-position-sleeper",
    AVAILABILITY_POLL: "availability-alert-poll"
  };

  const memoryState = {
    pendingPopupPort: null,
    inflightAvailabilityTabs: new Map(),
    serverTimeOffset: 0,
    lastHealthCheckStatus: true
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
        try {
          await chrome.runtime.openOptionsPage();
        } catch (error) {
          // Fallback for cases where openOptionsPage might not be available or fails
          await chrome.tabs.create({ url: "options.html" });
        }
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
      case "GET_SERVER_TIME_OFFSET":
        return { offset: memoryState.serverTimeOffset };
      case "PING_IRCTC_HEALTH":
        return pingIrctcHealth();
      case "SYNC_SERVER_TIME":
        return syncWithServerTime();
      default:
        return {};
    }
  }

  async function initializeLocalSecrets() {
    try {
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
    } catch (error) {
      console.error("Failed to initialize local secrets:", error);
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
      recommendation: data.latestRecommendation,
      tatkalRushConfig: data.tatkalRushConfig,
      quickWidgetSettings: data.quickWidgetSettings || DEFAULT_QUICK_WIDGET_SETTINGS,
      availabilityAlerts: data.availabilityAlerts || []
    };
  }

  async function seedStorageDefaults() {
    const data = await getStorage([
      STORAGE_KEYS.PASSENGERS,
      STORAGE_KEYS.GROUPS,
      STORAGE_KEYS.SAVED_STATIONS,
      STORAGE_KEYS.DEFAULT_PREFERENCES,
      STORAGE_KEYS.BOOKING_HISTORY,
      STORAGE_KEYS.AVAILABILITY_ALERTS,
      STORAGE_KEYS.QUICK_WIDGET_SETTINGS
    ]);

    const updates = {};
    if (!data[STORAGE_KEYS.PASSENGERS]) updates[STORAGE_KEYS.PASSENGERS] = [];
    if (!data[STORAGE_KEYS.GROUPS]) updates[STORAGE_KEYS.GROUPS] = [];
    if (!data[STORAGE_KEYS.SAVED_STATIONS]) updates[STORAGE_KEYS.SAVED_STATIONS] = [];
    if (!data[STORAGE_KEYS.DEFAULT_PREFERENCES]) updates[STORAGE_KEYS.DEFAULT_PREFERENCES] = DEFAULT_PREFERENCES;
    if (!data[STORAGE_KEYS.BOOKING_HISTORY]) updates[STORAGE_KEYS.BOOKING_HISTORY] = [];
    if (!data[STORAGE_KEYS.AVAILABILITY_ALERTS]) updates[STORAGE_KEYS.AVAILABILITY_ALERTS] = [];
    if (!data[STORAGE_KEYS.QUICK_WIDGET_SETTINGS]) updates[STORAGE_KEYS.QUICK_WIDGET_SETTINGS] = DEFAULT_QUICK_WIDGET_SETTINGS;

    if (Object.keys(updates).length > 0) {
      await setStorage(updates);
    }
  }

  async function saveJourneyDraft(payload) {
    await setStorage({ [STORAGE_KEYS.JOURNEY_DRAFT]: payload });
    return { journeyDraft: payload };
  }

  async function startBookingFlow(payload, sender) {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      return { ok: false, error: "No active tab context" };
    }

    await setStorage({
      [STORAGE_KEYS.ACTIVE_BOOKING]: {
        mode: "manual",
        journeyConfig: payload,
        sourceTabId: tabId,
        triggeredBy: "popup",
        lastUpdatedAt: new Date().toISOString()
      }
    });

    await safeSendToTab(tabId, {
      type: "START_PAGE_AUTOMATION",
      journeyConfig: payload
    });

    return { ok: true };
  }

  async function updateRuntimeStatus(payload) {
    await setStorage({ [STORAGE_KEYS.RUNTIME_STATUS]: payload });
    if (memoryState.pendingPopupPort) {
      try {
        memoryState.pendingPopupPort.postMessage({ type: "STATUS_UPDATED", payload });
      } catch (e) {
        memoryState.pendingPopupPort = null;
      }
    }
    return {};
  }

  async function showNotification(payload) {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXlUQAAAAASUVORK5CYII=",
      title: payload.title || "IRCTC AutoFill Assistant",
      message: payload.message
    });
    return {};
  }

  async function runAvailabilityCheck(payload, options = {}) {
    const { silent = false, alertId = null } = options;
    const tab = await chrome.tabs.create({ url: IRCTC_URLS.SEARCH, active: !silent });
    memoryState.inflightAvailabilityTabs.set(tab.id, {
      type: "AVAILABILITY",
      payload,
      silent,
      alertId
    });
    return { tabId: tab.id };
  }

  async function handleAvailabilityResults(payload, sender) {
    const tabId = sender?.tab?.id;
    const context = memoryState.inflightAvailabilityTabs.get(tabId);
    if (!context) return {};

    memoryState.inflightAvailabilityTabs.delete(tabId);
    if (context.silent) {
      await chrome.tabs.remove(tabId);
    }

    if (memoryState.pendingPopupPort) {
      try {
        memoryState.pendingPopupPort.postMessage({
          type: "AVAILABILITY_RESULTS",
          payload: { ...payload, alertId: context.alertId }
        });
      } catch (e) {
        memoryState.pendingPopupPort = null;
      }
    }

    if (context.alertId && payload.available) {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXlUQAAAAASUVORK5CYII=",
        title: "🎟️ Tickets Available!",
        message: `Seats found for ${payload.from} to ${payload.to} on ${payload.date}.`
      });
    }

    return {};
  }

  async function saveAvailabilityAlert(payload) {
    const { [STORAGE_KEYS.AVAILABILITY_ALERTS]: alerts = [] } = await getStorage([STORAGE_KEYS.AVAILABILITY_ALERTS]);
    const newAlert = {
      ...payload,
      id: generateId(),
      enabled: true,
      createdAt: new Date().toISOString()
    };
    await setStorage({ [STORAGE_KEYS.AVAILABILITY_ALERTS]: [...alerts, newAlert] });
    return { alert: newAlert };
  }

  async function deleteAvailabilityAlert(id) {
    const { [STORAGE_KEYS.AVAILABILITY_ALERTS]: alerts = [] } = await getStorage([STORAGE_KEYS.AVAILABILITY_ALERTS]);
    const filtered = alerts.filter((a) => a.id !== id);
    await setStorage({ [STORAGE_KEYS.AVAILABILITY_ALERTS]: filtered });
    return { ok: true };
  }

  async function saveQuickWidgetSettings(payload) {
    await setStorage({ [STORAGE_KEYS.QUICK_WIDGET_SETTINGS]: payload });
    return { ok: true };
  }

  async function setTatkalAlarm(payload) {
    const { tatkalClassType, journeyConfig } = payload;
    const schedule = buildTatkalScheduleForType(tatkalClassType, journeyConfig);

    const names = [
      ALARM_NAMES.TATKAL_START,
      ALARM_NAMES.TATKAL_REMINDER,
      ALARM_NAMES.TATKAL_PRE_POSITION,
      ALARM_NAMES.TATKAL_START_SLEEPER,
      ALARM_NAMES.TATKAL_REMINDER_SLEEPER,
      ALARM_NAMES.TATKAL_PRE_POSITION_SLEEPER
    ];
    for (const name of names) await chrome.alarms.clear(name);

    const prefix = tatkalClassType === "sleeper" ? "sleeper-" : "";
    const prefixStr = prefix ? "-" + prefix : "";
    await chrome.alarms.create(ALARM_NAMES.TATKAL_START + prefixStr, { when: schedule.startAt.getTime() });
    await chrome.alarms.create(ALARM_NAMES.TATKAL_REMINDER + prefixStr, { when: schedule.reminderAt.getTime() });
    await chrome.alarms.create(ALARM_NAMES.TATKAL_PRE_POSITION + prefixStr, { when: schedule.prePositionAt.getTime() });

    if (tatkalClassType === "both") {
      const sleeperSchedule = buildTatkalScheduleForType("sleeper", journeyConfig);
      await chrome.alarms.create(ALARM_NAMES.TATKAL_START_SLEEPER, { when: sleeperSchedule.startAt.getTime() });
      await chrome.alarms.create(ALARM_NAMES.TATKAL_REMINDER_SLEEPER, { when: sleeperSchedule.reminderAt.getTime() });
      await chrome.alarms.create(ALARM_NAMES.TATKAL_PRE_POSITION_SLEEPER, { when: sleeperSchedule.prePositionAt.getTime() });
    }

    await setStorage({
      [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: {
        enabled: true,
        tatkalClassType,
        journeyConfig,
        scheduledFor: schedule.startAt.toISOString(),
        reminderFor: schedule.reminderAt.toISOString()
      }
    });

    return { ok: true, schedule };
  }

  async function clearTatkalAlarm() {
    const names = [
      ALARM_NAMES.TATKAL_START,
      ALARM_NAMES.TATKAL_REMINDER,
      ALARM_NAMES.TATKAL_PRE_POSITION,
      ALARM_NAMES.TATKAL_START_SLEEPER,
      ALARM_NAMES.TATKAL_REMINDER_SLEEPER,
      ALARM_NAMES.TATKAL_PRE_POSITION_SLEEPER
    ];
    for (const name of names) await chrome.alarms.clear(name);

    const { [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: config } = await getStorage([STORAGE_KEYS.TATKAL_RUSH_CONFIG]);
    if (config) {
      await setStorage({
        [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: { ...config, enabled: false }
      });
    }
    return { ok: true };
  }

  async function handlePageReady(payload, sender) {
    const tabId = sender?.tab?.id;
    if (!tabId) return {};

    const { [STORAGE_KEYS.ACTIVE_BOOKING]: activeBooking } = await getStorage([STORAGE_KEYS.ACTIVE_BOOKING]);
    if (activeBooking && activeBooking.sourceTabId === tabId) {
      await safeSendToTab(tabId, {
        type: "RESUME_PAGE_AUTOMATION",
        payload: {
          ...activeBooking,
          url: payload.url
        }
      });
    }

    const availabilityContext = memoryState.inflightAvailabilityTabs.get(tabId);
    if (availabilityContext) {
      await safeSendToTab(tabId, {
        type: "START_AVAILABILITY_SCAN",
        payload: availabilityContext.payload
      });
    }

    return {};
  }

  async function finalizeBooking(payload) {
    const { [STORAGE_KEYS.BOOKING_HISTORY]: history = [] } = await getStorage([STORAGE_KEYS.BOOKING_HISTORY]);
    const entry = {
      ...payload,
      id: generateId(),
      timestamp: new Date().toISOString()
    };
    const newHistory = [entry, ...history].slice(0, 50);
    await setStorage({
      [STORAGE_KEYS.BOOKING_HISTORY]: newHistory,
      [STORAGE_KEYS.ACTIVE_BOOKING]: null
    });
    return { ok: true };
  }

  async function getActiveBooking() {
    const { [STORAGE_KEYS.ACTIVE_BOOKING]: activeBooking } = await getStorage([STORAGE_KEYS.ACTIVE_BOOKING]);
    return { activeBooking };
  }

  async function getRecommendation() {
    const { [STORAGE_KEYS.LATEST_RECOMMENDATION]: latestRecommendation } = await getStorage([STORAGE_KEYS.LATEST_RECOMMENDATION]);
    return { recommendation: latestRecommendation };
  }

  async function runGeminiSelectorQuery(payload) {
    const { [STORAGE_KEYS.GEMINI_API_KEY]: geminiApiKey } = await getStorage([STORAGE_KEYS.GEMINI_API_KEY]);
    if (!geminiApiKey) {
      return { ok: false, error: "Gemini API key not configured" };
    }
    try {
      const result = await callGeminiSelector(geminiApiKey, payload.domSnapshot, payload.goal);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  function getTatkalAlarmContext(name) {
    if (name.startsWith(ALARM_NAMES.TATKAL_START)) return { phase: "start", slotType: name.includes("sleeper") ? "sleeper" : "ac" };
    if (name.startsWith(ALARM_NAMES.TATKAL_REMINDER)) return { phase: "reminder", slotType: name.includes("sleeper") ? "sleeper" : "ac" };
    if (name.startsWith(ALARM_NAMES.TATKAL_PRE_POSITION)) return { phase: "pre", slotType: name.includes("sleeper") ? "sleeper" : "ac" };
    return null;
  }

  function buildTatkalJourneyConfig(baseConfig, slotType, overrides = {}) {
    return {
      ...baseConfig,
      journeyClass: slotType === "sleeper" ? "SL" : (baseConfig.journeyClass || "3A"),
      ...overrides
    };
  }

  async function safeSendToTab(tabId, message) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      /* Tab may have closed or script not ready. */
    }
  }

  async function syncWithServerTime() {
    try {
      const start = Date.now();
      const response = await fetch("https://www.irctc.co.in/nget/", { method: "HEAD", cache: "no-store" });
      const end = Date.now();
      const serverDateStr = response.headers.get("Date");
      if (!serverDateStr) return { ok: false };

      const serverTime = new Date(serverDateStr).getTime();
      const preciseServerTime = serverTime + (end - start) / 2;
      memoryState.serverTimeOffset = preciseServerTime - end;
      
      return { ok: true, offset: memoryState.serverTimeOffset };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function pingIrctcHealth() {
    try {
      const response = await fetch("https://www.irctc.co.in/nget/", { method: "HEAD", cache: "no-store", timeout: 5000 });
      memoryState.lastHealthCheckStatus = response.ok;
      return { ok: response.ok, status: response.status };
    } catch (error) {
      memoryState.lastHealthCheckStatus = false;
      return { ok: false, error: error.message };
    }
  }

  async function openOrNavigateToIrctcTab(url) {
    const tabs = await chrome.tabs.query({ url: "*://www.irctc.co.in/*" });
    let tab = tabs.find((entry) => entry.url && entry.url.includes("irctc.co.in"));

    if (tab) {
      await chrome.tabs.update(tab.id, { url, active: true });
      return tab.id;
    } else {
      tab = await chrome.tabs.create({ url, active: true });
      return tab.id;
    }
  }

  function isSearchPage(url) { return url.includes("/train-search"); }
  function isTrainListPage(url) { return url.includes("/train-list"); }
  function isPaxDetailsPage(url) { return url.includes("/booking/pax-details"); }
  function isPaymentPage(url) { return url.includes("/booking/payment"); }

  // Initial calls
  initializeLocalSecrets();

})();
