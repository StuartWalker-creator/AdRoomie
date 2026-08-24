// ============================================================
// adRoomie — single-file app logic
// Plain JS, hash-based router, Firebase modular SDK via CDN, Font Awesome icons.
//
// Nav map:
//   #/rooms    -> "Rooms" (home) — rooms you're actively part of
//   #/explore  -> "Explore" — browse open rooms posted by others
//   #/inbox    -> "Inbox" — join requests (incoming + sent) and notices
//   #/create-room -> Create Room
//   #/profile  -> Profile
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, sendEmailVerification, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, addDoc, updateDoc,
  collection, collectionGroup, query, where, orderBy, onSnapshot, serverTimestamp, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- CONFIG — fill in your real values ----------
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
const ONESIGNAL_APP_ID = "a0bcdf64-4d1a-4360-bc6e-1e01d14c6e5f";
// Your own Firebase Auth UID (Authentication → Users). Must also exist as a doc
// in the "admins" Firestore collection — that's what the security rules check.
// This constant is just for client-side display (relabeling your messages).
const ADMIN_UID = "SLIWNQz3e3hGPKMzGhfrTgMUFve2";
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
const shellEl = document.querySelector(".app-shell");

const state = { user: null, business: null, unsub: [], _scrollHandler: null, isAdmin: false };

// YouTube-style: hide the topbar on scroll-down, reveal it on scroll-up. Only
// wired while inside a room (see renderRoomHub) — everywhere else the topbar
// just stays put, no scroll listener attached.
let _lastScrollTop = 0;
function wireCollapsibleTopbar() {
  removeCollapsibleTopbar();
  _lastScrollTop = appEl.scrollTop;
  state._scrollHandler = () => {
    const st = appEl.scrollTop;
    if (Math.abs(st - _lastScrollTop) < 6) return; // ignore tiny jitters
    if (st > _lastScrollTop && st > 40) topbarEl.classList.add("collapsed"); // scrolling down
    else topbarEl.classList.remove("collapsed"); // scrolling up
    _lastScrollTop = st;
  };
  appEl.addEventListener("scroll", state._scrollHandler, { passive: true });
}
function removeCollapsibleTopbar() {
  if (state._scrollHandler) { appEl.removeEventListener("scroll", state._scrollHandler); state._scrollHandler = null; }
  topbarEl.classList.remove("collapsed");
}

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
function go(hash, opts = {}) {
  if (opts.replace) { history.replaceState(null, "", hash); router(); }
  else { window.location.hash = hash; }
}
function loadingHTML(msg) { return `<div class="loading-spin"><i class="fa-solid fa-circle-notch fa-spin"></i>${esc(msg || "Loading…")}</div>`; }

// ============================================================
// Invite links — someone clicks a shared "#/room/{id}" link before they're
// logged in. We can't show them the room (Firestore rules require auth), so
// we park the intended destination in sessionStorage, show a lightweight
// "you've been invited" prompt, and once they sign up/log in and (for new
// users) finish their profile, we send them straight there instead of the
// default Rooms screen. Consumed once, so it never hijacks normal navigation.
// ============================================================
const PENDING_ROUTE_KEY = "adroomie_pending_route";
function isInviteableRoute(hash) { return /^#\/room\/[^/]+$/.test(hash); }
function savePendingRoute(hash) { try { sessionStorage.setItem(PENDING_ROUTE_KEY, hash); } catch (e) {} }
function peekPendingRoute() { try { return sessionStorage.getItem(PENDING_ROUTE_KEY); } catch (e) { return null; } }
function consumePendingRoute() {
  try {
    const r = sessionStorage.getItem(PENDING_ROUTE_KEY);
    if (r) sessionStorage.removeItem(PENDING_ROUTE_KEY);
    return r;
  } catch (e) { return null; }
}

function renderInvitePrompt() {
  topbarEl.style.display = "none";
  topbarEl.innerHTML = "";
  navEl.innerHTML = "";
  appEl.classList.add("no-bottom-nav");
  appEl.innerHTML = `
    <div class="splash" style="min-height:82vh;">
      <div class="splash-logo"><i class="fa-solid fa-handshake"></i></div>
      <h1 class="splash-title" style="font-size:23px;">You've been invited to a room</h1>
      <p class="splash-blurb">
        Someone shared an adRoomie partnership room with you. Sign up (or log in,
        if you already have an account) and you'll be taken straight there.
      </p>
      <button class="btn btn-primary" id="inviteSignupBtn" style="width:100%;max-width:280px;">
        <i class="fa-solid fa-user-plus"></i> Create an account
      </button>
      <button class="btn btn-outline" id="inviteLoginBtn" style="width:100%;max-width:280px;margin-top:10px;">
        Already have an account? Log in
      </button>
    </div>
  `;
  document.getElementById("inviteSignupBtn").onclick = () => go("#/signup");
  document.getElementById("inviteLoginBtn").onclick = () => go("#/login");
}

// Generates a shareable link to a room and hands it to WhatsApp/etc. — via the
// native share sheet on mobile (which lists WhatsApp directly), or a clipboard
// copy as the desktop fallback.
async function shareRoomInvite(roomId, goal) {
  const link = `${location.origin}${location.pathname}#/room/${roomId}`;
  const text = `I'm looking for a business to team up with and co-run an ad campaign on adRoomie: "${goal}". Take a look and request to join: ${link}`;
  if (navigator.share) {
    try { await navigator.share({ title: "adRoomie invite", text }); return; }
    catch (e) { /* user cancelled the share sheet — that's fine, not an error */ if (e?.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Invite link copied — paste it into WhatsApp!");
  } catch (e) {
    toast("Couldn't copy automatically. Link: " + link);
  }
}

// WhatsApp-style short time, e.g. "10:32 AM". Handles the brief moment
// before Firestore's serverTimestamp() resolves (shows nothing, not an error).
function formatTime(ts) {
  if (!ts || typeof ts.toDate !== "function") return "";
  return ts.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
function renderChipGroup(containerId, options, selectedSet) {
  return `<div class="chip-picker" id="${containerId}">
    ${options.map((opt) => `<div class="chip ${selectedSet.has(opt) ? "selected" : ""}" data-v="${esc(opt)}">${esc(opt)}</div>`).join("")}
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

// Basic client-side check before we even try the network call — catches the
// most common "why did it fail" causes (wrong file type, huge file) instantly,
// instead of waiting on a round trip to Cloudinary just to say the same thing.
function validateImageFile(file) {
  if (!file.type || !file.type.startsWith("image/")) return "Please choose an image file (JPG, PNG, etc.).";
  if (file.size > 6 * 1024 * 1024) return "That image is over 6MB — please choose a smaller one.";
  return null;
}

async function uploadToCloudinary(file) {
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  let res;
  try {
    res = await fetch(url, { method: "POST", body: formData });
  } catch (networkErr) {
    // fetch() itself only throws on network-level failures (offline, DNS, CORS block) —
    // Cloudinary being down or misconfigured comes back as a normal (non-ok) response below.
    throw new Error("Couldn't reach the upload server — check your internet connection.");
  }
  // Cloudinary returns a JSON body with a real error message even on failure
  // (e.g. "Upload preset not found", "Invalid image file") — surface that instead
  // of a generic "Upload failed", so it's actually possible to diagnose from the toast.
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Upload failed (server said: ${res.status})`;
    throw new Error(msg);
  }
  if (!data?.secure_url) throw new Error("Upload succeeded but no image URL came back — try again.");
  return data.secure_url;
}

async function notifyPartner(playerId, message, title, url) {
  if (!playerId) return;
  try {
    await fetch("/api/send-notification", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, message, title, url }),
    });
  } catch (e) { console.warn("Notification failed:", e); }
}

