const { STORAGE_KEYS, getStorage, setStorage, removeStorage, escapeHtml } = window.IRCTCUtils;
const GENDERS = ["Male", "Female", "Transgender"];
const BERTH_PREFERENCES = ["Lower", "Middle", "Upper", "Side Lower", "Side Upper", "No Preference"];
const ID_PROOF_TYPES = ["Aadhaar", "PAN", "Passport", "Driving License", "Voter ID"];
const PAYMENT_MODES = ["BHIM UPI", "Credit & Debit Card", "Net Banking", "Wallet"];
const elements = {};
let state = { passengers: [], groups: [], defaultPreferences: {}, loginCreds: null, autoLogin: false };

window.addEventListener("DOMContentLoaded", init);

function init() {
  captureElements();
  seedControls();
  attachEvents();
  loadState();
}

function captureElements() {
  [
    "profileForm","profileId","fullName","age","gender","berthPreference","idProofType","idProofNumber","seniorConcession",
    "resetProfileButton","profilesList","profileCount","groupForm","groupId","groupName","groupMembers","resetGroupButton","groupsList",
    "preferencesForm","defaultTravelInsurance","defaultAutoUpgrade","defaultOnlyConfirmBerths","defaultPaymentMode","defaultPreferredCoach",
    "defaultReservationChoice","fallbackMobile","geminiApiKey","loginUsername","loginPassword","autoLogin","saveCredentialsButton",
    "favoriteFromStation","favoriteToStation","favoriteGroupId","favoritePassengerId","selectionMode","toast"
  ].forEach((id) => { elements[id] = document.getElementById(id); });
}

function seedControls() {
  populateSelect(elements.gender, GENDERS);
  populateSelect(elements.berthPreference, BERTH_PREFERENCES);
  populateSelect(elements.idProofType, ID_PROOF_TYPES);
  populateSelect(elements.defaultPaymentMode, PAYMENT_MODES);
}

function attachEvents() {
  elements.profileForm.addEventListener("submit", saveProfile);
  elements.resetProfileButton.addEventListener("click", resetProfileForm);
  elements.groupForm.addEventListener("submit", saveGroup);
  elements.resetGroupButton.addEventListener("click", resetGroupForm);
  elements.preferencesForm.addEventListener("submit", savePreferences);
  elements.saveCredentialsButton.addEventListener("click", saveCredentials);
  document.getElementById("clearAllStateButton").addEventListener("click", clearAllData);
}

async function loadState() {
  const data = await getStorage([STORAGE_KEYS.PASSENGERS, STORAGE_KEYS.GROUPS, STORAGE_KEYS.DEFAULT_PREFERENCES, STORAGE_KEYS.GEMINI_API_KEY, STORAGE_KEYS.LOGIN_CREDS, STORAGE_KEYS.AUTO_LOGIN]);
  state.passengers = data[STORAGE_KEYS.PASSENGERS] || [];
  state.groups = data[STORAGE_KEYS.GROUPS] || [];
  state.defaultPreferences = data[STORAGE_KEYS.DEFAULT_PREFERENCES] || { travelInsurance: true, autoUpgrade: false, onlyConfirmBerths: false, paymentMode: PAYMENT_MODES[0], preferredCoach: "", reservationChoice: "", fallbackMobile: "" };
  state.loginCreds = data[STORAGE_KEYS.LOGIN_CREDS] || null;
  state.autoLogin = Boolean(data[STORAGE_KEYS.AUTO_LOGIN]);
  state.geminiApiKey = data[STORAGE_KEYS.GEMINI_API_KEY] || "";
  applyState();
}

function applyState() {
  elements.profileCount.textContent = `${state.passengers.length} / 10`;
  elements.defaultTravelInsurance.checked = Boolean(state.defaultPreferences.travelInsurance);
  elements.defaultAutoUpgrade.checked = Boolean(state.defaultPreferences.autoUpgrade);
  elements.defaultOnlyConfirmBerths.checked = Boolean(state.defaultPreferences.onlyConfirmBerths);
  elements.defaultPaymentMode.value = state.defaultPreferences.paymentMode || PAYMENT_MODES[0];
  elements.defaultPreferredCoach.value = state.defaultPreferences.preferredCoach || "";
  elements.defaultReservationChoice.value = state.defaultPreferences.reservationChoice || "";
  elements.fallbackMobile.value = state.defaultPreferences.fallbackMobile || "";
  elements.geminiApiKey.value = state.geminiApiKey;
  elements.loginUsername.value = safeDecode(state.loginCreds?.ircLogin);
  elements.loginPassword.value = safeDecode(state.loginCreds?.ircPass);
  elements.autoLogin.checked = state.autoLogin;
  renderPassengers();
  renderGroupMembers();
  renderGroups();
}

