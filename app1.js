// ============================================================
// adRoomie — single-file app logic
// Plain JS, hash-based router, Firebase modular SDK via CDN, Font Awesome icons.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, sendEmailVerification, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, addDoc, updateDoc,
  collection, query, where, orderBy, onSnapshot, serverTimestamp, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBSzMgAGGGNR3ykjnuVxz-eJl57V8Kgdg8",
  authDomain: "luxuryhomesug-cb8a4.firebaseapp.com",
  projectId: "luxuryhomesug-cb8a4",
  storageBucket: "luxuryhomesug-cb8a4.firebasestorage.app",
  messagingSenderId: "602825431747",
  appId: "1:602825431747:web:23636de9e8caabaf756076",
  measurementId: "G-GN4W36P8EB"
};
const CLOUDINARY_CLOUD_NAME = "dvdshonhc";
const CLOUDINARY_UPLOAD_PRESET = "adroomie";
const ONESIGNAL_APP_ID = "YOUR_ONESIGNAL_APP_ID";
// ---------------------------------------------------------

const CATEGORY_OPTIONS = ["Restaurant / Cafe","Bakery","Fitness / Health","Retail","Electronics/Gadgets","Homeware","Education","Beauty & Wellness","Services","Other"];
const BUDGET_OPTIONS = ["UGX 100,000 - 300,000","UGX 300,000 - 500,000","UGX 500,000 - 800,000","UGX 800,000+"];
const DURATION_OPTIONS = ["1 week","2 weeks","1 month"];
const AUDIENCE_OPTIONS = ["Students","Young Adults (18-30)","Families","Professionals","Parents","Teens","Seniors","Tourists","Budget Shoppers","Luxury Shoppers","Fitness Enthusiasts","Foodies"];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const appEl = document.getElementById("app");
const topbarEl = document.getElementById("topbar");
const navEl = document.getElementById("bottomNav");
const toastEl = document.getElementById("toast");

const state = { user: null, business: null, unsub: [] };

// ============================================================
// Small helpers
// ============================================================
function toast(msg) {
  toastEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${esc(msg)}`;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2400);
}
function esc(str) {
  return (str || "").toString().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function initials(name) { return (name || "??").trim().slice(0, 2).toUpperCase(); }
function clearListeners() { state.unsub.forEach((u) => u()); state.unsub = []; }
function go(hash) { window.location.hash = hash; }
function loadingHTML(msg) { return `<div class="loading-spin"><i class="fa-solid fa-circle-notch fa-spin"></i>${esc(msg || "Loading…")}</div>`; }

// Renders an avatar — a real photo if the business has one, initials otherwise.
function avatarHTML(business, sizeClass = "sm", editable = false) {
  const cls = `avatar-circle ${sizeClass} ${editable ? "editable" : ""}`;
  if (business && business.photoURL) {
    return `<div class="${cls}" id="${editable ? "avatarCircle" : ""}"><img src="${business.photoURL}" alt="${esc(business.name)}">${editable ? `<span class="edit-dot"><i class="fa-solid fa-pen"></i></span>` : ""}</div>`;
  }
  return `<div class="${cls}" id="${editable ? "avatarCircle" : ""}">${initials(business ? business.name : "")}${editable ? `<span class="edit-dot"><i class="fa-solid fa-pen"></i></span>` : ""}</div>`;
}

function platformIcon(p) {
  const map = { facebook: "fa-brands fa-facebook-f", instagram: "fa-brands fa-instagram", tiktok: "fa-brands fa-tiktok" };
  return map[p] || "fa-solid fa-hashtag";
}

// Reusable multi-select chip group. Returns HTML + wires click handlers.
function renderChipGroup(containerId, options, selectedSet, iconFn) {
  return `<div class="chip-picker" id="${containerId}">
    ${options.map((opt) => `<div class="chip ${selectedSet.has(opt) ? "selected" : ""}" data-v="${esc(opt)}">
      ${iconFn ? `<i class="${iconFn(opt)}"></i>` : ""}${esc(opt)}
    </div>`).join("")}
  </div>`;
}
function wireChipGroup(containerId, selectedSet) {
  document.querySelectorAll(`#${containerId} .chip`).forEach((chip) => {
    chip.onclick = () => {
      const v = chip.dataset.v;
      selectedSet.has(v) ? selectedSet.delete(v) : selectedSet.add(v);
      chip.classList.toggle("selected");
    };
  });
}

// Cloudinary — unsigned upload straight from the browser, no SDK, no backend.
async function uploadToCloudinary(file) {
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  const res = await fetch(url, { method: "POST", body: formData });
  if (!res.ok) throw new Error("Upload failed");
  const data = await res.json();
  return data.secure_url;
}

// Netlify Function proxy — keeps the OneSignal REST key server-side.
async function notifyPartner(playerId, message, title, url) {
  if (!playerId) return;
  try {
    await fetch("/api/send-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, message, title, url }),
    });
  } catch (e) { console.warn("Notification failed:", e); }
}