// Pings you directly whenever a business requests support — you go through the
// same profile/OneSignal setup as everyone else, so this just reuses that.
async function notifyAdmin(message, title, url) {
  if (!ADMIN_UID || ADMIN_UID === "YOUR_FIREBASE_AUTH_UID") return; // not configured yet
  const admin = await loadBusiness(ADMIN_UID);
  notifyPartner(admin?.oneSignalPlayerId, message, title, url);
}

// ============================================================
// Mutual-confirmation button — both partners must check their own
// side before a stage actually advances. Used for "Mark as Agreement
// Reached", "We've launched our ads", and "Mark Campaign Complete" —
// none of those should be flippable by just one partner.
// ============================================================
function myRole(room) { return room.createdBy === state.user.uid ? "creator" : "partner"; }

function renderConfirmButton(container, room, field, label, nextStatus, nextTab) {
  const conf = room[field] || { creator: false, partner: false };
  const role = myRole(room);
  const other = role === "creator" ? "partner" : "creator";
  const mine = conf[role], theirs = conf[other];

  let html;
  if (mine && theirs) {
    html = `<button class="btn btn-secondary" disabled><i class="fa-solid fa-circle-check"></i> Confirmed by both partners</button>`;
  } else if (mine && !theirs) {
    html = `<button class="btn btn-outline" id="confirmBtn"><i class="fa-solid fa-square-check"></i> Waiting for your partner to confirm…</button>`;
  } else {
    html = `<button class="btn btn-primary" id="confirmBtn"><i class="fa-regular fa-square"></i> ${label}</button>`;
  }
  container.innerHTML = html;

  const btn = document.getElementById("confirmBtn");
  if (!btn) return;
  btn.onclick = async () => {
    const updated = { ...conf, [role]: !mine };
    await updateDoc(doc(db, "rooms", room.id), { [field]: updated });
    room[field] = updated;
    if (updated.creator && updated.partner) {
      await updateDoc(doc(db, "rooms", room.id), { status: nextStatus });
      toast("Both confirmed — moving on!");
      go(`#/room/${room.id}/${nextTab}`);
    } else {
      renderConfirmButton(container, room, field, label, nextStatus, nextTab);
    }
  };
}

// Simple rule-based match score (no AI) — approximates the blueprint's weights:
// Audience 40 / Industry 25 / Location 15 / Budget 10 / Platform 10.
// "Complementary industry" uses a placeholder heuristic (different category = good)
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
  await sendEmailVerification(cred.user);
  return cred.user;
}
async function signIn(email, password) { return (await signInWithEmailAndPassword(auth, email, password)).user; }
function logOut() { return signOut(auth); }
async function loadBusiness(uid) {
  const snap = await getDoc(doc(db, "businesses", uid));
  return snap.exists() ? snap.data() : null;
}

// ============================================================
// Shared request accept/decline (used by both Room Details and Inbox)
// ============================================================
async function acceptRequest(roomId, requesterId) {
  await updateDoc(doc(db, "rooms", roomId, "requests", requesterId), { status: "accepted" });
  await updateDoc(doc(db, "rooms", roomId), { partnerId: requesterId, status: "negotiating" });
  const partnerBiz = await loadBusiness(requesterId);
  notifyPartner(partnerBiz?.oneSignalPlayerId, "Your request was accepted — let's plan the campaign!", "Room confirmed", `${location.origin}/#/room/${roomId}/chat`);
  toast("Partner added — room is now negotiating.");
  go(`#/room/${roomId}/chat`);
}
async function declineRequest(roomId, requesterId) {
  await updateDoc(doc(db, "rooms", roomId, "requests", requesterId), { status: "declined" });
  toast("Request declined. Room stays open for others.");
}

// ============================================================
// Chrome: topbar + bottom nav
// ============================================================
function renderTopbar({ title, back, actions, right } = {}) {
  topbarEl.style.display = "";
  topbarEl.innerHTML = `
    <div class="left">
      ${back ? `<button class="back-btn" id="backBtn"><i class="fa-solid fa-chevron-left"></i></button>` : ""}
      ${title ? `<strong>${esc(title)}</strong>` : `<div class="brand"><i class="fa-solid fa-handshake"></i> adRoomie</div>`}
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      ${right || ""}
      ${!title ? `<span class="beta-badge">BETA</span>` : ""}
      ${(actions || []).map((a) => `<button class="icon-btn" id="${a.id}"><i class="${a.icon}"></i></button>`).join("")}
    </div>`;
  if (back) document.getElementById("backBtn").onclick = () => window.history.back();
  (actions || []).forEach((a) => { document.getElementById(a.id).onclick = a.onClick; });
}

