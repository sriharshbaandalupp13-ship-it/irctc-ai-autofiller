/* global chrome, IRCTCUtils */

(function () {
  const {
    STORAGE_KEYS,
    DEFAULT_QUICK_WIDGET_SETTINGS,
    GENDERS,
    BERTH_PREFERENCES,
    ID_PROOF_TYPES,
    PAYMENT_MODES,
    DEFAULT_PREFERENCES,
    getDataBundle,
    setStorage,
    generateId
  } = IRCTCUtils;

  const state = {
    passengers: [],
    groups: [],
    defaultPreferences: { ...DEFAULT_PREFERENCES },
    geminiApiKey: "",
    quickWidgetSettings: { ...DEFAULT_QUICK_WIDGET_SETTINGS },
    loginCreds: null,
    autoLogin: false
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    captureElements();
    seedSelect(elements.gender, GENDERS);
    seedSelect(elements.berthPreference, BERTH_PREFERENCES);
    seedSelect(elements.idProofType, ID_PROOF_TYPES);
    seedSelect(elements.defaultPaymentMode, PAYMENT_MODES, DEFAULT_PREFERENCES.paymentMode);
    bindEvents();
    await loadState();
  }

  function captureElements() {
    [
      "profileForm",
      "profileId",
      "fullName",
      "age",
      "gender",
      "berthPreference",
      "idProofType",
      "idProofNumber",
      "resetProfileButton",
      "profilesList",
      "profileCount",
      "groupForm",
      "groupId",
      "groupName",
      "groupMembers",
      "resetGroupButton",
      "groupsList",
      "preferencesForm",
      "defaultTravelInsurance",
      "defaultAutoUpgrade",
      "defaultOnlyConfirmBerths",
      "defaultPaymentMode",
      "defaultPreferredCoach",
      "defaultReservationChoice",
      "fallbackMobile",
      "geminiApiKey",
      "loginUsername",
      "loginPassword",
      "autoLogin",
      "saveCredentialsButton",
      "favoriteFromStation",
      "favoriteToStation",
      "favoriteGroupId",
      "favoritePassengerId",
      "selectionMode",
      "toast"
    ].forEach((id) => {
      elements[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    elements.profileForm.addEventListener("submit", saveProfile);
    elements.resetProfileButton.addEventListener("click", resetProfileForm);
    elements.groupForm.addEventListener("submit", saveGroup);
    elements.resetGroupButton.addEventListener("click", resetGroupForm);
    elements.preferencesForm.addEventListener("submit", savePreferences);
    elements.saveCredentialsButton.addEventListener("click", saveCredentials);
  }

  async function loadState() {
    const data = await getDataBundle();
    state.passengers = data.passengers;
    state.groups = data.groups;
    state.defaultPreferences = data.defaultPreferences;
    state.geminiApiKey = data.geminiApiKey || "";
    state.loginCreds = data.loginCreds || null;
    state.autoLogin = Boolean(data.autoLogin);
    state.quickWidgetSettings = data.quickWidgetSettings || { ...DEFAULT_QUICK_WIDGET_SETTINGS };
    applyPreferences();
    renderProfiles();
    renderGroupMembers();
    renderGroups();
    renderQuickBookingSelects();
  }

  function applyPreferences() {
    elements.defaultTravelInsurance.checked = Boolean(state.defaultPreferences.travelInsurance);
    elements.defaultAutoUpgrade.checked = Boolean(state.defaultPreferences.autoUpgrade);
    elements.defaultOnlyConfirmBerths.checked = Boolean(state.defaultPreferences.onlyConfirmBerths);
    elements.defaultPaymentMode.value = state.defaultPreferences.paymentMode || DEFAULT_PREFERENCES.paymentMode;
    elements.defaultPreferredCoach.value = state.defaultPreferences.preferredCoach || "";
    elements.defaultReservationChoice.value = state.defaultPreferences.reservationChoice || "";
    elements.fallbackMobile.value = state.defaultPreferences.fallbackMobile || "";
    elements.geminiApiKey.value = state.geminiApiKey;
    elements.loginUsername.value = safeDecodeCredential(state.loginCreds?.ircLogin);
    elements.loginPassword.value = safeDecodeCredential(state.loginCreds?.ircPass);
    elements.autoLogin.checked = state.autoLogin;
    elements.favoriteFromStation.value = state.quickWidgetSettings.favoriteFromStation || "";
    elements.favoriteToStation.value = state.quickWidgetSettings.favoriteToStation || "";
    elements.selectionMode.value = state.quickWidgetSettings.selectionMode || "family";
  }

  async function saveProfile(event) {
    event.preventDefault();

    if (state.passengers.length >= 10 && !elements.profileId.value) {
      showToast("Maximum 10 saved profiles allowed.");
      return;
    }

    const profile = {
      id: elements.profileId.value || generateId("passenger"),
      fullName: elements.fullName.value.trim(),
      age: Number(elements.age.value),
      gender: elements.gender.value,
      berthPreference: elements.berthPreference.value,
      idProofType: elements.idProofType.value,
      idProofNumber: elements.idProofNumber.value.trim()
    };

    if (!profile.fullName || !profile.age || !profile.idProofNumber) {
      showToast("Please complete all passenger fields.");
      return;
    }

    const index = state.passengers.findIndex((item) => item.id === profile.id);
    if (index >= 0) {
      state.passengers[index] = profile;
    } else {
      state.passengers.push(profile);
    }

    await persistCoreData();
    renderProfiles();
    renderGroupMembers();
    resetProfileForm();
    showToast("Passenger profile saved.");
  }

  function resetProfileForm() {
    elements.profileForm.reset();
    elements.profileId.value = "";
    elements.gender.value = GENDERS[0];
    elements.berthPreference.value = BERTH_PREFERENCES[0];
    elements.idProofType.value = ID_PROOF_TYPES[0];
  }

  async function saveGroup(event) {
    event.preventDefault();
    const memberIds = Array.from(elements.groupMembers.querySelectorAll("input[type='checkbox']:checked")).map((input) => input.value);
    const group = {
      id: elements.groupId.value || generateId("group"),
      name: elements.groupName.value.trim(),
      passengerIds: memberIds
    };

    if (!group.name || !group.passengerIds.length) {
      showToast("Choose a group name and at least one member.");
      return;
    }

    const index = state.groups.findIndex((item) => item.id === group.id);
    if (index >= 0) {
      state.groups[index] = group;
    } else {
      state.groups.unshift(group);
    }

    await persistCoreData();
    renderGroups();
    resetGroupForm();
    showToast("Passenger group saved.");
  }

  function resetGroupForm() {
    elements.groupId.value = "";
    elements.groupName.value = "";
    elements.groupMembers.querySelectorAll("input[type='checkbox']").forEach((input) => {
      input.checked = false;
    });
  }

  async function savePreferences(event) {
    event.preventDefault();
    state.defaultPreferences = {
      travelInsurance: elements.defaultTravelInsurance.checked,
      autoUpgrade: elements.defaultAutoUpgrade.checked,
      onlyConfirmBerths: elements.defaultOnlyConfirmBerths.checked,
      paymentMode: elements.defaultPaymentMode.value,
      preferredCoach: elements.defaultPreferredCoach.value.trim(),
      reservationChoice: elements.defaultReservationChoice.value.trim(),
      fallbackMobile: elements.fallbackMobile.value.trim()
    };
    state.geminiApiKey = elements.geminiApiKey.value.trim();
    state.quickWidgetSettings = {
      selectionMode: elements.selectionMode.value,
      favoriteFromStation: elements.favoriteFromStation.value.trim(),
      favoriteToStation: elements.favoriteToStation.value.trim(),
      favoriteGroupId: elements.favoriteGroupId.value,
      favoritePassengerId: elements.favoritePassengerId.value
    };

    await setStorage({
      [STORAGE_KEYS.DEFAULT_PREFERENCES]: state.defaultPreferences,
      [STORAGE_KEYS.GEMINI_API_KEY]: state.geminiApiKey,
      [STORAGE_KEYS.QUICK_WIDGET_SETTINGS]: state.quickWidgetSettings,
      [STORAGE_KEYS.SAVED_STATIONS]: IRCTCUtils.upsertSavedStations(
        (await getDataBundle()).savedStations,
        [state.quickWidgetSettings.favoriteFromStation, state.quickWidgetSettings.favoriteToStation]
      )
    });
    showToast("Preferences saved locally.");
  }

  async function saveCredentials() {
    const username = elements.loginUsername.value.trim();
    const password = elements.loginPassword.value;
    state.loginCreds = username || password ? {
      ircLogin: username ? btoa(username) : "",
      ircPass: password ? btoa(password) : ""
    } : null;
    state.autoLogin = elements.autoLogin.checked;

    await setStorage({
      [STORAGE_KEYS.LOGIN_CREDS]: state.loginCreds,
      [STORAGE_KEYS.AUTO_LOGIN]: state.autoLogin
    });
    showToast("Login credentials saved locally.");
  }

  function renderProfiles() {
    elements.profileCount.textContent = `${state.passengers.length} / 10`;
    elements.profilesList.innerHTML = "";

    if (!state.passengers.length) {
      elements.profilesList.classList.add("empty-state");
      elements.profilesList.textContent = "No passenger profiles yet.";
      return;
    }

    elements.profilesList.classList.remove("empty-state");
    state.passengers.forEach((profile) => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `
        <strong>${escapeHtml(profile.fullName)}</strong>
        <div class="meta">${escapeHtml(`${profile.age} yrs | ${profile.gender} | ${profile.berthPreference}`)}</div>
        <div class="meta">${escapeHtml(`${profile.idProofType}: ${profile.idProofNumber}`)}</div>
        <div class="item-actions">
          <button class="chip-button" type="button" data-action="edit">Edit</button>
          <button class="chip-button" type="button" data-action="delete">Delete</button>
        </div>
      `;

      item.querySelector("[data-action='edit']").addEventListener("click", () => fillProfileForm(profile));
      item.querySelector("[data-action='delete']").addEventListener("click", async () => {
        state.passengers = state.passengers.filter((entry) => entry.id !== profile.id);
        state.groups = state.groups.map((group) => ({
          ...group,
          passengerIds: group.passengerIds.filter((id) => id !== profile.id)
        }));
        await persistCoreData();
        renderProfiles();
        renderGroupMembers();
        renderGroups();
        showToast("Passenger profile deleted.");
      });

      elements.profilesList.appendChild(item);
    });
    renderQuickBookingSelects();
  }

  function fillProfileForm(profile) {
    elements.profileId.value = profile.id;
    elements.fullName.value = profile.fullName;
    elements.age.value = String(profile.age);
    elements.gender.value = profile.gender;
    elements.berthPreference.value = profile.berthPreference;
    elements.idProofType.value = profile.idProofType;
    elements.idProofNumber.value = profile.idProofNumber;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderGroupMembers() {
    elements.groupMembers.innerHTML = "";
    if (!state.passengers.length) {
      elements.groupMembers.classList.add("empty-state");
      elements.groupMembers.textContent = "Create passenger profiles first.";
      return;
    }

    elements.groupMembers.classList.remove("empty-state");
    state.passengers.forEach((profile) => {
      const label = document.createElement("label");
      label.className = "checkbox-pill";
      label.innerHTML = `
        <input type="checkbox" value="${profile.id}">
        <span>${escapeHtml(profile.fullName)} (${escapeHtml(profile.berthPreference)})</span>
      `;
      elements.groupMembers.appendChild(label);
    });
  }

  function renderGroups() {
    elements.groupsList.innerHTML = "";
    if (!state.groups.length) {
      elements.groupsList.classList.add("empty-state");
      elements.groupsList.textContent = "No groups saved.";
      return;
    }

    elements.groupsList.classList.remove("empty-state");
    state.groups.forEach((group) => {
      const memberNames = group.passengerIds
        .map((id) => state.passengers.find((profile) => profile.id === id)?.fullName)
        .filter(Boolean)
        .join(", ");

      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `
        <strong>${escapeHtml(group.name)}</strong>
        <div class="meta">${escapeHtml(memberNames || "No members")}</div>
        <div class="item-actions">
          <button class="chip-button" type="button" data-action="edit-group">Edit</button>
          <button class="chip-button" type="button" data-action="delete-group">Delete</button>
        </div>
      `;

      item.querySelector("[data-action='edit-group']").addEventListener("click", () => fillGroupForm(group));
      item.querySelector("[data-action='delete-group']").addEventListener("click", async () => {
        state.groups = state.groups.filter((entry) => entry.id !== group.id);
        await persistCoreData();
        renderGroups();
        showToast("Passenger group deleted.");
      });
      elements.groupsList.appendChild(item);
    });
    renderQuickBookingSelects();
  }

  function renderQuickBookingSelects() {
    seedSelect(
      elements.favoriteGroupId,
      [
        { value: "", label: "Choose family group" },
        ...state.groups.map((group) => ({ value: group.id, label: group.name }))
      ],
      state.quickWidgetSettings.favoriteGroupId || ""
    );

    seedSelect(
      elements.favoritePassengerId,
      [
        { value: "", label: "Choose single member" },
        ...state.passengers.map((passenger) => ({ value: passenger.id, label: passenger.fullName }))
      ],
      state.quickWidgetSettings.favoritePassengerId || ""
    );
  }

  function fillGroupForm(group) {
    elements.groupId.value = group.id;
    elements.groupName.value = group.name;
    elements.groupMembers.querySelectorAll("input[type='checkbox']").forEach((input) => {
      input.checked = group.passengerIds.includes(input.value);
    });
    window.scrollTo({ top: document.body.scrollHeight / 3, behavior: "smooth" });
  }

  async function persistCoreData() {
    await setStorage({
      [STORAGE_KEYS.PASSENGERS]: state.passengers,
      [STORAGE_KEYS.GROUPS]: state.groups
    });
  }

  function seedSelect(select, values, selected) {
    select.innerHTML = "";
    values.forEach((value) => {
      const option = document.createElement("option");
      if (typeof value === "object") {
        option.value = value.value;
        option.textContent = value.label;
      } else {
        option.value = value;
        option.textContent = value;
      }
      if (option.value === selected) {
        option.selected = true;
      }
      select.appendChild(option);
    });
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.remove("hidden");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      elements.toast.classList.add("hidden");
    }, 2500);
  }

  function safeDecodeCredential(value) {
    if (!value) {
      return "";
    }
    try {
      return atob(value);
    } catch (error) {
      return "";
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