// Simple rule-based match score (no AI) — approximates the blueprint's
// weighted scoring: Audience 40 / Industry 25 / Location 15 / Budget 10 / Platform 10.
// NOTE: "complementary industry" uses a placeholder heuristic (different category = good)
// until a real industry-pairing table exists — flagged as an open item.
function matchScore(business, room) {
  let score = 0;
  const bAud = new Set(business.audience || []);
  const rAud = new Set(room.audience || []);
  const overlap = [...bAud].filter((a) => rAud.has(a)).length;
  const audienceRatio = bAud.size ? overlap / Math.max(1, Math.min(bAud.size, rAud.size)) : 0;
  score += audienceRatio * 40;
  score += (business.category && room.creatorCategory && business.category !== room.creatorCategory) ? 25 : 8;
  score += (business.location && room.location && business.location.toLowerCase() === room.location.toLowerCase()) ? 15 : 0;
  score += (business.budgetRange === room.budgetRange) ? 10 : 4;
  score += (business.platforms || []).some((p) => (room.platforms || []).includes(p)) ? 10 : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ============================================================
// Auth
// ============================================================
async function signUp(email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await sendEmailVerification(cred.user); // free — covers "email verified" trust badge
  return cred.user;
}
async function signIn(email, password) { return (await signInWithEmailAndPassword(auth, email, password)).user; }
function logOut() { return signOut(auth); }
async function loadBusiness(uid) {
  const snap = await getDoc(doc(db, "businesses", uid));
  return snap.exists() ? snap.data() : null;
}

// ============================================================
// Chrome: topbar + bottom nav
// ============================================================
function renderTopbar({ title, back, actions } = {}) {
  topbarEl.innerHTML = `
    <div class="left">
      ${back ? `<button class="back-btn" id="backBtn"><i class="fa-solid fa-chevron-left"></i></button>` : ""}
      ${title ? `<strong>${esc(title)}</strong>` : `<div class="brand"><i class="fa-solid fa-handshake"></i> adRoomie</div>`}
    </div>
    <div style="display:flex; gap:8px;">
      ${!title ? `<span class="beta-badge">BETA</span>` : ""}
      ${(actions || []).map((a) => `<button class="icon-btn" id="${a.id}"><i class="${a.icon}"></i></button>`).join("")}
    </div>`;
  if (back) document.getElementById("backBtn").onclick = () => window.history.back();
  (actions || []).forEach((a) => { document.getElementById(a.id).onclick = a.onClick; });
}

function renderBottomNav(activeRoute) {
  if (!state.user || !state.business) { navEl.innerHTML = ""; return; }
  const items = [
    { id: "home", icon: "fa-solid fa-house", label: "Home", hash: "#/rooms" },
    { id: "rooms", icon: "fa-solid fa-magnifying-glass", label: "Rooms", hash: "#/rooms" },
    { id: "create", icon: "fa-solid fa-plus", label: "", hash: "#/create-room", fab: true },
    { id: "chats", icon: "fa-solid fa-comments", label: "Chats", hash: "#/my-rooms" },
    { id: "profile", icon: "fa-solid fa-user", label: "Profile", hash: "#/profile" },
  ];
  navEl.innerHTML = `<div class="bottom-nav">
    ${items.map((i) => `
      <button class="nav-item ${i.fab ? "fab" : ""} ${activeRoute === i.id ? "active" : ""}" data-hash="${i.hash}">
        <span class="nav-icon"><i class="${i.icon}"></i></span>${i.label ? `<span>${i.label}</span>` : ""}
      </button>`).join("")}
  </div>`;
  navEl.querySelectorAll(".nav-item").forEach((btn) => { btn.onclick = () => go(btn.dataset.hash); });
}

// ============================================================
// Screen: Login / Sign up
// ============================================================
function renderLogin() {
  renderTopbar({});
  navEl.innerHTML = "";
  let mode = "signin";
  appEl.innerHTML = `
    <h1 class="page-title" id="formTitle">Welcome back</h1>
    <p class="page-sub" id="formSub">Sign in to manage your rooms and campaigns.</p>
    <div class="field"><label>Email</label><input type="email" id="email" placeholder="you@business.com"></div>
    <div class="field"><label>Password</label><input type="password" id="password" placeholder="At least 6 characters"></div>
    <p class="error-text" id="errorText"></p>
    <button class="btn btn-primary" id="submitBtn"><i class="fa-solid fa-right-to-bracket"></i> Sign In</button>
    <button class="btn btn-link" id="toggleBtn" style="width:100%;margin-top:8px;">New to adRoomie? Create an account</button>
  `;
  const errorText = document.getElementById("errorText");
  document.getElementById("toggleBtn").onclick = () => {
    mode = mode === "signin" ? "signup" : "signin";
    document.getElementById("formTitle").textContent = mode === "signup" ? "Create your account" : "Welcome back";
    document.getElementById("formSub").textContent = mode === "signup" ? "You'll set up your business profile next." : "Sign in to manage your rooms and campaigns.";
    document.getElementById("submitBtn").innerHTML = mode === "signup" ? `<i class="fa-solid fa-user-plus"></i> Create Account` : `<i class="fa-solid fa-right-to-bracket"></i> Sign In`;
    document.getElementById("toggleBtn").textContent = mode === "signup" ? "Already have an account? Sign in" : "New to adRoomie? Create an account";
  };
  document.getElementById("submitBtn").onclick = async () => {
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    errorText.classList.remove("show");
    try {
      if (mode === "signup") { await signUp(email, password); toast("Account created — verify your email when you can."); }
      else { await signIn(email, password); }
    } catch (e) {
      errorText.textContent = friendlyAuthError(e.code);
      errorText.classList.add("show");
    }
  };
}
function friendlyAuthError(code) {
  const map = {
    "auth/email-already-in-use": "That email's already registered — try signing in instead.",
    "auth/invalid-email": "That doesn't look like a valid email.",
    "auth/weak-password": "Password needs to be at least 6 characters.",
    "auth/invalid-credential": "Incorrect email or password.",
  };
  return map[code] || "Something went wrong — please try again.";
}

// ============================================================
// Screen 1: Create / Edit Profile
// ============================================================
function renderProfile() {
  renderTopbar({ title: state.business ? "Edit Profile" : "", back: !!state.business });
  renderBottomNav("profile");
  const b = state.business || {};
  const selectedPlatforms = new Set(b.platforms || []);
  const selectedAudience = new Set(b.audience || []);
  let photoURL = b.photoURL || null;

  appEl.innerHTML = `
    ${avatarHTML(b.photoURL ? b : null, "", true)}
    <input type="file" id="avatarInput" accept="image/*" style="display:none;">
    <h1 class="page-title">Complete Your Business Profile</h1>
    <p class="page-sub">Tell us about your business</p>
    <div class="field"><label>Business Name</label><input id="name" value="${esc(b.name)}" placeholder="e.g. Brown Beans Cafe"></div>
    <div class="field"><label>Category</label>
      <select id="category">
        <option value="">Select a category</option>
        ${CATEGORY_OPTIONS.map((c) => `<option ${b.category === c ? "selected" : ""}>${c}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Location</label><input id="location" value="${esc(b.location)}" placeholder="e.g. Kampala, Uganda"></div>
    <div class="field"><label>Target Audience</label>${renderChipGroup("audienceChips", AUDIENCE_OPTIONS, selectedAudience)}</div>
    <div class="field"><label>Monthly Ad Budget Range</label>
      <select id="budget">
        <option value="">Select a range</option>
        ${BUDGET_OPTIONS.map((r) => `<option ${b.budgetRange === r ? "selected" : ""}>${r}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Preferred Platforms</label>
      <div class="platform-picker" id="platformPicker">
        <div class="platform-chip ${selectedPlatforms.has("facebook") ? "selected" : ""}" data-p="facebook" title="Facebook"><i class="fa-brands fa-facebook-f"></i></div>
        <div class="platform-chip ${selectedPlatforms.has("instagram") ? "selected" : ""}" data-p="instagram" title="Instagram"><i class="fa-brands fa-instagram"></i></div>
        <div class="platform-chip ${selectedPlatforms.has("tiktok") ? "selected" : ""}" data-p="tiktok" title="TikTok"><i class="fa-brands fa-tiktok"></i></div>
      </div>
      <p class="hint">Meta (Facebook + Instagram) supported first. TikTok coming soon.</p>
    </div>
    <p class="error-text" id="errorText"></p>
    <button class="btn btn-primary" id="saveBtn"><i class="fa-solid fa-check"></i> Save & Continue</button>
    ${state.business ? `<button class="btn btn-danger-link" id="logoutBtn" style="width:100%;margin-top:10px;"><i class="fa-solid fa-arrow-right-from-bracket"></i> Log out</button>` : ""}
  `;

  document.querySelectorAll(".platform-chip").forEach((chip) => {
    chip.onclick = () => {
      const p = chip.dataset.p;
      selectedPlatforms.has(p) ? selectedPlatforms.delete(p) : selectedPlatforms.add(p);
      chip.classList.toggle("selected");
    };
  });
  wireChipGroup("audienceChips", selectedAudience);

  // --- Profile picture upload ---
  document.getElementById("avatarCircle").onclick = () => document.getElementById("avatarInput").click();
  document.getElementById("avatarInput").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    toast("Uploading photo...");
    try {
      photoURL = await uploadToCloudinary(file);
      document.getElementById("avatarCircle").innerHTML =
        `<img src="${photoURL}" alt="profile"><span class="edit-dot"><i class="fa-solid fa-pen"></i></span>`;
      toast("Photo updated!");
    } catch (err) {
      toast("Photo upload failed — try again.");
    }
  };

  if (state.business) document.getElementById("logoutBtn").onclick = () => logOut();

  document.getElementById("saveBtn").onclick = async () => {
    const errorText = document.getElementById("errorText");
    const name = document.getElementById("name").value.trim();
    const category = document.getElementById("category").value;
    const location = document.getElementById("location").value.trim();
    const budgetRange = document.getElementById("budget").value;
    if (!name || !category || !location || !budgetRange || selectedPlatforms.size === 0 || selectedAudience.size === 0) {
      errorText.textContent = "Please fill in every field, and pick at least one audience and platform.";
      errorText.classList.add("show");
      return;
    }
    await setDoc(doc(db, "businesses", state.user.uid), {
      uid: state.user.uid, name, category, location,
      audience: Array.from(selectedAudience), budgetRange,
      platforms: Array.from(selectedPlatforms), email: state.user.email,
      emailVerified: state.user.emailVerified,
      phone: b.phone || null, phoneVerified: false, // real OTP deferred — needs Firebase Blaze
      photoURL: photoURL || null,
      oneSignalPlayerId: b.oneSignalPlayerId || null,
      rating: b.rating || null, reviewCount: b.reviewCount || 0,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    state.business = await loadBusiness(state.user.uid);
    toast("Profile saved!");
    go("#/rooms");
  };
}

// ============================================================
// Screen 2: Browse Open Rooms (home)
// ============================================================
function renderRooms() {
  renderTopbar({});
  renderBottomNav("rooms");
  appEl.innerHTML = `
    <h1 class="page-title">Open Rooms</h1>
    <div class="search-bar"><i class="fa-solid fa-magnifying-glass"></i><input id="searchBox" placeholder="Search rooms or keywords"></div>
    <div class="filter-tabs">
      <button class="filter-tab active" data-f="all">All</button>
      <button class="filter-tab" data-f="recommended">Recommended</button>
      <button class="filter-tab" data-f="nearby">Nearby</button>
    </div>
    <div id="roomList">${loadingHTML("Loading rooms…")}</div>
  `;
  let filter = "all", searchTerm = "";
  document.querySelectorAll(".filter-tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".filter-tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active"); filter = t.dataset.f; draw();
    };
  });
  document.getElementById("searchBox").oninput = (e) => { searchTerm = e.target.value.toLowerCase(); draw(); };

  const q = query(collection(db, "rooms"), where("status", "==", "open"));
  let allRooms = [];
  const unsub = onSnapshot(q, async (snap) => {
    const rooms = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.createdBy !== state.user.uid);
    // Attach creator photo/name for the room card thumbnail
    allRooms = await Promise.all(rooms.map(async (r) => {
      const creator = await loadBusiness(r.createdBy);
      return { ...r, _creatorPhoto: creator?.photoURL, _creatorName: creator?.name };
    }));
    draw();
  });
  state.unsub.push(unsub);

  function draw() {
    let rooms = allRooms.map((r) => ({ ...r, _score: matchScore(state.business, r) }));
    if (filter === "recommended") rooms = rooms.filter((r) => r._score >= 50).sort((a, b) => b._score - a._score);
    if (filter === "nearby") rooms = rooms.filter((r) => (r.location || "").toLowerCase() === (state.business.location || "").toLowerCase());
    if (searchTerm) rooms = rooms.filter((r) => (r.goal + " " + (r.audience || []).join(" ")).toLowerCase().includes(searchTerm));
    const list = document.getElementById("roomList");
    if (!rooms.length) {
      list.innerHTML = `<div class="empty-state"><i class="fa-solid fa-folder-open big-icon"></i>No open rooms match yet.<br>Try a different filter, or create your own room.</div>`;
      return;
    }
    list.innerHTML = rooms.map((r) => `
      <div class="card room-card" data-id="${r.id}">
        <div class="thumb">${r._creatorPhoto ? `<img src="${r._creatorPhoto}">` : `<i class="fa-solid fa-store"></i>`}</div>
        <div class="info">
          <div class="row-top"><h3>${esc(r.goal)}</h3><span class="match-badge"><i class="fa-solid fa-bullseye"></i>${r._score}%</span></div>
          <div class="tag-row">${(r.platforms || []).map((p) => `<span class="tag"><i class="${platformIcon(p)}"></i> ${p}</span>`).join("")}</div>
          <div class="meta-line"><i class="fa-solid fa-sack-dollar"></i>${esc(r.budgetRange || "—")}</div>
          <div class="meta-line"><i class="fa-solid fa-location-dot"></i>${esc(r.location || "")}</div>
        </div>
      </div>`).join("");
    list.querySelectorAll(".room-card").forEach((c) => { c.onclick = () => go(`#/room/${c.dataset.id}`); });
  }
}

function renderMyRooms() {
  renderTopbar({});
  renderBottomNav("chats");
  appEl.innerHTML = `<h1 class="page-title">Your Rooms</h1><div id="list">${loadingHTML("Loading…")}</div>`;
  const qCreated = query(collection(db, "rooms"), where("createdBy", "==", state.user.uid));
  const qJoined = query(collection(db, "rooms"), where("partnerId", "==", state.user.uid));
  let created = [], joined = [];
  const draw = () => {
    const rooms = [...created, ...joined];
    const list = document.getElementById("list");
    if (!rooms.length) {
      list.innerHTML = `<div class="empty-state"><i class="fa-solid fa-comments big-icon"></i>No rooms yet.<br>Create one or request to join an open room.</div>`;
      return;
    }
    list.innerHTML = rooms.map((r) => `
      <div class="card room-card" data-id="${r.id}">
        <div class="thumb"><i class="fa-solid fa-store"></i></div>
        <div class="info">
          <div class="row-top"><h3>${esc(r.goal)}</h3><span class="status-pill status-${r.status}">${r.status}</span></div>
          <div class="meta-line"><i class="fa-solid fa-location-dot"></i>${esc(r.location || "")}</div>
        </div>
      </div>`).join("");
    list.querySelectorAll(".room-card").forEach((c) => { c.onclick = () => go(`#/room/${c.dataset.id}/chat`); });
  };
  state.unsub.push(onSnapshot(qCreated, (s) => { created = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }));
  state.unsub.push(onSnapshot(qJoined, (s) => { joined = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }));
}

// ============================================================
// Screen 3: Create Room
// ============================================================
function renderCreateRoom() {
  renderTopbar({ title: "Create Room", back: true });
  renderBottomNav("create");
  const selectedPlatforms = new Set();
  const selectedAudience = new Set(state.business.audience || []);
  const selectedPartnerTypes = new Set();

  appEl.innerHTML = `
    <h1 class="page-title">Post a Room</h1>
    <p class="page-sub">Set the terms up front so partners know exactly what they're joining.</p>
    <div class="field"><label>Campaign Goal</label><input id="goal" placeholder="e.g. Increase weekend footfall and sales"></div>
    <div class="field"><label>Target Audience</label>${renderChipGroup("audienceChips", AUDIENCE_OPTIONS, selectedAudience)}</div>
    <div class="field"><label>Budget Range (each partner)</label>
      <select id="budget"><option value="">Select a range</option>${BUDGET_OPTIONS.map((r) => `<option>${r}</option>`).join("")}</select>
    </div>
    <div class="field"><label>Campaign Duration</label>
      <select id="duration"><option value="">Select duration</option>${DURATION_OPTIONS.map((d) => `<option>${d}</option>`).join("")}</select>
    </div>
    <div class="field"><label>Platforms</label>
      <div class="platform-picker" id="platformPicker">
        <div class="platform-chip" data-p="facebook"><i class="fa-brands fa-facebook-f"></i></div>
        <div class="platform-chip" data-p="instagram"><i class="fa-brands fa-instagram"></i></div>
        <div class="platform-chip" data-p="tiktok"><i class="fa-brands fa-tiktok"></i></div>
      </div>
    </div>
    <div class="field"><label>Type of partner you're looking for</label>${renderChipGroup("partnerTypeChips", CATEGORY_OPTIONS, selectedPartnerTypes)}</div>
    <p class="error-text" id="errorText"></p>
    <button class="btn btn-primary" id="createBtn"><i class="fa-solid fa-plus"></i> Create Room</button>
  `;
  document.querySelectorAll(".platform-chip").forEach((chip) => {
    chip.onclick = () => { const p = chip.dataset.p; selectedPlatforms.has(p) ? selectedPlatforms.delete(p) : selectedPlatforms.add(p); chip.classList.toggle("selected"); };
  });
  wireChipGroup("audienceChips", selectedAudience);
  wireChipGroup("partnerTypeChips", selectedPartnerTypes);

  document.getElementById("createBtn").onclick = async () => {
    const errorText = document.getElementById("errorText");
    const goal = document.getElementById("goal").value.trim();
    const budgetRange = document.getElementById("budget").value;
    const duration = document.getElementById("duration").value;
    if (!goal || !budgetRange || !duration || selectedPlatforms.size === 0 || selectedAudience.size === 0 || selectedPartnerTypes.size === 0) {
      errorText.textContent = "Please fill in every field, and pick at least one audience, platform, and partner type.";
      errorText.classList.add("show"); return;
    }
    const ref = await addDoc(collection(db, "rooms"), {
      createdBy: state.user.uid, partnerId: null, status: "open",
      goal, audience: Array.from(selectedAudience), budgetRange, duration,
      partnerType: Array.from(selectedPartnerTypes),
      platforms: Array.from(selectedPlatforms),
      location: state.business.location, creatorCategory: state.business.category,
      campaignPlan: { goal, duration, platforms: Array.from(selectedPlatforms), budgetSplit: "50/50" },
      creatives: [], createdAt: serverTimestamp(),
    });
    toast("Room created!");
    go(`#/room/${ref.id}`);
  };
}

// ============================================================
// Screen 4/5: Room Details + Request to Join
// ============================================================
async function renderRoomDetails(roomId) {
  renderTopbar({ back: true });
  renderBottomNav("rooms");
  appEl.innerHTML = loadingHTML("Loading room…");
  const snap = await getDoc(doc(db, "rooms", roomId));
  if (!snap.exists()) { appEl.innerHTML = `<div class="empty-state">Room not found.</div>`; return; }
  const room = snap.data();
  const isOwner = room.createdBy === state.user.uid;
  const isPartner = room.partnerId === state.user.uid;
  if (isPartner || (isOwner && room.status !== "open")) { go(`#/room/${roomId}/chat`); return; }

  const score = matchScore(state.business, room);
  appEl.innerHTML = `
    <div class="room-hero"><i class="fa-solid fa-bullhorn"></i><span class="badge-overlay match-badge" style="position:absolute;top:10px;right:10px;"><i class="fa-solid fa-bullseye"></i>${score}%</span></div>
    <h1 class="page-title">${esc(room.goal)}</h1>
    <div class="tag-row">${(room.platforms || []).map((p) => `<span class="tag"><i class="${platformIcon(p)}"></i> ${p}</span>`).join("")}</div>

    <div class="detail-block"><h4><i class="fa-solid fa-users"></i> Target Audience</h4><p>${esc((room.audience || []).join(", "))}</p></div>
    <div class="detail-block"><h4><i class="fa-solid fa-sack-dollar"></i> Budget Range</h4><p>${esc(room.budgetRange)} (each partner)</p></div>
    <div class="detail-block"><h4><i class="fa-solid fa-calendar-days"></i> Campaign Duration</h4><p>${esc(room.duration)}</p></div>
    <div class="detail-block"><h4><i class="fa-solid fa-magnifying-glass"></i> Looking For</h4><p>${esc((room.partnerType || []).join(", ") || "Any compatible business")}</p></div>
    <div class="detail-block"><h4><i class="fa-solid fa-location-dot"></i> Location</h4><p>${esc(room.location)}</p></div>

    ${isOwner ? `<h2 class="section-title">Join Requests</h2><div id="reqList">${loadingHTML("Loading…")}</div>` : `<button class="btn btn-primary" id="joinBtn"><i class="fa-solid fa-paper-plane"></i> Request to Join Room</button>`}
  `;
  if (isOwner) wireIncomingRequests(roomId);
  else document.getElementById("joinBtn").onclick = () => go(`#/room/${roomId}/join`);
}

function wireIncomingRequests(roomId) {
  const unsub = onSnapshot(collection(db, "rooms", roomId, "requests"), async (snap) => {
    const reqs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.status === "pending");
    const list = document.getElementById("reqList");
    if (!list) return;
    if (!reqs.length) { list.innerHTML = `<p class="hint">No pending requests yet.</p>`; return; }
    const withNames = await Promise.all(reqs.map(async (r) => {
      const b = await getDoc(doc(db, "businesses", r.id));
      return { ...r, business: b.exists() ? b.data() : {} };
    }));
    list.innerHTML = withNames.map((r) => `
      <div class="card">
        <div class="partner-row">
          ${avatarHTML(r.business, "sm")}
          <div class="info"><div class="name">${esc(r.business.name)}</div><div class="sub">${esc(r.business.category || "")}</div></div>
        </div>
        ${r.message ? `<p class="meta-line">"${esc(r.message)}"</p>` : ""}
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button class="btn btn-primary btn-sm" data-a="accept" data-id="${r.id}"><i class="fa-solid fa-check"></i> Accept</button>
          <button class="btn btn-outline btn-sm" data-a="decline" data-id="${r.id}"><i class="fa-solid fa-xmark"></i> Decline</button>
        </div>
      </div>`).join("");
    list.querySelectorAll("button[data-a]").forEach((btn) => {
      btn.onclick = async () => {
        const requesterId = btn.dataset.id;
        if (btn.dataset.a === "accept") {
          await updateDoc(doc(db, "rooms", roomId, "requests", requesterId), { status: "accepted" });
          await updateDoc(doc(db, "rooms", roomId), { partnerId: requesterId, status: "negotiating" });
          const partnerBiz = await loadBusiness(requesterId);
          notifyPartner(partnerBiz?.oneSignalPlayerId, "Your request was accepted — let's plan the campaign!", "Room confirmed", `${location.origin}/#/room/${roomId}/chat`);
          toast("Partner added — room is now negotiating.");
          go(`#/room/${roomId}/chat`);
        } else {
          await updateDoc(doc(db, "rooms", roomId, "requests", requesterId), { status: "declined" });
          toast("Request declined. Room stays open for others.");
        }
      };
    });
  });
  state.unsub.push(unsub);
}