function renderBottomNav(activeRoute) {
  if (!state.user || !state.business) { navEl.innerHTML = ""; return; }
  const items = [
    { id: "rooms", icon: "fa-solid fa-house", label: "Rooms", hash: "#/rooms" },
    { id: "explore", icon: "fa-solid fa-compass", label: "Explore", hash: "#/explore" },
    { id: "create", icon: "fa-solid fa-plus", label: "", hash: "#/create-room", fab: true },
    { id: "inbox", icon: "fa-solid fa-inbox", label: "Inbox", hash: "#/inbox" },
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
// Screen: Landing page (logged-out visitors only)
// ============================================================
function renderLanding() {
  topbarEl.style.display = "none";
  topbarEl.innerHTML = "";
  navEl.innerHTML = "";
  appEl.classList.add("no-bottom-nav");
  shellEl.classList.add("landing-wide");

  const whyCards = [
    ["fa-solid fa-people-arrows", "Split ad costs, not results", "Share the creative cost. Each runs their own ad. You both reach more."],
    ["fa-solid fa-bullhorn", "Reach new audiences", "Tap into your partner's audience and gain new customers."],
    ["fa-solid fa-handshake", "Perfect for complementary businesses", "Different businesses. Same customers. Stronger together."],
    ["fa-solid fa-bullseye", "One plan. Two brands.", "One ad. Two promotions. Both brands appear in the ad."],
    ["fa-solid fa-arrow-trend-up", "More impact. Less spend.", "Get more visibility for your budget. Better results, together."],
    ["fa-solid fa-shield-halved", "Safe, simple and transparent", "Verified businesses, clear communication, and honest reviews."],
  ];
  const steps = [
    ["Create or Join a Room", "Share your campaign goal and find a compatible partner."],
    ["Discuss & Agree", "Plan together: goals, audience, budget and creative."],
    ["Create Together", "Collaborate on one great ad that represents both brands."],
    ["Run Your Own Ads", "Each business runs the ad from their own ad account using the shared creative."],
    ["Track & Review", "Track performance, share results and review each other."],
    ["Grow & Repeat", "Build stronger partnerships and run more successful campaigns together."],
  ];

  appEl.innerHTML = `
    <div class="landing-topbar">
      <div class="brand"><i class="fa-solid fa-handshake"></i> adRoomie</div>
      <div class="actions">
        <button class="btn btn-outline" id="loginBtn">Log in</button>
        <button class="btn btn-primary" id="signupBtn">Sign up free</button>
      </div>
    </div>

    <div class="hero-flex">
      <div class="hero-copy">
        <div class="hero-badge"><i class="fa-solid fa-sparkles"></i> The smarter way to advertise</div>
        <h1 class="hero-title">No more struggling with ad costs.<br><span class="accent">Advertise together.</span><br>Reach <span class="accent">more.</span></h1>
        <p class="hero-sub">adRoomie connects two compatible businesses so you can create one great ad, share the cost, and promote it to each other's audience. More customers. Less cost. Together, you win.</p>

        <button class="btn btn-primary" id="heroCtaBtn"><i class="fa-solid fa-arrow-right"></i> Get started for free</button>
        <button class="btn btn-outline" id="howItWorksBtn" style="width:100%;margin-top:8px;"><i class="fa-solid fa-play"></i> See how it works</button>

        <div style="margin-top:22px;">
          <div class="trust-row-item"><div class="icon-wrap"><i class="fa-solid fa-shield-halved"></i></div>
            <div><div class="name">Safe & trusted</div><div class="sub">Verified businesses & reviews.</div></div></div>
          <div class="trust-row-item"><div class="icon-wrap"><i class="fa-solid fa-people-group"></i></div>
            <div><div class="name">Built for collaboration</div><div class="sub">One room. One plan. Two businesses.</div></div></div>
          <div class="trust-row-item"><div class="icon-wrap"><i class="fa-solid fa-sack-dollar"></i></div>
            <div><div class="name">Save on ad costs</div><div class="sub">Split creative cost. Each pays their own ads.</div></div></div>
        </div>
      </div>

      <div class="hero-visual">
        <div class="card hero-preview-card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
            <div class="avatar-circle sm" style="background:#8b5e34;"><i class="fa-solid fa-mug-hot"></i></div>
            <span style="font-weight:700;color:var(--text-muted);">+</span>
            <div class="avatar-circle sm" style="background:#2e7d5b;"><i class="fa-solid fa-book"></i></div>
            <span class="status-pill status-negotiating" style="margin-left:auto;">Negotiating</span>
          </div>
          <div style="font-weight:700;font-size:13.5px;">Brew Haven Café × PageTurners Bookstore</div>
          <p class="hint" style="margin:4px 0 0;">Share one ad. Reach both audiences.</p>
        </div>
      </div>
    </div>

    <p class="section-label">Why businesses choose</p>
    <h2 class="section-heading">Why businesses choose <span class="accent" style="color:var(--accent);">adRoomie</span></h2>
    <div class="badge-grid">
      ${whyCards.map((c) => `
        <div class="card badge-card"><div class="icon-wrap"><i class="${c[0]}"></i></div><h4>${c[1]}</h4><p>${c[2]}</p></div>
      `).join("")}
    </div>

    <div id="howItWorksSection">
      <p class="section-label">How it works</p>
      <h2 class="section-heading">6 simple steps to powerful partnerships</h2>
      <div class="steps-grid">
        ${steps.map((s, i) => `
          <div class="step-card">
            <div class="step-num">${i + 1}</div>
            <div><h4>${s[0]}</h4><p>${s[1]}</p></div>
          </div>`).join("")}
      </div>
    </div>

    <div class="closing-card">
      <div class="icon-circle-lg"><i class="fa-solid fa-heart"></i></div>
      <h3>Built to help small businesses grow</h3>
      <p>We believe every small business deserves to be seen. adRoomie makes advertising affordable, collaborative and effective — so you can focus on what you do best.</p>
      <button class="btn btn-primary" id="ctaSignupBtn"><i class="fa-solid fa-plus"></i> Create your first room</button>
      <p class="fine-print">It's free. No card required.</p>
    </div>

    <p class="landing-footer">© 2026 adRoomie · Grow together. Advertise together.</p>
  `;

  document.getElementById("loginBtn").onclick = () => go("#/login");
  document.getElementById("signupBtn").onclick = () => go("#/signup");
  document.getElementById("heroCtaBtn").onclick = () => go("#/signup");
  document.getElementById("ctaSignupBtn").onclick = () => go("#/signup");
  document.getElementById("howItWorksBtn").onclick = () => {
    document.getElementById("howItWorksSection").scrollIntoView({ behavior: "smooth" });
  };
}

// ============================================================
// Screen: Login / Sign up (reached from the landing page)
// ============================================================
function renderLogin(initialMode = "signin") {
  renderTopbar({ back: true });
  navEl.innerHTML = "";
  let mode = initialMode;
  appEl.innerHTML = `
    <h1 class="page-title" id="formTitle">${mode === "signup" ? "Create your account" : "Welcome back"}</h1>
    <p class="page-sub" id="formSub">${mode === "signup" ? "You'll set up your business profile next." : "Sign in to manage your rooms and campaigns."}</p>
    <div class="field"><label>Email</label><input type="email" id="email" placeholder="you@business.com"></div>
    <div class="field"><label>Password</label><input type="password" id="password" placeholder="At least 6 characters"></div>
    <p class="error-text" id="errorText"></p>
    <button class="btn btn-primary" id="submitBtn">${mode === "signup" ? `<i class="fa-solid fa-user-plus"></i> Create Account` : `<i class="fa-solid fa-right-to-bracket"></i> Sign In`}</button>
    <button class="btn btn-link" id="toggleBtn" style="width:100%;margin-top:8px;">${mode === "signup" ? "Already have an account? Sign in" : "New to adRoomie? Create an account"}</button>
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
// Screen: Create / Edit Profile
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
      <select id="category"><option value="">Select a category</option>
        ${CATEGORY_OPTIONS.map((c) => `<option ${b.category === c ? "selected" : ""}>${c}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Location</label><input id="location" value="${esc(b.location)}" placeholder="e.g. Kampala, Uganda"></div>
    <div class="field"><label>Target Audience</label>${renderChipGroup("audienceChips", AUDIENCE_OPTIONS, selectedAudience)}</div>
    <div class="field"><label>Monthly Ad Budget Range</label>
      <select id="budget"><option value="">Select a range</option>
        ${BUDGET_OPTIONS.map((r) => `<option ${b.budgetRange === r ? "selected" : ""}>${r}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Preferred Platforms</label>
      <div class="platform-picker" id="platformPicker">
        <div class="platform-chip ${selectedPlatforms.has("facebook") ? "selected" : ""}" data-p="facebook"><i class="fa-brands fa-facebook-f"></i></div>
        <div class="platform-chip ${selectedPlatforms.has("instagram") ? "selected" : ""}" data-p="instagram"><i class="fa-brands fa-instagram"></i></div>
        <div class="platform-chip ${selectedPlatforms.has("tiktok") ? "selected" : ""}" data-p="tiktok"><i class="fa-brands fa-tiktok"></i></div>
      </div>
      <p class="hint">Meta (Facebook + Instagram) supported first. TikTok coming soon.</p>
    </div>
    <p class="error-text" id="errorText"></p>
    <button class="btn btn-primary" id="saveBtn"><i class="fa-solid fa-check"></i> Save & Continue</button>
    ${state.isAdmin ? `<button class="btn btn-secondary" id="adminBtn" style="width:100%;margin-top:10px;"><i class="fa-solid fa-gauge"></i> Admin Dashboard</button>` : ""}
    ${state.business ? `<button class="btn btn-danger-link" id="logoutBtn" style="width:100%;margin-top:10px;"><i class="fa-solid fa-arrow-right-from-bracket"></i> Log out</button>` : ""}
  `;
  if (state.isAdmin) document.getElementById("adminBtn").onclick = () => go("#/admin");
  document.querySelectorAll(".platform-chip").forEach((chip) => {
    chip.onclick = () => { const p = chip.dataset.p; selectedPlatforms.has(p) ? selectedPlatforms.delete(p) : selectedPlatforms.add(p); chip.classList.toggle("selected"); };
  });
  wireChipGroup("audienceChips", selectedAudience);

  document.getElementById("avatarCircle").onclick = () => document.getElementById("avatarInput").click();
  document.getElementById("avatarInput").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const validationError = validateImageFile(file);
    if (validationError) { toast(validationError); e.target.value = ""; return; }
    toast("Uploading photo...");
    try {
      photoURL = await uploadToCloudinary(file);
      document.getElementById("avatarCircle").innerHTML = `<img src="${photoURL}" alt="profile"><span class="edit-dot"><i class="fa-solid fa-pen"></i></span>`;
      toast("Photo updated!");
    } catch (err) {
      toast(err.message || "Photo upload failed — try again.");
      console.error("Avatar upload failed:", err);
    }
    e.target.value = ""; // allow re-selecting the same file if they try again
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
      phone: b.phone || null, phoneVerified: false,
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
// Screen: Rooms (HOME) — rooms you're actively part of
// ============================================================
function renderMyRooms() {
  renderTopbar({});
  renderBottomNav("rooms");
  appEl.innerHTML = `<h1 class="page-title">Your Rooms</h1><p class="page-sub">Rooms you're currently working on.</p><div id="list">${loadingHTML("Loading…")}</div>`;
  const qCreated = query(collection(db, "rooms"), where("createdBy", "==", state.user.uid));
  const qJoined = query(collection(db, "rooms"), where("partnerId", "==", state.user.uid));
  let created = [], joined = [];
  const draw = () => {
    const rooms = [...created, ...joined];
    const list = document.getElementById("list");
    if (!rooms.length) {
      list.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-people-roof big-icon"></i>
          No active rooms yet.<br>Explore open rooms to join one, or create your own.
          <button class="btn btn-primary" id="goExplore" style="margin-top:16px;"><i class="fa-solid fa-compass"></i> Explore Open Rooms</button>
          <button class="btn btn-outline" id="goCreate" style="margin-top:8px;"><i class="fa-solid fa-plus"></i> Create a Room</button>
        </div>`;
      document.getElementById("goExplore").onclick = () => go("#/explore");
      document.getElementById("goCreate").onclick = () => go("#/create-room");
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
// Screen: Explore — browse open rooms posted by others
// ============================================================
function renderExplore() {
  renderTopbar({});
  renderBottomNav("explore");
  appEl.innerHTML = `
    <h1 class="page-title">Explore Rooms</h1>
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
    allRooms = await Promise.all(rooms.map(async (r) => {
      const creator = await loadBusiness(r.createdBy);
      return { ...r, _creatorPhoto: creator?.photoURL };
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

// ============================================================
// Screen: Inbox — join requests (incoming + sent) and notices
// ============================================================
async function renderInbox() {
  renderTopbar({});
  renderBottomNav("inbox");
  appEl.innerHTML = `
    <h1 class="page-title">Inbox</h1>
    <p class="page-sub">Requests to your rooms, and updates on rooms you've asked to join.</p>
    <h2 class="section-title"><i class="fa-solid fa-inbox"></i> Requests to your rooms</h2>
    <div id="incomingList">${loadingHTML("Loading…")}</div>
    <h2 class="section-title"><i class="fa-solid fa-paper-plane"></i> Your sent requests</h2>
    <div id="sentList">${loadingHTML("Loading…")}</div>
    <p class="hint" style="margin-top:18px;"><i class="fa-solid fa-circle-info"></i>
      Other updates — new messages, agreements reached, campaigns completed — arrive as push notifications for now.
      A full in-app activity log is a natural next addition.
    </p>
  `;

  // --- Incoming: all pending requests across rooms you created ---
  const qMyRooms = query(collection(db, "rooms"), where("createdBy", "==", state.user.uid));
  state.unsub.push(onSnapshot(qMyRooms, async (snap) => {
    const myRooms = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const incomingEl = document.getElementById("incomingList");
    if (!incomingEl) return;
    let allPending = [];
    for (const room of myRooms) {
      const reqSnap = await getDocs(query(collection(db, "rooms", room.id, "requests"), where("status", "==", "pending")));
      for (const rDoc of reqSnap.docs) {
        const biz = await loadBusiness(rDoc.id);
        allPending.push({ roomId: room.id, roomGoal: room.goal, requesterId: rDoc.id, business: biz, message: rDoc.data().message });
      }
    }
    if (!allPending.length) { incomingEl.innerHTML = `<p class="hint">No pending requests right now.</p>`; return; }
    incomingEl.innerHTML = allPending.map((r) => `
      <div class="card">
        <div class="partner-row">
          ${avatarHTML(r.business, "sm")}
          <div class="info"><div class="name">${esc(r.business?.name)}</div><div class="sub">wants to join "${esc(r.roomGoal)}"</div></div>
        </div>
        ${r.message ? `<p class="meta-line">"${esc(r.message)}"</p>` : ""}
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button class="btn btn-primary btn-sm" data-room="${r.roomId}" data-req="${r.requesterId}" data-a="accept"><i class="fa-solid fa-check"></i> Accept</button>
          <button class="btn btn-outline btn-sm" data-room="${r.roomId}" data-req="${r.requesterId}" data-a="decline"><i class="fa-solid fa-xmark"></i> Decline</button>
        </div>
      </div>`).join("");
    incomingEl.querySelectorAll("button[data-a]").forEach((btn) => {
      btn.onclick = () => btn.dataset.a === "accept"
        ? acceptRequest(btn.dataset.room, btn.dataset.req)
        : declineRequest(btn.dataset.room, btn.dataset.req).then(() => renderInbox());
    });
  }));

  // --- Sent: requests you've made to other businesses' rooms ---
  const qSent = query(collectionGroup(db, "requests"), where("requesterId", "==", state.user.uid));
  try {
    const sentSnap = await getDocs(qSent);
    const sentEl = document.getElementById("sentList");
    if (!sentSnap.docs.length) { sentEl.innerHTML = `<p class="hint">You haven't requested to join any rooms yet.</p>`; return; }
    const sent = await Promise.all(sentSnap.docs.map(async (d) => {
      const data = d.data();
      const roomSnap = await getDoc(doc(db, "rooms", data.roomId));
      return { ...data, id: d.id, room: roomSnap.exists() ? roomSnap.data() : null };
    }));
    sentEl.innerHTML = sent.map((r) => `
      <div class="card room-card" data-room="${r.roomId}">
        <div class="thumb"><i class="fa-solid fa-store"></i></div>
        <div class="info">
          <div class="row-top"><h3>${esc(r.room?.goal || "Room")}</h3><span class="status-pill status-${r.status}">${r.status}</span></div>
          <div class="meta-line"><i class="fa-solid fa-location-dot"></i>${esc(r.room?.location || "")}</div>
        </div>
      </div>`).join("");
    sentEl.querySelectorAll(".room-card").forEach((c) => {
      c.onclick = () => go(c.dataset.room ? `#/room/${c.dataset.room}` : "#/inbox");
    });
  } catch (e) {
    // Two different causes land here, and they need different fixes:
    // 1) failed-precondition — first-ever run of this query; Firestore's console
    //    error includes a one-click "create index" link.
    // 2) permission-denied — a firestore.rules issue, not an index issue. Fix the
    //    rules (see the /requests match block) and redeploy them.
    const isIndexIssue = e?.code === "failed-precondition";
    document.getElementById("sentList").innerHTML = isIndexIssue
      ? `<p class="hint">Can't load sent requests yet — check the browser console for a Firestore index link (one-time setup).</p>`
      : `<p class="hint">Can't load sent requests right now — there's a permissions issue on our end, not something on your side.</p>`;
    console.warn(`Inbox sent-requests query failed (${e?.code || "unknown"}):`, e);
  }
}

// ============================================================
// Screen: Create Room
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
    <div class="card" style="display:flex;gap:10px;align-items:flex-start;">
      <input type="checkbox" id="ownershipCheck" style="margin-top:3px;width:16px;height:16px;flex-shrink:0;">
      <label for="ownershipCheck" style="font-size:12.5px;color:var(--text-muted);font-weight:400;">
        Either business may keep and reuse the shared creative after this campaign ends.
        Neither business may stop the other from using it.
      </label>
    </div>
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
    if (!document.getElementById("ownershipCheck").checked) {
      errorText.textContent = "Please confirm the creative-ownership terms before creating the room.";
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
// Screen: Room Details + Request to Join
// ============================================================
async function renderRoomDetails(roomId) {
  renderTopbar({ back: true });
  renderBottomNav("explore");
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
    ${isOwner ? `
      <button class="btn btn-outline" id="inviteBtn" style="width:100%;margin-bottom:16px;"><i class="fa-solid fa-share-nodes"></i> Invite a Business to This Room</button>
      <h2 class="section-title">Join Requests</h2><div id="reqList">${loadingHTML("Loading…")}</div>
    ` : `<button class="btn btn-primary" id="joinBtn"><i class="fa-solid fa-paper-plane"></i> Request to Join Room</button>`}
  `;
  if (isOwner) {
    wireIncomingRequests(roomId);
    document.getElementById("inviteBtn").onclick = () => shareRoomInvite(roomId, room.goal);
  }
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
      btn.onclick = () => btn.dataset.a === "accept" ? acceptRequest(roomId, btn.dataset.id) : declineRequest(roomId, btn.dataset.id);
    });
  });
  state.unsub.push(unsub);
}

function renderJoinRequest(roomId) {
  renderTopbar({ title: "Request to Join", back: true });
  renderBottomNav("explore");
  appEl.innerHTML = `
    <div style="text-align:center;padding:20px 0;">
      <div style="font-size:46px;color:var(--accent);"><i class="fa-solid fa-envelope-open-text"></i></div>
      <h1 class="page-title">Send a request to join this room?</h1>
      <p class="page-sub">Your message will be sent to the room owner for review. You'll be able to track its status in your Inbox.</p>
    </div>
    <div class="field"><label>Add a message (optional)</label>
      <textarea id="msg" rows="4" placeholder="Hi! We'd love to partner on this campaign..."></textarea>
    </div>
    <button class="btn btn-primary" id="sendBtn"><i class="fa-solid fa-paper-plane"></i> Send Request</button>
  `;
  document.getElementById("sendBtn").onclick = async () => {
    const message = document.getElementById("msg").value.trim();
    await setDoc(doc(db, "rooms", roomId, "requests", state.user.uid), {
      message, status: "pending", requesterId: state.user.uid, roomId, createdAt: serverTimestamp(),
    });
    const roomSnap = await getDoc(doc(db, "rooms", roomId));
    const owner = await loadBusiness(roomSnap.data().createdBy);
    notifyPartner(owner?.oneSignalPlayerId, `${state.business.name} requested to join your room`, "New join request", `${location.origin}/#/room/${roomId}`);
    toast("Request sent! Track it in your Inbox.");
    go("#/inbox");
  };
}

// ============================================================
// Room Hub (Chat / Workspace / Launch / Track / Support)
// ============================================================
async function renderRoomHub(roomId, tab = "chat") {
  appEl.innerHTML = loadingHTML("Loading room…");
  const snap = await getDoc(doc(db, "rooms", roomId));
  if (!snap.exists()) { appEl.innerHTML = `<div class="empty-state">Room not found.</div>`; return; }
  const room = { id: roomId, ...snap.data() };

  if (room.status === "completed" && tab !== "review" && tab !== "track") { renderCampaignComplete(roomId, room); return; }

  // Immersive room mode: no bottom nav (the back arrow exits, same as most chat apps),
  // and the topbar collapses on scroll-down / reappears on scroll-up.
  navEl.innerHTML = "";
  appEl.classList.add("no-bottom-nav");
  renderTopbar({ title: room.goal, back: true, right: `<span class="status-pill status-${room.status}">${room.status}</span>` });

  const tabs = [
    { k: "chat", label: "Chat", icon: "fa-solid fa-comments" },
    { k: "workspace", label: "Workspace", icon: "fa-solid fa-briefcase" },
    { k: "launch", label: "Launch", icon: "fa-solid fa-rocket" },
    { k: "track", label: "Track", icon: "fa-solid fa-chart-line" },
    { k: "support", label: "Support", icon: "fa-solid fa-life-ring" },
  ];
  appEl.innerHTML = `
    <div class="tab-bar" id="tabBar">
      ${tabs.map((t) => `<button class="tab-item ${tab === t.k ? "active" : ""}" data-t="${t.k}"><i class="${t.icon}"></i>${t.label}</button>`).join("")}
    </div>
    <div id="tabContent"></div>
  `;
  document.querySelectorAll("#tabBar .tab-item").forEach((b) => { b.onclick = () => go(`#/room/${roomId}/${b.dataset.t}`, { replace: true }); });
  wireCollapsibleTopbar();

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
    ${room.status === "negotiating" ? `<div id="agreeBtnWrap" style="margin-top:12px;"></div>` : ""}
  `;
  const msgsQuery = query(collection(db, "rooms", room.id, "messages"), orderBy("createdAt", "asc"));
  const unsub = onSnapshot(msgsQuery, (snap) => {
    const scroll = document.getElementById("chatScroll");
    if (!scroll) return;
    const msgs = snap.docs.map((d) => d.data());
    scroll.innerHTML = msgs.length ? msgs.map((m) => {
      const isAdminMsg = m.senderId === ADMIN_UID;
      return `
      <div class="msg-row ${m.senderId === state.user.uid ? "mine" : "theirs"}">
        ${isAdminMsg ? `<div class="admin-tag"><i class="fa-solid fa-shield-halved"></i> adRoomie Support</div>` : ""}
        <div class="bubble ${isAdminMsg ? "admin-bubble" : ""}">${m.imageUrl ? `<img src="${m.imageUrl}">` : ""}${m.text ? esc(m.text) : ""}</div>
        <div class="msg-time">${formatTime(m.createdAt)}</div>
      </div>`;
    }).join("") : `<div class="empty-state"><i class="fa-solid fa-comment-dots big-icon"></i>No messages yet — say hello!</div>`;
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
    const validationError = validateImageFile(file);
    if (validationError) { toast(validationError); e.target.value = ""; return; }
    toast("Uploading image...");
    try {
      const url = await uploadToCloudinary(file);
      await send(null, url);
    } catch (err) {
      toast(err.message || "Image upload failed — try again.");
      console.error("Chat image upload failed:", err);
    }
    e.target.value = "";
  };
  if (room.status === "negotiating") {
    renderConfirmButton(document.getElementById("agreeBtnWrap"), room, "agreementConfirmed", "Mark as Agreement Reached", "confirmed", "workspace");
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
    ${room.status === "confirmed" ? `<div id="launchBtnWrap" style="margin-top:16px;"></div>` : ""}
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
    const validationError = validateImageFile(file);
    if (validationError) { toast(validationError); e.target.value = ""; return; }
    toast("Uploading creative...");
    try {
      const url = await uploadToCloudinary(file);
      room.creatives = [...(room.creatives || []), { url, addedBy: state.user.uid }];
      await updateDoc(doc(db, "rooms", room.id), { creatives: room.creatives });
      drawCreatives();
      toast("Creative added!");
    } catch (err) {
      toast(err.message || "Creative upload failed — try again.");
      console.error("Creative upload failed:", err);
    }
    e.target.value = "";
  };
  if (room.status === "confirmed") {
    renderConfirmButton(document.getElementById("launchBtnWrap"), room, "launchConfirmed", "We've launched our ads", "running", "track");
  }
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

    <h2 class="section-title"><i class="fa-solid fa-clipboard-check"></i> Before you start</h2>
    <div class="checklist-item"><span class="check"><i class="fa-solid fa-circle-check"></i></span>Each business needs its own Facebook Page (not just a personal profile).</div>
    <div class="checklist-item"><span class="check"><i class="fa-solid fa-circle-check"></i></span>That Page should be connected to Meta Business Suite.</div>
    <div class="checklist-item"><span class="check"><i class="fa-solid fa-circle-check"></i></span>Instagram account linked too, if you're running ads there as well.</div>
    <a href="https://business.facebook.com" target="_blank" rel="noopener" class="btn btn-outline" style="margin-top:6px;">
      <i class="fa-solid fa-arrow-up-right-from-square"></i> Open Meta Business Suite
    </a>
    <p class="hint">Don't have a Page yet? Meta Business Suite will walk you through creating one — it's free.</p>

    <h2 class="section-title"><i class="fa-solid fa-people-arrows"></i> The two roles, explained</h2>
    <p class="page-sub" style="margin-bottom:14px;">
      Meta's Partnership Ads tool wasn't built with two equal businesses in mind — it's built around a "creator" tagging a "brand." To get the mirrored setup this room needs, <strong>each of you plays both roles once</strong>, tagging the other.
    </p>
    <div class="card" style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <div class="icon-wrap" style="width:28px;height:28px;font-size:12px;"><i class="fa-solid fa-tag"></i></div>
        <strong style="font-size:13.5px;">Role 1 — Tagging your partner</strong>
      </div>
      <p class="hint" style="margin:0;">In Meta's settings, this is called being the "creator." You turn on branded content tools and tag your partner's Page as a paid partnership — this is what lets them include you in their ad.</p>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <div class="icon-wrap" style="width:28px;height:28px;font-size:12px;"><i class="fa-solid fa-rectangle-ad"></i></div>
        <strong style="font-size:13.5px;">Role 2 — Building your own ad</strong>
      </div>
      <p class="hint" style="margin:0;">Meta calls this the "brand" or "advertiser." You request partnership access to your partner's Page, they accept, and then you build and pay for your own ad using the shared creative, with their Page tagged alongside yours.</p>
    </div>

    <h2 class="section-title">Step by step</h2>
    <div class="checklist-item"><span class="num">1</span>Both businesses turn on branded content / partnership tools for their Page (Meta Business Suite → Page settings).</div>
    <div class="checklist-item"><span class="num">2</span>Each of you sends the other a partnership request — in Ads Manager, look for <strong>Partnership Ads Hub</strong> under "All tools."</div>
    <div class="checklist-item"><span class="num">3</span>Accept each other's requests. This is the step that actually links your two Pages.</div>
    <div class="checklist-item"><span class="num">4</span>Each business builds their own ad, using the shared creative from the Workspace tab, and selects their partner as the tagged identity.</div>
    <div class="checklist-item"><span class="num">5</span>Publish. Each of you is now running your own ad, paid from your own account, with both Pages appearing on it.</div>
    <div class="checklist-item"><span class="num">6</span>Share your ad link in Chat once live, so your partner can confirm theirs matches.</div>

    <p class="hint"><i class="fa-solid fa-circle-info"></i> Partnership Ad authorization codes expire — you may need to refresh them if the campaign runs long.</p>
    <p class="hint"><i class="fa-solid fa-triangle-exclamation"></i> Meta renames and moves things fairly often. If a menu doesn't match exactly, search "Partnership Ads" inside Meta Business Suite's help — the concept above stays the same even when the button locations move.</p>
  `;
}

function renderTrackTab(container, room) {
  container.innerHTML = `
    <h2 class="section-title">Share Your Results</h2>
    <p class="page-sub">Upload a screenshot from your Meta Ads Manager periodically — your partner and adRoomie will see it here.</p>
    <div class="upload-dropzone" id="resultsDrop"><i class="fa-solid fa-cloud-arrow-up"></i><strong>Upload Screenshot</strong>JPG, PNG up to 6MB</div>
    <input type="file" id="resultsInput" accept="image/*" style="display:none;">
    <div id="resultsGrid" style="margin-top:14px;"></div>
    ${room.status === "running" ? `<div id="completeBtnWrap" style="margin-top:18px;"></div>` : ""}
  `;
  function drawResults() {
    document.getElementById("resultsGrid").innerHTML = (room.results || []).map((r) => `<img class="creative-thumb" src="${r.url}">`).join("");
  }
  drawResults();
  document.getElementById("resultsDrop").onclick = () => document.getElementById("resultsInput").click();
  document.getElementById("resultsInput").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const validationError = validateImageFile(file);
    if (validationError) { toast(validationError); e.target.value = ""; return; }
    toast("Uploading screenshot...");
    try {
      const url = await uploadToCloudinary(file);
      room.results = [...(room.results || []), { url, uploadedBy: state.user.uid, at: Date.now() }];
      await updateDoc(doc(db, "rooms", room.id), { results: room.results });
      drawResults();
      toast("Saved!");
    } catch (err) {
      toast(err.message || "Screenshot upload failed — try again.");
      console.error("Results upload failed:", err);
    }
    e.target.value = "";
  };
  if (room.status === "running") {
    renderConfirmButton(document.getElementById("completeBtnWrap"), room, "completeConfirmed", "Mark Campaign Complete", "completed", "complete");
  }
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
    notifyAdmin(`${state.business.name} requested a moderator in "${room.goal}"`, "Moderator requested", `${location.origin}/#/room/${room.id}/chat`);
    toast("Request sent — we'll join the chat shortly.");
  };
  document.getElementById("checkinBtn").onclick = async () => {
    await addDoc(collection(db, "rooms", room.id, "supportRequests"), { type: "checkin", requestedBy: state.user.uid, createdAt: serverTimestamp() });
    notifyAdmin(`${state.business.name} requested a check-in on "${room.goal}"`, "Check-in requested", `${location.origin}/#/room/${room.id}/chat`);
    toast("Check-in requested!");
  };
  document.getElementById("reportBtn").onclick = async () => {
    const note = prompt("What's going wrong? (this goes straight to the adRoomie team)");
    if (note === null) return;
    await addDoc(collection(db, "rooms", room.id, "supportRequests"), { type: "issue", note, requestedBy: state.user.uid, createdAt: serverTimestamp() });
    notifyAdmin(`${state.business.name} reported an issue in "${room.goal}": ${note}`, "Issue reported", `${location.origin}/#/room/${room.id}/chat`);
    toast("Thanks — we'll follow up.");
  };
}

// ============================================================
// Campaign Complete + Review + What's Next
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
    // Note: we deliberately don't write a rolled-up average onto the reviewee's own
    // business doc here — the rules correctly forbid writing another business's
    // profile (otherwise anyone could fake anyone's rating). A safe rollup needs
    // either a live aggregation query wherever a rating is displayed, or a Cloud
    // Function trigger — both deferred for now since nowhere in the UI shows it yet.
    toast("Review submitted!");
    go(`#/room/${roomId}/whatsnext`);
  };
}

function renderWhatsNext() {
  renderTopbar({});
  renderBottomNav("rooms");
  appEl.innerHTML = `
    <div class="celebrate">
      <div style="font-size:46px;color:var(--accent);"><i class="fa-solid fa-rocket"></i></div>
      <h1 class="page-title">What's Next?</h1>
      <p class="page-sub">Create a new room or explore more opportunities.</p>
      <button class="btn btn-primary" id="newRoomBtn" style="margin-bottom:10px;"><i class="fa-solid fa-plus"></i> Create New Room</button>
      <button class="btn btn-link" id="browseBtn">Explore Open Rooms <i class="fa-solid fa-arrow-right"></i></button>
    </div>
  `;
  document.getElementById("newRoomBtn").onclick = () => go("#/create-room");
  document.getElementById("browseBtn").onclick = () => go("#/explore");
}

// ============================================================
// Screen: Admin Dashboard (visible only if admins/{uid} exists)
// ============================================================
async function renderAdmin() {
  if (!state.isAdmin) { go("#/rooms"); return; }
  renderTopbar({ title: "Admin", back: true });
  renderBottomNav("profile");
  appEl.innerHTML = `
    <h1 class="page-title">Admin Dashboard</h1>
    <p class="page-sub">Visible only to you — this is where the numbers and requests that don't show up anywhere else in the app actually live.</p>
    <h2 class="section-title"><i class="fa-solid fa-trophy"></i> Partnership funnel</h2>
    <div id="statsBlock">${loadingHTML("Loading stats…")}</div>
    <h2 class="section-title"><i class="fa-solid fa-life-ring"></i> Support requests</h2>
    <div id="supportFeed">${loadingHTML("Loading…")}</div>
    <h2 class="section-title"><i class="fa-solid fa-layer-group"></i> All rooms</h2>
    <div id="allRoomsList">${loadingHTML("Loading…")}</div>
  `;

  // --- Partnership funnel (the North Star metric, made visible) ---
  const allRoomsSnap = await getDocs(collection(db, "rooms"));
  const rooms = allRoomsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const counts = { open: 0, negotiating: 0, confirmed: 0, running: 0, completed: 0 };
  rooms.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status]++; });
  const launched = counts.running + counts.completed;
  document.getElementById("statsBlock").innerHTML = `
    <div class="card">
      <div class="checklist-item"><span class="check"><i class="fa-solid fa-trophy"></i></span>
        <span><strong>${launched}</strong> room${launched === 1 ? "" : "s"} reached a launched campaign — your North Star number</span>
      </div>
      <div class="meta-line" style="margin-top:6px;">
        Open: ${counts.open} · Negotiating: ${counts.negotiating} · Confirmed: ${counts.confirmed} · Running: ${counts.running} · Completed: ${counts.completed}
      </div>
    </div>
  `;

  // --- Support requests, aggregated across every room (the thing that was going into a void) ---
  const feedEl = document.getElementById("supportFeed");
  try {
    const supSnap = await getDocs(query(collectionGroup(db, "supportRequests"), orderBy("createdAt", "desc")));
    if (!supSnap.docs.length) {
      feedEl.innerHTML = `<p class="hint">No support requests yet.</p>`;
    } else {
      const items = await Promise.all(supSnap.docs.map(async (d) => {
        const data = d.data();
        const roomId = d.ref.parent.parent.id;
        const roomSnap = await getDoc(doc(db, "rooms", roomId));
        const biz = await loadBusiness(data.requestedBy);
        return { ...data, roomId, roomGoal: roomSnap.exists() ? roomSnap.data().goal : "Room", bizName: biz?.name };
      }));
      const iconMap = { moderator: "fa-user-tie", checkin: "fa-calendar-check", issue: "fa-triangle-exclamation" };
      feedEl.innerHTML = items.map((it) => `
        <div class="card room-card" data-room="${it.roomId}">
          <div class="thumb"><i class="fa-solid ${iconMap[it.type] || "fa-bell"}"></i></div>
          <div class="info">
            <div class="row-top"><h3 style="text-transform:capitalize;">${esc(it.type)}</h3></div>
            <div class="meta-line">${esc(it.bizName || "Someone")} · "${esc(it.roomGoal)}"</div>
            ${it.note ? `<div class="meta-line">"${esc(it.note)}"</div>` : ""}
          </div>
        </div>`).join("");
      feedEl.querySelectorAll(".room-card").forEach((c) => { c.onclick = () => go(`#/room/${c.dataset.room}/chat`); });
    }
  } catch (e) {
    feedEl.innerHTML = `<p class="hint">Can't load yet — check the browser console for a Firestore index link (one-time setup, same pattern as Inbox).</p>`;
    console.warn("Admin support feed needs an index:", e);
  }

  // --- Every room, regardless of who owns it ---
  document.getElementById("allRoomsList").innerHTML = rooms.map((r) => `
    <div class="card room-card" data-id="${r.id}">
      <div class="thumb"><i class="fa-solid fa-store"></i></div>
      <div class="info">
        <div class="row-top"><h3>${esc(r.goal)}</h3><span class="status-pill status-${r.status}">${r.status}</span></div>
        <div class="meta-line"><i class="fa-solid fa-location-dot"></i>${esc(r.location || "")}</div>
      </div>
    </div>`).join("");
  document.getElementById("allRoomsList").querySelectorAll(".room-card").forEach((c) => {
    c.onclick = () => go(`#/room/${c.dataset.id}/chat`);
  });
}

// ============================================================
// Router
// ============================================================
async function router() {
  clearListeners();
  removeCollapsibleTopbar();
  appEl.classList.remove("no-bottom-nav");
  shellEl.classList.remove("landing-wide");

  if (!state.user) {
    const h = window.location.hash;
    if (h === "#/login") renderLogin("signin");
    else if (h === "#/signup") renderLogin("signup");
    else if (isInviteableRoute(h)) { savePendingRoute(h); renderInvitePrompt(); }
    else renderLanding();
    return;
  }
  if (!state.business) { renderProfile(); return; }

  // Logged in, profile exists — if an invite link was waiting from before
  // auth, send them there now instead of the default screen. Consumed once.
  const pending = peekPendingRoute();
  if (pending && window.location.hash !== pending) { consumePendingRoute(); go(pending, { replace: true }); return; }
  if (pending) consumePendingRoute();

  const hash = window.location.hash || "#/rooms";
  const partsRaw = hash.replace(/^#\//, "").split("/");
  const [route, id, sub] = partsRaw;

  if (route === "rooms" || !route) renderMyRooms();
  else if (route === "explore") renderExplore();
  else if (route === "inbox") renderInbox();
  else if (route === "admin") renderAdmin();
  else if (route === "profile") renderProfile();
  else if (route === "create-room") renderCreateRoom();
  else if (route === "room" && id && !sub) renderRoomDetails(id);
  else if (route === "room" && id && sub === "join") renderJoinRequest(id);
  else if (route === "room" && id && sub === "complete") { const s = await getDoc(doc(db, "rooms", id)); renderCampaignComplete(id, s.data()); }
  else if (route === "room" && id && sub === "review") renderReview(id);
  else if (route === "room" && id && sub === "whatsnext") renderWhatsNext();
  else if (route === "room" && id && sub) renderRoomHub(id, sub);
  else renderMyRooms();
}

window.addEventListener("hashchange", router);

// ============================================================
// Boot
// ============================================================
onAuthStateChanged(auth, async (user) => {
  state.user = user;
  state.business = user ? await loadBusiness(user.uid) : null;
  state.isAdmin = user ? await checkIsAdmin(user.uid) : false;
  router();
  if (user) initOneSignal();
});

async function checkIsAdmin(uid) {
  try {
    const snap = await getDoc(doc(db, "admins", uid));
    return snap.exists();
  } catch (e) { return false; } // not an admin, or rules blocked it — either way, treat as non-admin
}

async function initOneSignal() {
  try {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    OneSignalDeferred.push(async (OneSignal) => {
      await OneSignal.init({ appId: ONESIGNAL_APP_ID });
      // init() alone does NOT show the permission prompt on the current SDK —
      // it has to be requested explicitly, or Auto Prompt has to be enabled
      // in the OneSignal dashboard (Settings > Push & In-App > Web).
      const alreadyDecided = OneSignal.Notifications.permission !== "default";
      if (!alreadyDecided) {
        await OneSignal.Notifications.requestPermission();
      }
      const id = await OneSignal.User.PushSubscription.id;
      if (id && state.business && state.business.oneSignalPlayerId !== id) {
        await updateDoc(doc(db, "businesses", state.user.uid), { oneSignalPlayerId: id });
      }
    });
  } catch (e) { console.warn("OneSignal init skipped:", e); }
}