function populateSelect(select, values) {
  if (!select) return;
  select.innerHTML = "";
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

async function saveProfile(event) {
  event.preventDefault();
  if (state.passengers.length >= 10 && !elements.profileId.value) {
    showToast("Maximum 10 passenger profiles allowed.");
    return;
  }
  const profile = {
    id: elements.profileId.value || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fullName: elements.fullName.value.trim(),
    age: Number(elements.age.value),
    gender: elements.gender.value,
    berthPreference: elements.berthPreference.value,
    seniorConcession: Boolean(elements.seniorConcession.checked),
    idProofType: elements.idProofType.value,
    idProofNumber: elements.idProofNumber.value.trim()
  };
  if (!profile.fullName || !profile.age || !profile.idProofNumber) {
    showToast("Please fill all passenger details.");
    return;
  }
  const existing = state.passengers.findIndex((item) => item.id === profile.id);
  if (existing >= 0) {
    state.passengers[existing] = profile;
  } else {
    state.passengers.push(profile);
  }
  await setStorage({ [STORAGE_KEYS.PASSENGERS]: state.passengers });
  renderPassengers();
  renderGroupMembers();
  resetProfileForm();
  showToast("Passenger saved.");
}

function resetProfileForm() {
  elements.profileForm.reset();
  elements.profileId.value = "";
  elements.gender.value = GENDERS[0];
  elements.berthPreference.value = BERTH_PREFERENCES[0];
  elements.idProofType.value = ID_PROOF_TYPES[0];
  elements.seniorConcession.checked = false;
}

async function saveGroup(event) {
  event.preventDefault();
  const memberIds = Array.from(elements.groupMembers.querySelectorAll("input[type='checkbox']:checked")).map((input) => input.value);
  const group = {
    id: elements.groupId.value || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: elements.groupName.value.trim(),
    passengerIds: memberIds
  };
  if (!group.name || !group.passengerIds.length) {
    showToast("Please enter group name and select members.");
    return;
  }
  const existing = state.groups.findIndex((item) => item.id === group.id);
  if (existing >= 0) {
    state.groups[existing] = group;
  } else {
    state.groups.push(group);
  }
  await setStorage({ [STORAGE_KEYS.GROUPS]: state.groups });
  renderGroups();
  resetGroupForm();
  showToast("Group saved.");
}

function resetGroupForm() {
  elements.groupForm.reset();
  elements.groupId.value = "";
  elements.groupMembers.querySelectorAll("input[type='checkbox']").forEach((input) => { input.checked = false; });
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
  await setStorage({
    [STORAGE_KEYS.DEFAULT_PREFERENCES]: state.defaultPreferences,
    [STORAGE_KEYS.GEMINI_API_KEY]: state.geminiApiKey
  });
  showToast("Preferences saved.");
}

async function saveCredentials() {
  const username = elements.loginUsername.value.trim();
  const password = elements.loginPassword.value;
  const creds = username || password ? { ircLogin: username ? btoa(username) : "", ircPass: password ? btoa(password) : "" } : null;
  state.loginCreds = creds;
  state.autoLogin = elements.autoLogin.checked;
  await setStorage({ [STORAGE_KEYS.LOGIN_CREDS]: creds, [STORAGE_KEYS.AUTO_LOGIN]: state.autoLogin });
  showToast("Credentials saved locally.");
}

async function clearAllData() {
  if (!confirm("Reset ALL extension data? This cannot be undone.")) {
    return;
  }
  await removeStorage([STORAGE_KEYS.PASSENGERS, STORAGE_KEYS.GROUPS, STORAGE_KEYS.DEFAULT_PREFERENCES, STORAGE_KEYS.GEMINI_API_KEY, STORAGE_KEYS.LOGIN_CREDS, STORAGE_KEYS.AUTO_LOGIN]);
  location.reload();
}

function renderPassengers() {
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
        <button type="button" class="chip-button" data-action="edit" data-id="${profile.id}">Edit</button>
        <button type="button" class="chip-button" data-action="delete" data-id="${profile.id}">Delete</button>
      </div>
    `;
    item.querySelector("button[data-action='edit']").addEventListener("click", () => fillProfile(profile));
    item.querySelector("button[data-action='delete']").addEventListener("click", async () => {
      state.passengers = state.passengers.filter((p) => p.id !== profile.id);
      state.groups = state.groups.map((group) => ({ ...group, passengerIds: group.passengerIds.filter((id) => id !== profile.id) }));
      await setStorage({ [STORAGE_KEYS.PASSENGERS]: state.passengers, [STORAGE_KEYS.GROUPS]: state.groups });
      renderPassengers();
      renderGroups();
      renderGroupMembers();
      showToast("Passenger deleted.");
    });
    elements.profilesList.appendChild(item);
  });
}

function fillProfile(profile) {
  elements.profileId.value = profile.id;
  elements.fullName.value = profile.fullName;
  elements.age.value = String(profile.age);
  elements.gender.value = profile.gender;
  elements.berthPreference.value = profile.berthPreference;
  elements.idProofType.value = profile.idProofType;
  elements.idProofNumber.value = profile.idProofNumber;
  elements.seniorConcession.checked = Boolean(profile.seniorConcession);
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
    label.innerHTML = `<input type="checkbox" value="${profile.id}"><span>${escapeHtml(profile.fullName)}</span>`;
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
    const names = group.passengerIds.map((id) => state.passengers.find((p) => p.id === id)?.fullName).filter(Boolean).join(", ");
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <strong>${escapeHtml(group.name)}</strong>
      <div class="meta">${escapeHtml(names || "No members")}</div>
      <div class="item-actions">
        <button type="button" class="chip-button" data-action="edit-group" data-id="${group.id}">Edit</button>
        <button type="button" class="chip-button" data-action="delete-group" data-id="${group.id}">Delete</button>
      </div>
    `;
    item.querySelector("button[data-action='edit-group']").addEventListener("click", () => fillGroup(group));
    item.querySelector("button[data-action='delete-group']").addEventListener("click", async () => {
      state.groups = state.groups.filter((g) => g.id !== group.id);
      await setStorage({ [STORAGE_KEYS.GROUPS]: state.groups });
      renderGroups();
      showToast("Group deleted.");
    });
    elements.groupsList.appendChild(item);
  });
}

function fillGroup(group) {
  elements.groupId.value = group.id;
  elements.groupName.value = group.name;
  elements.groupMembers.querySelectorAll("input[type='checkbox']").forEach((input) => {
    input.checked = group.passengerIds.includes(input.value);
  });
}

function safeDecode(value) {
  if (!value) return "";
  try {
    return atob(value);
  } catch (error) {
    return "";
  }
}

function showToast(message) {
  const toast = elements.toast;
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.add("hidden"), 2400);
}