function renderJoinRequest(roomId) {
  renderTopbar({ title: "Request to Join", back: true });
  renderBottomNav("rooms");
  appEl.innerHTML = `
    <div style="text-align:center;padding:20px 0;">
      <div style="font-size:46px;color:var(--accent);"><i class="fa-solid fa-envelope-open-text"></i></div>
      <h1 class="page-title">Send a request to join this room?</h1>
      <p class="page-sub">Your message will be sent to the room owner for review.</p>
    </div>
    <div class="field"><label>Add a message (optional)</label>
      <textarea id="msg" rows="4" placeholder="Hi! We'd love to partner on this campaign..."></textarea>
    </div>
    <button class="btn btn-primary" id="sendBtn"><i class="fa-solid fa-paper-plane"></i> Send Request</button>
  `;
  document.getElementById("sendBtn").onclick = async () => {
    const message = document.getElementById("msg").value.trim();
    await setDoc(doc(db, "rooms", roomId, "requests", state.user.uid), { message, status: "pending", createdAt: serverTimestamp() });
    const roomSnap = await getDoc(doc(db, "rooms", roomId));
    const owner = await loadBusiness(roomSnap.data().createdBy);
    notifyPartner(owner?.oneSignalPlayerId, `${state.business.name} requested to join your room`, "New join request", `${location.origin}/#/room/${roomId}`);
    toast("Request sent!");
    go("#/rooms");
  };
}

// ============================================================
// Screen 5/6: Room Hub (Chat / Workspace / Launch / Track / Support)
// ============================================================
async function renderRoomHub(roomId, tab = "chat") {
  renderBottomNav("chats");
  appEl.innerHTML = loadingHTML("Loading room…");
  const snap = await getDoc(doc(db, "rooms", roomId));
  if (!snap.exists()) { appEl.innerHTML = `<div class="empty-state">Room not found.</div>`; return; }
  const room = { id: roomId, ...snap.data() };
  renderTopbar({ title: room.goal, back: true });
  if (room.status === "completed" && tab !== "review") { renderCampaignComplete(roomId, room); return; }

  const tabs = [
    { k: "chat", label: "Chat", icon: "fa-solid fa-comments" },
    { k: "workspace", label: "Workspace", icon: "fa-solid fa-briefcase" },
    { k: "launch", label: "Launch", icon: "fa-solid fa-rocket" },
    { k: "track", label: "Track", icon: "fa-solid fa-chart-line" },
    { k: "support", label: "Support", icon: "fa-solid fa-life-ring" },
  ];
  appEl.innerHTML = `
    <span class="status-pill status-${room.status}">${room.status}</span>
    <div class="tab-bar" id="tabBar">
      ${tabs.map((t) => `<button class="tab-item ${tab === t.k ? "active" : ""}" data-t="${t.k}"><i class="${t.icon}"></i>${t.label}</button>`).join("")}
    </div>
    <div id="tabContent"></div>
  `;
  document.querySelectorAll("#tabBar .tab-item").forEach((b) => { b.onclick = () => go(`#/room/${roomId}/${b.dataset.t}`); });

  const content = document.getElementById("tabContent");
  if (tab === "chat") renderChatTab(content, room);
  else if (tab === "workspace") renderWorkspaceTab(content, room);
  else if (tab === "launch") renderLaunchTab(content, room);
  else if (tab === "track") renderTrackTab(content, room);
  else if (tab === "support") renderSupportTab(content, room);
}

function renderChatTab(container, room) {
  container.innerHTML = `
    <div class="chat-scroll" id="chatScroll">${loadingHTML("Loading messages…")}</div>
    <div class="chat-input-bar">
      <button class="round-btn attach" id="attachBtn"><i class="fa-solid fa-paperclip"></i></button>
      <input type="file" id="fileInput" accept="image/*" style="display:none;">
      <input id="msgInput" placeholder="Type a message...">
      <button class="round-btn send" id="sendMsgBtn"><i class="fa-solid fa-paper-plane"></i></button>
    </div>
    ${room.status === "negotiating" ? `<button class="btn btn-secondary" id="agreeBtn" style="margin-top:12px;"><i class="fa-solid fa-handshake"></i> Mark as Agreement Reached</button>` : ""}
  `;
  const msgsQuery = query(collection(db, "rooms", room.id, "messages"), orderBy("createdAt", "asc"));
  const unsub = onSnapshot(msgsQuery, (snap) => {
    const scroll = document.getElementById("chatScroll");
    if (!scroll) return;
    const msgs = snap.docs.map((d) => d.data());
    scroll.innerHTML = msgs.length ? msgs.map((m) => `
      <div class="msg-row ${m.senderId === state.user.uid ? "mine" : "theirs"}">
        <div class="bubble">${m.imageUrl ? `<img src="${m.imageUrl}">` : ""}${m.text ? esc(m.text) : ""}</div>
      </div>`).join("") : `<div class="empty-state"><i class="fa-solid fa-comment-dots big-icon"></i>No messages yet — say hello!</div>`;
    scroll.scrollTop = scroll.scrollHeight;
  });
  state.unsub.push(unsub);

  const partnerIdField = room.createdBy === state.user.uid ? room.partnerId : room.createdBy;
  async function send(text, imageUrl) {
    await addDoc(collection(db, "rooms", room.id, "messages"), { senderId: state.user.uid, text: text || null, imageUrl: imageUrl || null, createdAt: serverTimestamp() });
    if (partnerIdField) {
      const partnerBiz = await loadBusiness(partnerIdField);
      notifyPartner(partnerBiz?.oneSignalPlayerId, text || "Sent a photo", `${state.business.name}`, `${location.origin}/#/room/${room.id}/chat`);
    }
  }
  document.getElementById("sendMsgBtn").onclick = async () => {
    const input = document.getElementById("msgInput");
    if (!input.value.trim()) return;
    const text = input.value.trim(); input.value = "";
    await send(text, null);
  };
  document.getElementById("attachBtn").onclick = () => document.getElementById("fileInput").click();
  document.getElementById("fileInput").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    toast("Uploading image...");
    const url = await uploadToCloudinary(file);
    await send(null, url);
  };
  if (room.status === "negotiating") {
    document.getElementById("agreeBtn").onclick = async () => {
      await updateDoc(doc(db, "rooms", room.id), { status: "confirmed" });
      toast("Partnership confirmed!");
      go(`#/room/${room.id}/workspace`);
    };
  }
}

function renderWorkspaceTab(container, room) {
  const otherId = room.createdBy === state.user.uid ? room.partnerId : room.createdBy;
  container.innerHTML = `
    <h2 class="section-title">Partners</h2>
    <div id="partnersBlock">${loadingHTML("Loading...")}</div>
    <h2 class="section-title">Campaign Plan</h2>
    <div class="checklist-item"><span class="check"><i class="fa-solid fa-circle-check"></i></span>Goal: ${esc(room.campaignPlan?.goal || room.goal)}</div>
    <div class="checklist-item"><span class="check"><i class="fa-solid fa-circle-check"></i></span>Duration: ${esc(room.campaignPlan?.duration || room.duration)}</div>
    <div class="checklist-item"><span class="check"><i class="fa-solid fa-circle-check"></i></span>Platforms: ${(room.campaignPlan?.platforms || room.platforms || []).join(", ")}</div>
    <div class="checklist-item"><span class="check"><i class="fa-solid fa-circle-check"></i></span>Creative Cost Split: ${esc(room.campaignPlan?.budgetSplit || "50/50")}</div>

    <h2 class="section-title">Creatives</h2>
    <div id="creativesGrid"></div>
    <div class="upload-dropzone" id="creativeDrop"><i class="fa-solid fa-cloud-arrow-up"></i><strong>Upload / Add Creative</strong>Or ask adRoomie for help — reply in Chat</div>
    <input type="file" id="creativeInput" accept="image/*" style="display:none;">

    ${room.status === "confirmed" || room.status === "running" ? `<button class="btn btn-primary" id="launchedBtn" style="margin-top:16px;"><i class="fa-solid fa-rocket"></i> We've launched our ads</button>` : ""}
  `;
  loadBusiness(otherId).then((b) => {
    document.getElementById("partnersBlock").innerHTML = `
      <div class="partner-row">${avatarHTML(state.business, "sm")}
        <div class="info"><div class="name">${esc(state.business.name)} (You)</div><div class="sub"><span class="active-dot"></span>Active</div></div></div>
      <div class="partner-row">${avatarHTML(b, "sm")}
        <div class="info"><div class="name">${esc(b?.name || "Partner")}</div><div class="sub"><span class="active-dot"></span>Active</div></div></div>`;
  });
  function drawCreatives() {
    document.getElementById("creativesGrid").innerHTML = (room.creatives || []).map((c) => `<img class="creative-thumb" src="${c.url}">`).join("") || "";
  }
  drawCreatives();
  document.getElementById("creativeDrop").onclick = () => document.getElementById("creativeInput").click();
  document.getElementById("creativeInput").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    toast("Uploading creative...");
    const url = await uploadToCloudinary(file);
    room.creatives = [...(room.creatives || []), { url, addedBy: state.user.uid }];
    await updateDoc(doc(db, "rooms", room.id), { creatives: room.creatives });
    drawCreatives();
    toast("Creative added!");
  };
  const launchedBtn = document.getElementById("launchedBtn");
  if (launchedBtn) launchedBtn.onclick = async () => {
    await updateDoc(doc(db, "rooms", room.id), { status: "running" });
    toast("Marked as running — good luck!");
    go(`#/room/${room.id}/track`);
  };
}

function renderLaunchTab(container, room) {
  container.innerHTML = `
    <h2 class="section-title">How it works (v1)</h2>
    <div class="how-it-works">
      <div class="step"><div class="box"><i class="fa-solid fa-store"></i></div><div class="label">Your Ad Account</div></div>
      <div class="arrow"><i class="fa-solid fa-arrow-right"></i></div>
      <div class="step"><div class="box"><i class="fa-solid fa-bullhorn"></i></div><div class="label">Same Creative, Partnership Ad</div></div>
      <div class="arrow"><i class="fa-solid fa-arrow-right"></i></div>
      <div class="step"><div class="box"><i class="fa-solid fa-house"></i></div><div class="label">Partner's Ad Account</div></div>
    </div>
    <div class="callout"><i class="fa-solid fa-shield-heart"></i><span>You run the ad. You pay Meta directly. Your partner does the same. adRoomie never touches your ad account or your money.</span></div>
    <h2 class="section-title">Next Steps</h2>
    <div class="checklist-item"><span class="num">1</span>Each business launches the ad from your own Meta ad account.</div>
    <div class="checklist-item"><span class="num">2</span>Use Meta Partnership Ads and tag each other so both Pages appear.</div>
    <div class="checklist-item"><span class="num">3</span>Share your ad links in Chat once live so your partner can confirm.</div>
    <p class="hint"><i class="fa-solid fa-circle-info"></i> Partnership Ad authorization codes expire — you may need to refresh them if the campaign runs long.</p>
  `;
}

function renderTrackTab(container, room) {
  container.innerHTML = `
    <h2 class="section-title">Share Your Results</h2>
    <p class="page-sub">Upload a screenshot from your Meta Ads Manager periodically — your partner and adRoomie will see it here.</p>
    <div class="upload-dropzone" id="resultsDrop"><i class="fa-solid fa-cloud-arrow-up"></i><strong>Upload Screenshot</strong>JPG, PNG up to 6MB</div>
    <input type="file" id="resultsInput" accept="image/*" style="display:none;">
    <div id="resultsGrid" style="margin-top:14px;"></div>
    ${room.status === "running" ? `<button class="btn btn-primary" id="completeBtn" style="margin-top:18px;"><i class="fa-solid fa-flag-checkered"></i> Mark Campaign Complete</button>` : ""}
  `;
  function drawResults() {
    document.getElementById("resultsGrid").innerHTML = (room.results || []).map((r) => `<img class="creative-thumb" src="${r.url}">`).join("");
  }
  drawResults();
  document.getElementById("resultsDrop").onclick = () => document.getElementById("resultsInput").click();
  document.getElementById("resultsInput").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    toast("Uploading screenshot...");
    const url = await uploadToCloudinary(file);
    room.results = [...(room.results || []), { url, uploadedBy: state.user.uid, at: Date.now() }];
    await updateDoc(doc(db, "rooms", room.id), { results: room.results });
    drawResults();
    toast("Saved!");
  };
  const completeBtn = document.getElementById("completeBtn");
  if (completeBtn) completeBtn.onclick = async () => {
    await updateDoc(doc(db, "rooms", room.id), { status: "completed" });
    toast("Campaign marked complete!");
    go(`#/room/${room.id}/complete`);
  };
}

function renderSupportTab(container, room) {
  container.innerHTML = `
    <h2 class="section-title">We're here to help if you face any issues</h2>
    <div class="card"><div class="checklist-item"><span class="check"><i class="fa-solid fa-user-tie"></i></span>Join Room as Moderator</div>
      <p class="hint">A member of the adRoomie team can join this room to help resolve a disagreement. This is always disclosed — nobody reads your chat without you knowing.</p>
      <button class="btn btn-outline btn-sm" id="modBtn"><i class="fa-solid fa-user-tie"></i> Request Moderator</button></div>
    <div class="card" style="margin-top:10px;"><div class="checklist-item"><span class="check"><i class="fa-solid fa-calendar-check"></i></span>Schedule a Check-in</div>
      <button class="btn btn-outline btn-sm" id="checkinBtn"><i class="fa-solid fa-calendar-check"></i> Schedule</button></div>
    <div class="card" style="margin-top:10px;"><div class="checklist-item"><span class="check"><i class="fa-solid fa-triangle-exclamation"></i></span>Report an Issue</div>
      <button class="btn btn-outline btn-sm" id="reportBtn"><i class="fa-solid fa-triangle-exclamation"></i> Report</button></div>
  `;
  document.getElementById("modBtn").onclick = async () => {
    await addDoc(collection(db, "rooms", room.id, "supportRequests"), { type: "moderator", requestedBy: state.user.uid, createdAt: serverTimestamp() });
    toast("Request sent — we'll join the chat shortly.");
  };
  document.getElementById("checkinBtn").onclick = async () => {
    await addDoc(collection(db, "rooms", room.id, "supportRequests"), { type: "checkin", requestedBy: state.user.uid, createdAt: serverTimestamp() });
    toast("Check-in requested!");
  };
  document.getElementById("reportBtn").onclick = async () => {
    const note = prompt("What's going wrong? (this goes straight to the adRoomie team)");
    if (note === null) return;
    await addDoc(collection(db, "rooms", room.id, "supportRequests"), { type: "issue", note, requestedBy: state.user.uid, createdAt: serverTimestamp() });
    toast("Thanks — we'll follow up.");
  };
}

// ============================================================
// Screen 10: Campaign Complete
// ============================================================
function renderCampaignComplete(roomId, room) {
  renderTopbar({ title: room.goal, back: true });
  appEl.innerHTML = `
    <div class="celebrate">
      <div class="icon-circle"><i class="fa-solid fa-check"></i></div>
      <h1 class="page-title">Campaign Completed!</h1>
      <p class="page-sub">Great job, partners. This room has been closed.</p>
      <button class="btn btn-outline" id="summaryBtn" style="margin-bottom:10px;"><i class="fa-solid fa-chart-simple"></i> View Summary</button>
      <button class="btn btn-primary" id="reviewBtn"><i class="fa-solid fa-star"></i> Leave a Review</button>
    </div>
  `;
  document.getElementById("summaryBtn").onclick = () => go(`#/room/${roomId}/track`);
  document.getElementById("reviewBtn").onclick = () => go(`#/room/${roomId}/review`);
}

// ============================================================
// Screen 11: Leave a Review
// ============================================================
async function renderReview(roomId) {
  renderTopbar({ title: "Rate Your Partner", back: true });
  const snap = await getDoc(doc(db, "rooms", roomId));
  const room = snap.data();
  const otherId = room.createdBy === state.user.uid ? room.partnerId : room.createdBy;
  const other = await loadBusiness(otherId);

  let rating = 0;
  appEl.innerHTML = `
    <div style="text-align:center;">
      ${avatarHTML(other, "", false)}
      <h1 class="page-title">How was your experience working with ${esc(other?.name)}?</h1>
    </div>
    <div class="star-picker" id="stars" style="justify-content:center;">
      ${[1,2,3,4,5].map((n) => `<span class="star" data-n="${n}"><i class="fa-solid fa-star"></i></span>`).join("")}
    </div>
    <div class="field"><textarea id="comment" rows="4" placeholder="Great communication and professional throughout!"></textarea></div>
    <button class="btn btn-primary" id="submitReviewBtn"><i class="fa-solid fa-paper-plane"></i> Submit Review</button>
  `;
  document.querySelectorAll("#stars .star").forEach((s) => {
    s.onclick = () => {
      rating = Number(s.dataset.n);
      document.querySelectorAll("#stars .star").forEach((x) => x.classList.toggle("filled", Number(x.dataset.n) <= rating));
    };
  });
  document.getElementById("submitReviewBtn").onclick = async () => {
    if (!rating) { toast("Please pick a star rating."); return; }
    await addDoc(collection(db, "reviews"), { roomId, reviewerId: state.user.uid, revieweeId: otherId, rating, comment: document.getElementById("comment").value.trim(), createdAt: serverTimestamp() });
    const revSnap = await getDocs(query(collection(db, "reviews"), where("revieweeId", "==", otherId)));
    const all = revSnap.docs.map((d) => d.data());
    const avg = all.reduce((s, r) => s + r.rating, 0) / all.length;
    await updateDoc(doc(db, "businesses", otherId), { rating: avg, reviewCount: all.length });
    toast("Review submitted!");
    go(`#/room/${roomId}/whatsnext`);
  };
}

function renderWhatsNext() {
  renderTopbar({});
  renderBottomNav("home");
  appEl.innerHTML = `
    <div class="celebrate">
      <div style="font-size:46px;color:var(--accent);"><i class="fa-solid fa-rocket"></i></div>
      <h1 class="page-title">What's Next?</h1>
      <p class="page-sub">Create a new room or explore more opportunities.</p>
      <button class="btn btn-primary" id="newRoomBtn" style="margin-bottom:10px;"><i class="fa-solid fa-plus"></i> Create New Room</button>
      <button class="btn btn-link" id="browseBtn">Browse Open Rooms <i class="fa-solid fa-arrow-right"></i></button>
    </div>
  `;
  document.getElementById("newRoomBtn").onclick = () => go("#/create-room");
  document.getElementById("browseBtn").onclick = () => go("#/rooms");
}

// ============================================================
// Router
// ============================================================
async function router() {
  clearListeners();
  if (!state.user) { renderLogin(); return; }
  if (!state.business) { renderProfile(); return; }

  const hash = window.location.hash || "#/rooms";
  const partsRaw = hash.replace(/^#\//, "").split("/");
  const [route, id, sub] = partsRaw;

  if (route === "rooms" || !route) renderRooms();
  else if (route === "my-rooms") renderMyRooms();
  else if (route === "profile") renderProfile();
  else if (route === "create-room") renderCreateRoom();
  else if (route === "room" && id && !sub) renderRoomDetails(id);
  else if (route === "room" && id && sub === "join") renderJoinRequest(id);
  else if (route === "room" && id && sub === "complete") { const s = await getDoc(doc(db, "rooms", id)); renderCampaignComplete(id, s.data()); }
  else if (route === "room" && id && sub === "review") renderReview(id);
  else if (route === "room" && id && sub === "whatsnext") renderWhatsNext();
  else if (route === "room" && id && sub) renderRoomHub(id, sub);
  else renderRooms();
}

window.addEventListener("hashchange", router);

// ============================================================
// Boot
// ============================================================
onAuthStateChanged(auth, async (user) => {
  state.user = user;
  state.business = user ? await loadBusiness(user.uid) : null;
  router();
  if (user && window.OneSignal) initOneSignal();
});

async function initOneSignal() {
  try {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    OneSignalDeferred.push(async (OneSignal) => {
      await OneSignal.init({ appId: ONESIGNAL_APP_ID });
      const id = await OneSignal.User.PushSubscription.id;
      if (id && state.business && state.business.oneSignalPlayerId !== id) {
        await updateDoc(doc(db, "businesses", state.user.uid), { oneSignalPlayerId: id });
      }
    });
  } catch (e) { console.warn("OneSignal init skipped:", e); }
}
