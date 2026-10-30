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

const domain = window.location.origin;

const CATEGORY_OPTIONS = ["Cakes & Confectionery","Caterers","Planners & Decorators","Photographers & Videographers","Venues & Party Services","Restaurant / Cafe","Beauty & Wellness","Retail","Fitness / Health","Education","Services","Other"];
const BUDGET_OPTIONS = ["UGX 100,000 - 300,000","UGX 300,000 - 500,000","UGX 500,000 - 800,000","UGX 800,000+"];
const DURATION_OPTIONS = ["1 week","2 weeks","1 month"];
const AUDIENCE_OPTIONS = ["Engaged Couples / Weddings","Birthday & Party Hosts","Corporate Event Organisers","Parents (kids' parties)","Families","Young Adults (18-30)","Professionals","Students","Budget Shoppers","Luxury Shoppers","Foodies"];

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

// Lightweight modal — appended inside .app-shell (not document.body) so it
// stays confined to the phone-frame on desktop rather than covering the
// whole browser window. One at a time; opening a new one replaces the old.
function showModal(innerHTML) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "modalOverlay";
  overlay.innerHTML = `<div class="modal-card">${innerHTML}</div>`;
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  shellEl.appendChild(overlay);
}
function closeModal() {
  const el = document.getElementById("modalOverlay");
  if (el) el.remove();
}

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
function location_origin() { return window.location.origin; }
async function notifyAdmin(message, title, url) {
  if (!ADMIN_UID || ADMIN_UID === "YOUR_FIREBASE_AUTH_UID") return; // not configured yet
  if (state.user && state.user.uid === ADMIN_UID) return; // don't ping yourself about your own actions
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
      notifyAdmin(`Room "${room.goal}" moved to ${nextStatus}`, "Room stage changed", `${location_origin()}/#/room/${room.id}/chat`);
      toast("Both confirmed — moving on!");
      go(`#/room/${room.id}/${nextTab}`);
    } else {
      renderConfirmButton(container, room, field, label, nextStatus, nextTab);
    }
  };
}

// Simple rule-based match score (no AI) — a heuristic, NOT a probability of a
// successful collaboration. Weights: Audience 40 / Partner fit 25 / Location 15
// / Budget 10 / Platform 10.
// Partner fit uses the room creator's own "partnerType" choice: if they named
// the kinds of business they want, only a business in one of those categories
// earns the 25 points. If they left it open ("Any compatible business"), it
// falls back to the old placeholder (different category from the creator = ok)
// at a lower weight, since nothing was actually requested.
function matchDetails(business, room) {
  let score = 0;
  const reasons = [];
  const wanted = room.partnerType || [];
  const partnerSpecified = wanted.length > 0;
  const partnerMatch = partnerSpecified && wanted.includes(business.category);

  const bAud = new Set(business.audience || []);
  const rAud = new Set(room.audience || []);
  const overlap = [...bAud].filter((a) => rAud.has(a)).length;
  const audienceRatio = bAud.size ? overlap / Math.max(1, Math.min(bAud.size, rAud.size)) : 0;
  score += audienceRatio * 40;
  if (overlap > 0) reasons.push("Shared target audience");

  if (partnerSpecified) {
    if (partnerMatch) { score += 25; reasons.push("Matches the partner type requested"); }
  } else if (business.category && room.creatorCategory && business.category !== room.creatorCategory) {
    score += 12; reasons.push("Different category — open to any partner");
  }

  if (business.location && room.location && business.location.toLowerCase() === room.location.toLowerCase()) {
    score += 15; reasons.push("Same location");
  }
  if (business.budgetRange === room.budgetRange) { score += 10; reasons.push("Same budget range"); }
  else score += 4;
  if ((business.platforms || []).some((p) => (room.platforms || []).includes(p))) {
    score += 10; reasons.push("Uses a shared ad platform");
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, partnerSpecified, partnerMatch };
}
function matchScore(business, room) { return matchDetails(business, room).score; }

// Business-to-business recommendation (for people who haven't made a room yet).
// Same 40/25/15/10/10 weights; partner fit is two-way: 15 if the other business
// is a type I said I want, +10 if I'm a type they said they want.
function businessMatch(me, other) {
  let score = 0; const reasons = [];
  const mine = new Set(me.audience || []), theirs = new Set(other.audience || []);
  const overlap = [...mine].filter((a) => theirs.has(a)).length;
  const ratio = mine.size && theirs.size ? overlap / Math.min(mine.size, theirs.size) : 0;
  score += ratio * 40;
  if (overlap) reasons.push("Shared target audience");
  const iWant = (me.partnerTypes || []).includes(other.category);
  const theyWant = (other.partnerTypes || []).includes(me.category);
  if (iWant) { score += 15; reasons.push("A type of partner you're looking for"); }
  if (theyWant) { score += 10; reasons.push("Looking for a business like yours"); }
  if (me.location && other.location && me.location.toLowerCase() === other.location.toLowerCase()) { score += 15; reasons.push("Same location"); }
  if (me.budgetRange === other.budgetRange) { score += 10; reasons.push("Same budget range"); } else score += 4;
  if ((me.platforms || []).some((p) => (other.platforms || []).includes(p))) { score += 10; reasons.push("Uses a shared ad platform"); }
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, iWant, theyWant };
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
  notifyAdmin(`A partnership formed — ${partnerBiz?.name || "a business"} was accepted into a room`, "Partner accepted", `${location_origin()}/#/room/${roomId}/chat`);
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
  const selectedPartnerTypes = new Set(b.partnerTypes || []);
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
    <div class="field"><label>What does your business do?</label>
      <textarea id="description" rows="3" maxlength="300" placeholder="e.g. We bake custom cakes and cupcakes for birthdays and weddings in Kyengera.">${esc(b.description || "")}</textarea>
      <p class="hint">A line or two about your products or services — it helps us find you the right partner.</p>
    </div>
    <div class="field"><label>Location</label><input id="location" value="${esc(b.location)}" placeholder="e.g. Kampala, Uganda"></div>
    <div class="field"><label>Phone Contact</label>
      <input id="phoneInput" value="${esc(b.phone || "")}" placeholder="e.g. 0755 123456">
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;font-weight:500;">
        <input type="checkbox" id="phoneIsWhatsApp" ${b.phoneIsWhatsApp ? "checked" : ""} style="width:16px;height:16px;">
        This number is on WhatsApp
      </label>
      <p class="hint">Used for the "Message on WhatsApp" link the AI caption tool adds — toggle off if this number can only take calls/SMS, not WhatsApp.</p>
    </div>
    <div class="field"><label>Target Audience</label>${renderChipGroup("audienceChips", AUDIENCE_OPTIONS, selectedAudience)}</div>
    <div class="field"><label>Types of businesses you'd like to partner with</label>${renderChipGroup("partnerTypeChips", CATEGORY_OPTIONS, selectedPartnerTypes)}
      <p class="hint">We use this to recommend businesses and rooms that fit you.</p></div>
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
  wireChipGroup("partnerTypeChips", selectedPartnerTypes);
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
    const description = document.getElementById("description").value.trim();
    const budgetRange = document.getElementById("budget").value;
    if (!name || !category || !description || !location || !budgetRange || selectedPlatforms.size === 0 || selectedAudience.size === 0 || selectedPartnerTypes.size === 0) {
      errorText.textContent = "Please fill in every field, and pick at least one audience, partner type and platform.";
      errorText.classList.add("show");
      return;
    }
    const isNewProfile = !state.business?.name; // presence heartbeat can create a name-less stub doc first
    await setDoc(doc(db, "businesses", state.user.uid), {
      ...(isNewProfile ? { createdAt: serverTimestamp() } : {}),
      uid: state.user.uid, name, category, description, location,
      audience: Array.from(selectedAudience), partnerTypes: Array.from(selectedPartnerTypes), budgetRange,
      platforms: Array.from(selectedPlatforms), email: state.user.email,
      emailVerified: state.user.emailVerified,
      phone: document.getElementById("phoneInput").value.trim() || null,
      phoneIsWhatsApp: document.getElementById("phoneIsWhatsApp").checked,
      photoURL: photoURL || null,
      oneSignalPlayerId: b.oneSignalPlayerId || null,
      rating: b.rating || null, reviewCount: b.reviewCount || 0,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    state.business = await loadBusiness(state.user.uid);
    if (isNewProfile) notifyAdmin(`${name} (${category}, ${location}) just created a profile`, "New business profile", `${location_origin()}/#/admin`);
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
    <div class="filter-tabs" id="viewTabs">
      <button class="filter-tab active" data-v="rooms">Rooms</button>
      <button class="filter-tab" data-v="businesses">Businesses</button>
    </div>
    <div class="filter-tabs" id="roomFilters">
      <button class="filter-tab active" data-f="all">All</button>
      <button class="filter-tab" data-f="recommended">Recommended</button>
      <button class="filter-tab" data-f="nearby">Nearby</button>
    </div>
    <div id="roomList">${loadingHTML("Loading rooms…")}</div>
  `;
  let filter = "all", searchTerm = "", view = "rooms", allBiz = [];
  document.querySelectorAll("#roomFilters .filter-tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll("#roomFilters .filter-tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active"); filter = t.dataset.f; draw();
    };
  });
  document.querySelectorAll("#viewTabs .filter-tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll("#viewTabs .filter-tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active"); view = t.dataset.v;
      document.getElementById("roomFilters").style.display = view === "rooms" ? "" : "none";
      draw();
    };
  });
  state.unsub.push(onSnapshot(collection(db, "businesses"), (snap) => {
    allBiz = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.name && x.id !== state.user.uid && x.id !== ADMIN_UID);
    if (view === "businesses") draw();
  }));
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

  function drawBusinesses() {
    const list = document.getElementById("roomList");
    let items = allBiz.map((x) => ({ ...x, _m: businessMatch(state.business, x) }));
    if (searchTerm) items = items.filter((x) => `${x.name} ${x.category} ${x.description || ""} ${x.location || ""}`.toLowerCase().includes(searchTerm));
    items.sort((a, b) => b._m.score - a._m.score);
    if (!items.length) { list.innerHTML = `<div class="empty-state"><i class="fa-solid fa-store big-icon"></i>No other businesses yet.<br>New businesses appear here as they join.</div>`; return; }
    list.innerHTML = `<p class="hint">Recommended for you, best fit first. To partner with one, create a room and choose their type of business — they'll be able to find and join it.</p>` + items.map((x) => `
      <div class="card room-card">
        <div class="thumb">${x.photoURL ? `<img src="${x.photoURL}">` : `<i class="fa-solid fa-store"></i>`}</div>
        <div class="info">
          <div class="row-top"><h3>${esc(x.name)}</h3><span class="match-badge"><i class="fa-solid fa-bullseye"></i>${x._m.score}%</span></div>
          <div class="meta-line"><i class="fa-solid fa-tag"></i>${esc(x.category || "")} · <i class="fa-solid fa-location-dot"></i>${esc(x.location || "")}</div>
          ${x.description ? `<div class="meta-line">${esc(x.description)}</div>` : ""}
          ${x._m.reasons.length ? `<div class="meta-line"><i class="fa-solid fa-circle-check"></i>${esc(x._m.reasons.slice(0, 2).join(" · "))}</div>` : ""}
        </div>
      </div>`).join("");
  }
  function draw() {
    if (view === "businesses") { drawBusinesses(); return; }
    let rooms = allRooms.map((r) => { const m = matchDetails(state.business, r); return { ...r, _score: m.score, _reasons: m.reasons, _partnerOk: !m.partnerSpecified || m.partnerMatch }; });
    // Recommended: if the room asked for specific partner types, you must be one of them.
    if (filter === "recommended") rooms = rooms.filter((r) => r._partnerOk && r._score >= 50).sort((a, b) => b._score - a._score);
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
          ${r._reasons.length ? `<div class="meta-line"><i class="fa-solid fa-circle-check"></i>${esc(r._reasons.slice(0, 2).join(" · "))}</div>` : ""}
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
        <p class="meta-line" style="font-weight:600;color:var(--accent);"><i class="fa-solid fa-bullseye"></i> We found you a potential match for your ad room</p>
        <div class="partner-row">
          ${avatarHTML(r.business, "sm")}
          <div class="info"><div class="name">${esc(r.business?.name)}</div><div class="sub">wants to join "${esc(r.roomGoal)}"</div></div>
        </div>
        ${r.business?.description ? `<p class="meta-line">${esc(r.business.description)}</p>` : ""}
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
  const selectedPartnerTypes = new Set(state.business.partnerTypes || []);

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
    notifyAdmin(`${state.business.name} created a room: "${goal}"`, "New room", `${location_origin()}/#/admin`);
    showModal(`
      <div style="text-align:center;">
        <div style="font-size:42px;color:var(--success,#2e8b57);"><i class="fa-solid fa-circle-check"></i></div>
        <h3 style="margin:8px 0;">Success!</h3>
        <p>Your ad room is live. adRoomie is now finding you a match — we'll notify you the moment we do.</p>
        <button class="btn btn-primary" id="roomCreatedOk" style="width:100%;margin-top:12px;">Got it</button>
      </div>`);
    document.getElementById("roomCreatedOk").onclick = () => { closeModal(); go(`#/room/${ref.id}`); };
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

  const match = matchDetails(state.business, room);
  const score = match.score;
  appEl.innerHTML = `
    <div class="room-hero"><i class="fa-solid fa-bullhorn"></i><span class="badge-overlay match-badge" style="position:absolute;top:10px;right:10px;"><i class="fa-solid fa-bullseye"></i>${score}%</span></div>
    <h1 class="page-title">${esc(room.goal)}</h1>
    <div class="tag-row">${(room.platforms || []).map((p) => `<span class="tag"><i class="${platformIcon(p)}"></i> ${p}</span>`).join("")}</div>
    <div class="detail-block"><h4><i class="fa-solid fa-users"></i> Target Audience</h4><p>${esc((room.audience || []).join(", "))}</p></div>
    <div class="detail-block"><h4><i class="fa-solid fa-sack-dollar"></i> Budget Range</h4><p>${esc(room.budgetRange)} (each partner)</p></div>
    <div class="detail-block"><h4><i class="fa-solid fa-calendar-days"></i> Campaign Duration</h4><p>${esc(room.duration)}</p></div>
    <div class="detail-block"><h4><i class="fa-solid fa-magnifying-glass"></i> Looking For</h4><p>${esc((room.partnerType || []).join(", ") || "Any compatible business")}</p></div>
    ${!isOwner ? `<div class="detail-block"><h4><i class="fa-solid fa-bullseye"></i> Why this match (${score}% — a guide, not a guarantee)</h4><p>${match.reasons.length ? match.reasons.map(esc).join("<br>") : "No strong overlap with your profile."}${match.partnerSpecified && !match.partnerMatch ? "<br>Your category isn't one this room asked for." : ""}</p></div>` : ""}
    <div class="detail-block"><h4><i class="fa-solid fa-location-dot"></i> Location</h4><p>${esc(room.location)}</p></div>
    ${!isOwner ? `<div class="detail-block" id="aboutCreator" style="display:none;"><h4><i class="fa-solid fa-store"></i> About the business</h4><p></p></div>` : ""}
    ${isOwner ? `
      <button class="btn btn-outline" id="inviteBtn" style="width:100%;margin-bottom:16px;"><i class="fa-solid fa-share-nodes"></i> Invite a Business to This Room</button>
      <h2 class="section-title">Join Requests</h2><div id="reqList">${loadingHTML("Loading…")}</div>
    ` : `<button class="btn btn-primary" id="joinBtn"><i class="fa-solid fa-paper-plane"></i> Request to Join Room</button>`}
  `;
  if (isOwner) {
    wireIncomingRequests(roomId);
    document.getElementById("inviteBtn").onclick = () => shareRoomInvite(roomId, room.goal);
  }
  else {
    document.getElementById("joinBtn").onclick = () => go(`#/room/${roomId}/join`);
    loadBusiness(room.createdBy).then((cb) => {
      const el = document.getElementById("aboutCreator");
      if (el && cb?.description) { el.querySelector("p").textContent = `${cb.name ? cb.name + " — " : ""}${cb.description}`; el.style.display = ""; }
    });
  }
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
        <p class="meta-line" style="font-weight:600;color:var(--accent);"><i class="fa-solid fa-bullseye"></i> We found you a potential match for your ad room</p>
        ${r.business.description ? `<p class="meta-line">${esc(r.business.description)}</p>` : ""}
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
    notifyPartner(owner?.oneSignalPlayerId, `${state.business.name} wants to partner with you on "${roomSnap.data().goal}". Tap to review.`, "We found you a potential match for your ad room", `${location.origin}/#/room/${roomId}`);
    notifyAdmin(`${state.business.name} requested to join "${roomSnap.data().goal}"`, "New join request", `${location_origin()}/#/admin`);
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
      <button class="round-btn ai-caption" id="aiCaptionBtn" title="Generate a joint caption"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
      <input type="file" id="fileInput" accept="image/*" style="display:none;">
      <input id="msgInput" placeholder="Type a message...">
      <button class="round-btn send" id="sendMsgBtn"><i class="fa-solid fa-paper-plane"></i></button>
    </div>
    ${room.status === "negotiating" ? `<div id="agreeBtnWrap" style="margin-top:12px;"></div>` : ""}
  `;
  // One-time welcome per user per room (dismissible). Falls back to showing
  // each visit if browser storage is unavailable.
  if (!state.isAdmin) {
    const wKey = `adroomie_welcomed_${room.id}_${state.user.uid}`;
    let seen = false;
    try { seen = !!localStorage.getItem(wKey); } catch (e) {}
    if (!seen) {
      showModal(`
        <div style="text-align:center;">
          <div style="font-size:40px;color:var(--accent);"><i class="fa-solid fa-handshake"></i></div>
          <h3 style="margin:8px 0;">Welcome to your ad room</h3>
          <p>This is your shared space to talk with your partner about everything to do with your advertising collaboration — your goals, the offer, budget, creative and timing.</p>
          <button class="btn btn-primary" id="welcomeOk" style="width:100%;margin-top:12px;">Got it</button>
        </div>`);
      try { localStorage.setItem(wKey, "1"); } catch (e) {} // mark seen as soon as it shows, even if dismissed by tapping outside
      document.getElementById("welcomeOk").onclick = closeModal;
    }
  }
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
  document.getElementById("aiCaptionBtn").onclick = async () => {
    const partnerBiz = partnerIdField ? await loadBusiness(partnerIdField) : null;
    openCaptionGenerator(room, partnerBiz, partnerIdField);
  };
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

// ============================================================
// AI Caption Generator — calls a Netlify function (netlify/functions/
// generate-caption.js) which itself calls Google's Gemini API. Requires a
// GEMINI_API_KEY env var to be set on Netlify — see setup notes in that
// function file. Nothing here breaks if it's not configured yet; the error
// just surfaces in the modal instead of a caption.
// ============================================================
// Converts a stored phone number into a clickable contact link,
// deterministically — never trusts an AI model to format phone numbers,
// since that's exactly the kind of precise, low-tolerance-for-error task
// free/fast models get subtly wrong (missing digits, wrong country code,
// added dashes). Assumes Uganda local numbers (leading 0) unless already in
// international format. Returns a wa.me link only if the business actually
// toggled "this number is on WhatsApp" in their profile — otherwise a plain
// tel: link, since a wa.me link to a non-WhatsApp number just leads to a
// dead end for the customer.
function toContactLink(phone, isWhatsApp) {
  if (!phone) return null;
  let digits = String(phone).replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.startsWith("0")) digits = "256" + digits.slice(1);
  return isWhatsApp ? { url: `https://wa.me/${digits}`, label: "WhatsApp" } : { url: `tel:+${digits}`, label: "Call" };
}

function openCaptionGenerator(room, partnerBiz, partnerId) {
  const tracker = room.tracker;
  const hasCodes = tracker?.status === "confirmed";
  const myCode = hasCodes ? tracker.codes?.[state.user.uid] : null;
  const partnerCode = hasCodes ? tracker.codes?.[partnerId] : null;

  showModal(`
    <h3 style="margin:0 0 4px;">✨ Generate a Caption</h3>
    <p class="hint" style="margin:0 0 14px;">A ready-to-post caption for both of you — just describe the offer.</p>
    <div class="detail-block" style="margin-top:0;">
      <h4><i class="fa-solid fa-store"></i> Businesses</h4>
      <p>${esc(state.business.name)} × ${esc(partnerBiz?.name || "Partner")}</p>
    </div>
    ${!hasCodes ? `
      <div class="detail-block" style="background:var(--accent-light);">
        <h4><i class="fa-solid fa-tags"></i> No redemption codes yet</h4>
        <p style="margin-bottom:8px;">You haven't set up tracking codes for this room. Set them up first so the caption can reference real codes, or continue without — it'll just say to ask in-store.</p>
        <button class="btn btn-outline btn-sm" id="capGoSetCodesBtn"><i class="fa-solid fa-arrow-right"></i> Set Up Codes First (Workspace)</button>
      </div>
    ` : `
      <div class="detail-block">
        <h4><i class="fa-solid fa-tags"></i> Using your confirmed codes</h4>
        <p>${esc(myCode)} · ${esc(partnerCode)}</p>
      </div>
    `}
    <div class="field"><label>What's the offer?</label>
      <textarea id="capOffer" rows="3" placeholder="e.g. 15% off coffee when you show a haircut receipt from Zziwa this week"></textarea>
    </div>
    <div class="field"><label>Website (optional)</label><input id="capWebsiteA" placeholder="${esc(state.business.name)}'s website"></div>
    <div class="field"><label>Partner's website (optional)</label><input id="capWebsiteB" placeholder="${esc(partnerBiz?.name || "Partner")}'s website"></div>
    <button class="btn btn-primary" id="capGenerateBtn" style="width:100%;"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate Caption</button>
    <div id="capResultWrap" style="margin-top:14px;"></div>
    <button class="btn btn-outline" id="capCloseBtn" style="width:100%;margin-top:10px;">Close</button>
  `);
  document.getElementById("capCloseBtn").onclick = closeModal;
  const goSetCodesBtn = document.getElementById("capGoSetCodesBtn");
  if (goSetCodesBtn) goSetCodesBtn.onclick = () => { closeModal(); go(`#/room/${room.id}/workspace`); };

  document.getElementById("capGenerateBtn").onclick = async () => {
    const offer = document.getElementById("capOffer").value.trim();
    if (!offer) { toast("Describe the offer first."); return; }
    const btn = document.getElementById("capGenerateBtn");
    btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Generating...`;
    try {
      const res = await fetch(`${domain}/.netlify/functions/generate-caption`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessA: { name: state.business.name, location: state.business.location, website: document.getElementById("capWebsiteA").value.trim() || null },
          businessB: { name: partnerBiz?.name || "Partner", location: partnerBiz?.location, website: document.getElementById("capWebsiteB").value.trim() || null },
          offer,
          codeA: myCode,
          codeB: partnerCode,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.caption) throw new Error(data?.error || "Couldn't generate a caption — try again.");

      // Contact lines are built here, not by the AI — real phone numbers
      // formatted deterministically, only for businesses that actually have
      // one on file, and only as a wa.me link if they toggled that number as
      // being on WhatsApp — otherwise a plain call link instead.
      const contactA = toContactLink(state.business.phone, state.business.phoneIsWhatsApp);
      const contactB = toContactLink(partnerBiz?.phone, partnerBiz?.phoneIsWhatsApp);
      let waBlock = "";
      if (contactA || contactB) {
        waBlock = "\n\n📲 Get in touch:";
        if (contactA) waBlock += `\n${state.business.name} (${contactA.label}): ${contactA.url}`;
        if (contactB) waBlock += `\n${partnerBiz?.name || "Partner"} (${contactB.label}): ${contactB.url}`;
      }
      const fullText = data.caption + waBlock;

      document.getElementById("capResultWrap").innerHTML = `
        <div class="detail-block" style="white-space:pre-wrap;background:var(--accent-light);padding:12px;border-radius:var(--radius-sm);">${esc(fullText)}</div>
        <button class="btn btn-outline" id="capCopyBtn" style="width:100%;margin-top:10px;"><i class="fa-solid fa-copy"></i> Copy</button>
        <button class="btn btn-primary" id="capPostBtn" style="width:100%;margin-top:8px;"><i class="fa-solid fa-paper-plane"></i> Post to Chat</button>
      `;
      document.getElementById("capCopyBtn").onclick = async () => {
        try { await navigator.clipboard.writeText(fullText); toast("Copied!"); }
        catch (e) { toast("Couldn't copy automatically — select the text manually."); }
      };
      document.getElementById("capPostBtn").onclick = async () => {
        await addDoc(collection(db, "rooms", room.id, "messages"), { senderId: state.user.uid, text: fullText, imageUrl: null, createdAt: serverTimestamp() });
        closeModal();
        toast("Posted to chat!");
      };
    } catch (err) {
      document.getElementById("capResultWrap").innerHTML = `<p class="hint" style="color:var(--warn);">${esc(err.message)}</p>`;
      console.error("Caption generation failed:", err);
    } finally {
      btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Caption`;
    }
  };
}

// (Image generation removed — captions + redemption codes only. See conversation history if ever revisited.)

function renderWorkspaceTab(container, room) {
  const otherId = room.createdBy === state.user.uid ? room.partnerId : room.createdBy;
  container.innerHTML = `
    <h2 class="section-title">Partners</h2>
    <div id="partnersBlock">${loadingHTML("Loading...")}</div>
    <h2 class="section-title">Redemption Tracker</h2>
    <div id="trackerBlock">${loadingHTML("Loading...")}</div>
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
  // Render the card skeleton once — self info is known synchronously,
  // partner info fills in async. Each presence listener below only ever
  // touches its own small span, never rebuilds the other's, so the two
  // listeners can't race and clobber each other.
  document.getElementById("partnersBlock").innerHTML = `
    <div class="partner-row">${avatarHTML(state.business, "sm")}
      <div class="info"><div class="name">${esc(state.business.name)} (You)</div><div class="sub" id="selfPresence"><span class="offline-dot"></span>…</div></div></div>
    <div class="partner-row"><div id="partnerAvatarWrap">${avatarHTML({}, "sm")}</div>
      <div class="info"><div class="name" id="partnerName">Partner</div><div class="sub" id="partnerPresence"><span class="offline-dot"></span>…</div></div></div>`;

  // Self: listen to your own business doc so the label updates the moment
  // the heartbeat writes (e.g. right as this screen opens).
  const unsubSelf = onSnapshot(doc(db, "businesses", state.user.uid), (snap) => {
    const p = presenceLabel(snap.data()?.lastActiveAt);
    const el = document.getElementById("selfPresence");
    if (el) el.innerHTML = `<span class="${p.dot}"></span>${p.text}`;
  });
  state.unsub.push(unsubSelf);

  // Partner: live listener, not a one-time read, so if they open the app
  // while you're already viewing this screen, it updates in place instead
  // of needing a refresh.
  let partnerCardFilled = false;
  const unsubPartner = onSnapshot(doc(db, "businesses", otherId), (snap) => {
    const partnerBiz = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    if (!partnerCardFilled && partnerBiz) {
      const wrap = document.getElementById("partnerAvatarWrap");
      const nameEl = document.getElementById("partnerName");
      if (wrap) wrap.innerHTML = avatarHTML(partnerBiz, "sm");
      if (nameEl) nameEl.textContent = partnerBiz.name || "Partner";
      partnerCardFilled = true;
    }
    const p = presenceLabel(partnerBiz?.lastActiveAt);
    const pEl = document.getElementById("partnerPresence");
    if (pEl) pEl.innerHTML = `<span class="${p.dot}"></span>${p.text}`;
  });
  state.unsub.push(unsubPartner);

  // ---------- Redemption Tracker ----------
  // Codes now require BOTH businesses to agree before going live — one side
  // proposes (AI-generated, memorable, tied to the business name/offer),
  // the other accepts or asks for different ones. Once confirmed: when a
  // customer redeems the PARTNER's code at YOUR shop, you tap +1 — crediting
  // THEM, not yourself. Neither business has any incentive to inflate a
  // count, since tapping the button only benefits the other side.
  //
  // genRedemptionCode is the deterministic fallback used below if the AI
  // call fails for any reason — simpler codes, but the feature never blocks
  // on network/API availability.
  function genRedemptionCode(name) {
    const base = (name || "PARTNER").replace(/[^a-zA-Z]/g, "").slice(0, 8).toUpperCase();
    return (base || "PARTNER") + "10";
  }

  async function proposeTrackerCodes(partnerBiz) {
    try {
      const res = await fetch(`${domain}/.netlify/functions/generate-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessA: state.business.name,
          businessB: partnerBiz?.name,
          offer: room.campaignPlan?.goal || room.goal || "",
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.codeA && data?.codeB) {
        const codes = { [state.user.uid]: data.codeA, [otherId]: data.codeB };
        if (codes[state.user.uid] === codes[otherId]) codes[otherId] += "B";
        return codes;
      }
      console.warn("AI code generation unavailable, using fallback:", data?.error);
    } catch (e) {
      console.warn("AI code generation request failed, using fallback:", e);
    }
    // Fallback never blocks the flow — simpler, but always works.
    const codes = { [state.user.uid]: genRedemptionCode(state.business.name), [otherId]: genRedemptionCode(partnerBiz?.name) };
    if (codes[state.user.uid] === codes[otherId]) codes[otherId] += "B";
    return codes;
  }

  async function sendTrackerProposal() {
    const partnerBiz = await loadBusiness(otherId);
    const codes = await proposeTrackerCodes(partnerBiz);
    const tracker = { codes, redemptions: { [state.user.uid]: 0, [otherId]: 0 }, status: "proposed", proposedBy: state.user.uid };
    await updateDoc(doc(db, "rooms", room.id), { tracker });
    room.tracker = tracker;
    renderTracker();
  }

  function renderTracker() {
    const wrap = document.getElementById("trackerBlock");
    if (!wrap) return;
    if (!["confirmed", "running", "completed"].includes(room.status)) {
      wrap.innerHTML = `<p class="hint">Available once your campaign is confirmed — this is how you'll both track who a customer actually came from, fairly.</p>`;
      return;
    }
    const t = room.tracker;

    if (!t) {
      wrap.innerHTML = `
        <p class="hint" style="margin-bottom:10px;">Propose a redemption code for each business so you can track who brings in customers for the other — no spreadsheets, no arguing. Your partner has to accept before it goes live.</p>
        <button class="btn btn-outline" id="proposeTrackerBtn" style="width:100%;"><i class="fa-solid fa-tags"></i> Propose Tracking Codes</button>
      `;
      const btn = document.getElementById("proposeTrackerBtn");
      btn.onclick = async () => {
        btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Generating...`;
        await sendTrackerProposal();
      };
      return;
    }

    if (t.status === "proposed") {
      const myCode = t.codes?.[state.user.uid] || "—";
      const partnerCode = t.codes?.[otherId] || "—";
      const iProposed = t.proposedBy === state.user.uid;
      wrap.innerHTML = `
        <div class="detail-block">
          <h4><i class="fa-solid fa-tags"></i> Proposed codes</h4>
          <p>Your code: <strong>${esc(myCode)}</strong><br>Partner's code: <strong>${esc(partnerCode)}</strong></p>
        </div>
        ${iProposed ? `<p class="hint" style="margin-bottom:8px;">Waiting for your partner to accept these.</p>` : ""}
        ${!iProposed ? `<button class="btn btn-primary" id="acceptTrackerBtn" style="width:100%;margin-bottom:8px;"><i class="fa-solid fa-check"></i> Accept These Codes</button>` : ""}
        <button class="btn btn-outline btn-sm" id="regenTrackerBtn"><i class="fa-solid fa-rotate"></i> Suggest Different Codes</button>
      `;
      const regenBtn = document.getElementById("regenTrackerBtn");
      regenBtn.onclick = async () => {
        regenBtn.disabled = true; regenBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Generating...`;
        await sendTrackerProposal();
      };
      const acceptBtn = document.getElementById("acceptTrackerBtn");
      if (acceptBtn) acceptBtn.onclick = async () => {
        await updateDoc(doc(db, "rooms", room.id), { "tracker.status": "confirmed" });
        room.tracker.status = "confirmed";
        renderTracker();
        toast("Tracking codes confirmed!");
      };
      return;
    }

    const myCode = t.codes?.[state.user.uid] || "—";
    const partnerCode = t.codes?.[otherId] || "—";
    const myRedemptions = t.redemptions?.[state.user.uid] || 0;
    const partnerRedemptions = t.redemptions?.[otherId] || 0;
    wrap.innerHTML = `
      <div class="detail-block">
        <h4><i class="fa-solid fa-tag"></i> Your code: ${esc(myCode)}</h4>
        <p style="font-weight:600;margin:2px 0;">Customers show <span style="color:var(--accent);">${esc(myCode)}</span> at your partner's shop to redeem.</p>
        <p class="hint">Used there so far: ${myRedemptions} ${myRedemptions === 1 ? "time" : "times"} — they tap +1 when it happens.</p>
      </div>
      <div class="detail-block">
        <h4><i class="fa-solid fa-tag"></i> Partner's code: ${esc(partnerCode)}</h4>
        <p style="font-weight:600;margin:2px 0;">Customers show <span style="color:var(--accent);">${esc(partnerCode)}</span> HERE to redeem.</p>
        <p class="hint" style="margin-bottom:8px;">Used here so far: ${partnerRedemptions} ${partnerRedemptions === 1 ? "time" : "times"}</p>
        <button class="btn btn-outline btn-sm" id="incrementRedemptionBtn"><i class="fa-solid fa-plus"></i> Someone just used ${esc(partnerCode)} here</button>
      </div>
    `;
    document.getElementById("incrementRedemptionBtn").onclick = async () => {
      const newCount = (room.tracker?.redemptions?.[otherId] || 0) + 1;
      await updateDoc(doc(db, "rooms", room.id), { [`tracker.redemptions.${otherId}`]: newCount });
      toast("Counted!");
    };
  }
  renderTracker();
  // Live: room-wide listener so a partner's +1 (or the initial code setup)
  // shows up immediately without a refresh.
  const unsubTracker = onSnapshot(doc(db, "rooms", room.id), (snap) => {
    const data = snap.data();
    if (!data) return;
    room.tracker = data.tracker;
    renderTracker();
  });
  state.unsub.push(unsubTracker);

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
    <h2 class="section-title">🚀 Launch — the mobile-friendly way (Facebook/Instagram)</h2>
    <div class="callout" style="margin-top:0;"><i class="fa-solid fa-shield-heart"></i><span>You each post and boost from your own Facebook pages/IG account(professional dashboard), personal profiles don't work— adRoomie never touches your money.</span></div>

    <div class="launch-steps">
      <div class="launch-step" style="--lc:#5B3FD9;">
        <div class="launch-step-icon"><i class="fa-solid fa-camera"></i></div>
        <div class="launch-step-num">1</div>
        <div><h4>Post your shared creative</h4><p>Share it as a normal post or Reel.</p></div>
      </div>
      <div class="launch-step" style="--lc:#E08A2E;">
        <div class="launch-step-icon"><i class="fa-solid fa-user-tag"></i></div>
        <div class="launch-step-num">2</div>
        <div><h4>Tag your partner</h4><p>While creating the post, Tag people → Invite Collaborator → search and select only your partner's Page.</p></div>
      </div>
      <div class="launch-step" style="--lc:#1F8A6F;">
        <div class="launch-step-icon"><i class="fa-solid fa-rocket"></i></div>
        <div class="launch-step-num">3</div>
        <div><h4>Boost it</h4><p>Only after they accept the collaboration invite — tap Boost Post, pay your half from your own account.</p></div>
      </div>
    </div>

    <div class="mirror-note"><i class="fa-solid fa-arrows-rotate"></i> Your partner does these same 3 steps too — their own post, tagging you back.</div>

    <h2 class="section-title">What this actually gets you</h2>
    <div class="result-visual">
      <div class="result-post" style="--rc:#5B3FD9;"><i class="fa-solid fa-image"></i><span>Your post</span></div>
      <div class="result-arrow"><i class="fa-solid fa-arrow-right"></i></div>
      <div class="result-both"><i class="fa-solid fa-users"></i><span>Both audiences</span></div>
      <div class="result-arrow"><i class="fa-solid fa-arrow-left"></i></div>
      <div class="result-post" style="--rc:#E08A2E;"><i class="fa-solid fa-image"></i><span>Their post</span></div>
    </div>
    <p class="hint" style="text-align:center;">Two posts, each boosted by its own owner, both reaching both audiences.</p>

    <h2 class="section-title">Once it's live</h2>
    <div class="checklist-item"><span class="check"><i class="fa-solid fa-circle-check"></i></span>Share your post link in Chat so your partner can confirm theirs is up too.</div>
    <div class="checklist-item"><span class="check"><i class="fa-solid fa-circle-check"></i></span>Use your Workspace redemption codes to track who actually walks in.</div>

    <details class="advanced-path">
      <summary><i class="fa-solid fa-desktop"></i> Have desktop access? There's a more advanced option</summary>
      <p class="hint">Meta's <strong>Partnership Ads Hub</strong> (Ads Manager → All Tools — desktop/browser only, not the mobile app) runs one shared post as a single ad from both accounts. More powerful, but needs Business Manager setup and Meta's approval flow. The 3 steps above work for almost everyone without any of that.</p>
    </details>
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
// Live (onSnapshot) view of everything happening in the app during testing:
// Activity feed, Businesses, Rooms, Requests, Support. Read volume is one
// listener each on businesses / rooms / requests (collection group) /
// supportRequests (collection group) — fine for free-tier at test scale.
// Collection-group listeners are NOT ordered server-side (that would need
// indexes); everything is sorted in the browser instead.
// ============================================================
function tsMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts.seconds) return ts.seconds * 1000;
  const n = new Date(ts).getTime();
  return Number.isNaN(n) ? 0 : n;
}
function fmtDateTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function timeAgo(ms) {
  if (!ms) return "";
  const m = (Date.now() - ms) / 60000;
  if (m < 1) return "just now";
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
const ROOM_STAGES = ["open", "negotiating", "confirmed", "running", "completed"];
const ADMIN_SEEN_KEY = "adroomie_admin_seen_at";

async function renderAdmin() {
  if (!state.isAdmin) { go("#/rooms"); return; }
  renderTopbar({ title: "Admin", back: true });
  renderBottomNav("profile");
  appEl.innerHTML = `
    <h1 class="page-title">Admin Dashboard</h1>
    <p class="page-sub">Live view of everything happening on adRoomie. Updates on its own — no refresh needed.</p>
    <div id="adminStats">${loadingHTML("Loading…")}</div>
    <div class="filter-tabs" id="adminTabs">
      <button class="filter-tab active" data-t="activity">Activity</button>
      <button class="filter-tab" data-t="businesses">Businesses</button>
      <button class="filter-tab" data-t="rooms">Rooms</button>
      <button class="filter-tab" data-t="requests">Requests</button>
      <button class="filter-tab" data-t="support">Support</button>
    </div>
    <div id="adminBody">${loadingHTML("Loading…")}</div>
  `;

  const data = { businesses: [], rooms: [], requests: [], support: [], supportError: null };
  const ui = { tab: "activity", roomSort: "newest", roomStage: "all", bizSort: "newest", bizSearch: "" };
  let lastSeen = 0;
  try { lastSeen = Number(localStorage.getItem(ADMIN_SEEN_KEY)) || 0; } catch (e) {}

  const bizById = () => Object.fromEntries(data.businesses.map((b) => [b.id, b]));
  const roomById = () => Object.fromEntries(data.rooms.map((r) => [r.id, r]));
  const bizCreatedMs = (b) => tsMillis(b.createdAt) || tsMillis(b.updatedAt) || 0; // older profiles have no createdAt

  document.querySelectorAll("#adminTabs .filter-tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll("#adminTabs .filter-tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active"); ui.tab = t.dataset.t; draw();
    };
  });

  const listen = (q, onData, onErr) => state.unsub.push(onSnapshot(q, (snap) => { onData(snap); draw(); }, (e) => { console.warn("Admin listener failed:", e); if (onErr) onErr(e); draw(); }));
  listen(collection(db, "businesses"), (s) => { data.businesses = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((b) => b.name); }); // skip name-less presence stubs
  listen(collection(db, "rooms"), (s) => { data.rooms = s.docs.map((d) => ({ id: d.id, ...d.data() })); });
  listen(collectionGroup(db, "requests"), (s) => { data.requests = s.docs.map((d) => ({ id: d.id, roomId: d.ref.parent.parent.id, ...d.data() })); });
  listen(collectionGroup(db, "supportRequests"), (s) => {
    data.support = s.docs.map((d) => ({ id: d.id, roomId: d.ref.parent.parent.id, ...d.data() }));
    data.supportError = null;
  }, (e) => { data.supportError = e?.code || "unknown"; });

  function statsHTML() {
    const counts = Object.fromEntries(ROOM_STAGES.map((s) => [s, 0]));
    data.rooms.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status]++; });
    const launched = counts.running + counts.completed;
    const pending = data.requests.filter((r) => r.status === "pending").length;
    const activeNow = data.businesses.filter((b) => presenceLabel(b.lastActiveAt).dot === "active-dot").length;
    const newSince = [...data.businesses.map(bizCreatedMs), ...data.rooms.map((r) => tsMillis(r.createdAt))].filter((ms) => ms > lastSeen).length;
    return `
      <div class="card">
        <div class="checklist-item"><span class="check"><i class="fa-solid fa-trophy"></i></span>
          <span><strong>${launched}</strong> room${launched === 1 ? "" : "s"} reached a launched campaign — your North Star number</span></div>
        <div class="meta-line" style="margin-top:6px;">
          ${data.businesses.length} businesses (${activeNow} active now) · ${data.rooms.length} rooms · ${pending} pending request${pending === 1 ? "" : "s"}
        </div>
        <div class="meta-line">Open ${counts.open} · Negotiating ${counts.negotiating} · Confirmed ${counts.confirmed} · Running ${counts.running} · Completed ${counts.completed}</div>
        ${newSince ? `<div class="meta-line"><strong>${newSince}</strong> new profile/room event${newSince === 1 ? "" : "s"} since you last looked <button class="btn btn-outline" id="markSeenBtn" style="padding:2px 10px;margin-left:6px;">Mark seen</button></div>` : ""}
      </div>`;
  }

  // ---- Activity feed: everything, newest first, built from the live data ----
  function activityItems() {
    const bz = bizById(), rm = roomById();
    const items = [];
    data.businesses.forEach((b) => items.push({ ms: bizCreatedMs(b), icon: "fa-store", title: "New business profile", text: `${b.name || "Unnamed"} · ${b.category || "—"} · ${b.location || "—"}${b.description ? ` — ${b.description}` : ""}`, tab: "businesses" }));
    data.rooms.forEach((r) => items.push({ ms: tsMillis(r.createdAt), icon: "fa-people-roof", title: "Room created", text: `"${r.goal}" by ${bz[r.createdBy]?.name || "Someone"} — now ${r.status}`, room: r.id }));
    data.requests.forEach((q) => items.push({ ms: tsMillis(q.createdAt), icon: "fa-paper-plane", title: `Join request (${q.status})`, text: `${bz[q.requesterId]?.name || "Someone"} → "${rm[q.roomId]?.goal || "room"}"`, room: q.roomId }));
    data.support.forEach((s) => items.push({ ms: tsMillis(s.createdAt), icon: "fa-life-ring", title: `Support: ${s.type}`, text: `${bz[s.requestedBy]?.name || "Someone"} · "${rm[s.roomId]?.goal || "room"}"${s.note ? ` — ${s.note}` : ""}`, room: s.roomId, chat: true }));
    return items.filter((i) => i.ms).sort((a, b) => b.ms - a.ms).slice(0, 60);
  }
  function activityHTML() {
    const items = activityItems();
    if (!items.length) return `<p class="hint">Nothing has happened yet.</p>`;
    return items.map((i) => `
      <div class="card room-card admin-act" ${i.room ? `data-room="${i.room}" data-chat="${i.chat ? 1 : 0}"` : `data-tab="${i.tab || ""}"`}>
        <div class="thumb"><i class="fa-solid ${i.icon}"></i></div>
        <div class="info">
          <div class="row-top"><h3>${esc(i.title)}</h3><span class="meta-line">${esc(timeAgo(i.ms))}</span></div>
          <div class="meta-line">${esc(i.text)}</div>
          <div class="meta-line">${esc(fmtDateTime(i.ms))}</div>
        </div>
      </div>`).join("");
  }

  // ---- Businesses ----
  function businessesHTML() {
    const rm = data.rooms;
    let list = data.businesses.map((b) => ({
      ...b, _created: bizCreatedMs(b), _active: tsMillis(b.lastActiveAt),
      _rooms: rm.filter((r) => r.createdBy === b.id).length, _joined: rm.filter((r) => r.partnerId === b.id).length,
      _sent: data.requests.filter((q) => q.requesterId === b.id).length,
    }));
    const s = ui.bizSearch;
    if (s) list = list.filter((b) => `${b.name} ${b.category} ${b.location} ${b.email}`.toLowerCase().includes(s));
    const sorters = { newest: (a, b) => b._created - a._created, active: (a, b) => b._active - a._active, rooms: (a, b) => b._rooms - a._rooms };
    list.sort(sorters[ui.bizSort]);
    return `
      <div class="search-bar"><i class="fa-solid fa-magnifying-glass"></i><input id="bizSearch" placeholder="Search name, category, location, email" value="${esc(ui.bizSearch)}"></div>
      <div class="field"><select id="bizSort">
        <option value="newest" ${ui.bizSort === "newest" ? "selected" : ""}>Newest first</option>
        <option value="active" ${ui.bizSort === "active" ? "selected" : ""}>Recently active</option>
        <option value="rooms" ${ui.bizSort === "rooms" ? "selected" : ""}>Most rooms</option></select></div>
      <p class="hint">${list.length} business${list.length === 1 ? "" : "es"}. Profiles created before this update show their last-saved date.</p>
      ${list.map((b) => {
        const p = presenceLabel(b.lastActiveAt);
        const wa = b.phone ? `https://wa.me/${String(b.phone).replace(/[^0-9]/g, "")}` : "";
        return `
        <div class="card" data-biz="${b.id}">
          <div class="row-top"><h3>${esc(b.name || "Unnamed")}</h3><span class="meta-line"><span class="${p.dot}"></span> ${esc(p.text)}</span></div>
          <div class="meta-line">${esc(b.category || "—")} · ${esc(b.location || "—")} · ${esc(b.budgetRange || "—")}</div>
          <div class="meta-line">${b.description ? `“${esc(b.description)}”` : "<em>No description</em>"}</div>
          <div class="meta-line">Joined ${esc(fmtDateTime(b._created))} · ${b.emailVerified ? "email verified" : "email NOT verified"}</div>
          <div class="meta-line">${b._rooms} room${b._rooms === 1 ? "" : "s"} created · ${b._joined} joined · ${b._sent} request${b._sent === 1 ? "" : "s"} sent</div>
          <div class="meta-line">${esc((b.audience || []).join(", "))} · ${esc((b.platforms || []).join(", "))}</div>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
            <button class="btn btn-outline" data-push="${b.id}" ${b.oneSignalPlayerId ? "" : "disabled title=\"No push token yet\""} style="padding:4px 12px;"><i class="fa-solid fa-bell"></i> Push</button>
            ${wa ? `<a class="btn btn-outline" href="${wa}" target="_blank" rel="noopener" style="padding:4px 12px;"><i class="fa-brands fa-whatsapp"></i> WhatsApp</a>` : ""}
            ${b.email ? `<a class="btn btn-outline" href="mailto:${esc(b.email)}" style="padding:4px 12px;"><i class="fa-solid fa-envelope"></i> Email</a>` : ""}
          </div>
        </div>`;
      }).join("")}`;
  }

  // ---- Rooms ----
  function roomsHTML() {
    const bz = bizById();
    let list = data.rooms.map((r) => ({
      ...r, _created: tsMillis(r.createdAt),
      _pending: data.requests.filter((q) => q.roomId === r.id && q.status === "pending").length,
      _reqs: data.requests.filter((q) => q.roomId === r.id).length,
    }));
    if (ui.roomStage !== "all") list = list.filter((r) => r.status === ui.roomStage);
    if (ui.roomSort === "newest") list.sort((a, b) => b._created - a._created);
    else if (ui.roomSort === "oldest") list.sort((a, b) => a._created - b._created);
    else list.sort((a, b) => ROOM_STAGES.indexOf(b.status) - ROOM_STAGES.indexOf(a.status) || b._created - a._created);
    return `
      <div style="display:flex;gap:8px;">
        <div class="field" style="flex:1;"><select id="roomSort">
          <option value="newest" ${ui.roomSort === "newest" ? "selected" : ""}>Newest first</option>
          <option value="oldest" ${ui.roomSort === "oldest" ? "selected" : ""}>Oldest first</option>
          <option value="stage" ${ui.roomSort === "stage" ? "selected" : ""}>Furthest stage first</option></select></div>
        <div class="field" style="flex:1;"><select id="roomStage">
          <option value="all">All stages</option>
          ${ROOM_STAGES.map((s) => `<option value="${s}" ${ui.roomStage === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      </div>
      <p class="hint">${list.length} room${list.length === 1 ? "" : "s"}</p>
      ${list.map((r) => `
        <div class="card" data-roomcard="${r.id}">
          <div class="row-top"><h3>${esc(r.goal)}</h3><span class="status-pill status-${r.status}">${esc(r.status)}</span></div>
          <div class="meta-line">By <strong>${esc(bz[r.createdBy]?.name || "Unknown")}</strong> · partner: ${r.partnerId ? `<strong>${esc(bz[r.partnerId]?.name || "Unknown")}</strong>` : "none yet"}</div>
          ${bz[r.createdBy]?.description ? `<div class="meta-line">About them: ${esc(bz[r.createdBy].description)}</div>` : ""}
          <div class="meta-line">Audience: ${esc((r.audience || []).join(", ") || "—")} · ${esc(r.duration || "")} · ${esc((r.platforms || []).join(", "))}</div>
          <div class="meta-line">Looking for: ${esc((r.partnerType || []).join(", ") || "any")} · ${esc(r.location || "")} · ${esc(r.budgetRange || "")}</div>
          <div class="meta-line">Created ${esc(fmtDateTime(r._created))} · ${r._reqs} request${r._reqs === 1 ? "" : "s"} (${r._pending} pending)</div>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center;">
            <button class="btn btn-outline" data-open="${r.id}" style="padding:4px 12px;"><i class="fa-solid fa-comments"></i> Open</button>
            <select data-stage="${r.id}" style="padding:4px;">
              ${ROOM_STAGES.map((s) => `<option value="${s}" ${r.status === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
        </div>`).join("")}`;
  }

  // ---- Requests ----
  function requestsHTML() {
    const bz = bizById(), rm = roomById();
    const list = [...data.requests].sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
    if (!list.length) return `<p class="hint">No join requests yet.</p>`;
    return list.map((q) => `
      <div class="card room-card" data-room="${q.roomId}">
        <div class="info">
          <div class="row-top"><h3>${esc(bz[q.requesterId]?.name || "Someone")}</h3><span class="status-pill status-${q.status}">${esc(q.status)}</span></div>
          <div class="meta-line">→ "${esc(rm[q.roomId]?.goal || "room")}" (owner: ${esc(bz[rm[q.roomId]?.createdBy]?.name || "?")})</div>
          ${q.message ? `<div class="meta-line">"${esc(q.message)}"</div>` : ""}
          <div class="meta-line">${esc(fmtDateTime(tsMillis(q.createdAt)))}</div>
        </div>
      </div>`).join("");
  }

  // ---- Support ----
  function supportHTML() {
    if (data.supportError) {
      return data.supportError === "failed-precondition"
        ? `<p class="hint">Can't load yet — check the browser console for a Firestore index link.</p>`
        : `<p class="hint">Can't load support requests — permissions issue (${esc(data.supportError)}).</p>`;
    }
    const bz = bizById(), rm = roomById();
    const iconMap = { moderator: "fa-user-tie", checkin: "fa-calendar-check", issue: "fa-triangle-exclamation" };
    const list = [...data.support].sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
    if (!list.length) return `<p class="hint">No support requests yet.</p>`;
    return list.map((it) => `
      <div class="card room-card" data-room="${it.roomId}" data-chat="1">
        <div class="thumb"><i class="fa-solid ${iconMap[it.type] || "fa-bell"}"></i></div>
        <div class="info">
          <div class="row-top"><h3 style="text-transform:capitalize;">${esc(it.type)}</h3><span class="meta-line">${esc(timeAgo(tsMillis(it.createdAt)))}</span></div>
          <div class="meta-line">${esc(bz[it.requestedBy]?.name || "Someone")} · "${esc(rm[it.roomId]?.goal || "Room")}"</div>
          ${it.note ? `<div class="meta-line">"${esc(it.note)}"</div>` : ""}
        </div>
      </div>`).join("");
  }

  function draw() {
    const body = document.getElementById("adminBody");
    const statsEl = document.getElementById("adminStats");
    if (!body || !statsEl) return; // navigated away
    // Don't blow away a search box while the admin is typing in it.
    if (document.activeElement && document.activeElement.id === "bizSearch") { statsEl.innerHTML = statsHTML(); return; }
    statsEl.innerHTML = statsHTML();
    const seenBtn = document.getElementById("markSeenBtn");
    if (seenBtn) seenBtn.onclick = () => { lastSeen = Date.now(); try { localStorage.setItem(ADMIN_SEEN_KEY, String(lastSeen)); } catch (e) {} draw(); };
    body.innerHTML = { activity: activityHTML, businesses: businessesHTML, rooms: roomsHTML, requests: requestsHTML, support: supportHTML }[ui.tab]();

    body.querySelectorAll("[data-room]").forEach((c) => { c.onclick = () => go(`#/room/${c.dataset.room}${c.dataset.chat === "1" ? "/chat" : ""}`); });
    body.querySelectorAll("[data-tab]").forEach((c) => { c.onclick = () => { if (!c.dataset.tab) return; ui.tab = c.dataset.tab; document.querySelectorAll("#adminTabs .filter-tab").forEach((x) => x.classList.toggle("active", x.dataset.t === ui.tab)); draw(); }; });
    const bs = document.getElementById("bizSearch");
    if (bs) bs.oninput = (e) => { ui.bizSearch = e.target.value.toLowerCase(); const pos = e.target.selectionStart; draw(); const n = document.getElementById("bizSearch"); n.focus(); n.setSelectionRange(pos, pos); };
    const bso = document.getElementById("bizSort"); if (bso) bso.onchange = (e) => { ui.bizSort = e.target.value; draw(); };
    const rs = document.getElementById("roomSort"); if (rs) rs.onchange = (e) => { ui.roomSort = e.target.value; draw(); };
    const rg = document.getElementById("roomStage"); if (rg) rg.onchange = (e) => { ui.roomStage = e.target.value; draw(); };

    body.querySelectorAll("[data-open]").forEach((b) => { b.onclick = () => go(`#/room/${b.dataset.open}/chat`); });
    // Admin override of a room's stage — logged to the room chat's data only via the status change itself.
    body.querySelectorAll("[data-stage]").forEach((sel) => {
      sel.onchange = async () => {
        const room = data.rooms.find((r) => r.id === sel.dataset.stage);
        const next = sel.value;
        if (!room || next === room.status) return;
        if (!confirm(`Force "${room.goal}" from ${room.status} to ${next}? This overrides the partners' own confirmations.`)) { sel.value = room.status; return; }
        try { await updateDoc(doc(db, "rooms", room.id), { status: next }); toast(`Stage set to ${next}`); }
        catch (e) { toast("Couldn't change stage — check Firestore rules."); sel.value = room.status; }
      };
    });
    body.querySelectorAll("[data-push]").forEach((btn) => {
      btn.onclick = () => {
        const b = data.businesses.find((x) => x.id === btn.dataset.push);
        if (!b) return;
        showModal(`
          <h3>Push to ${esc(b.name)}</h3>
          <div class="field"><textarea id="pushMsg" rows="3" placeholder="Message…"></textarea></div>
          <button class="btn btn-primary" id="pushSend">Send</button>
          <button class="btn btn-outline" id="pushCancel" style="margin-top:8px;">Cancel</button>`);
        document.getElementById("pushCancel").onclick = closeModal;
        document.getElementById("pushSend").onclick = async () => {
          const msg = document.getElementById("pushMsg").value.trim();
          if (!msg) return;
          await notifyPartner(b.oneSignalPlayerId, msg, "adRoomie", `${location.origin}/#/rooms`);
          closeModal(); toast("Push sent");
        };
      };
    });
  }
  draw();
}

// ============================================================
// Router
// ============================================================
async function router() {
  clearListeners();
  removeCollapsibleTopbar();
  appEl.classList.remove("no-bottom-nav");
  shellEl.classList.remove("landing-wide");
  closeModal();

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
  if (user) { initOneSignal(); startPresenceHeartbeat(); }
  else stopPresenceHeartbeat();
});

// ============================================================
// Presence — no Realtime Database or Cloud Functions needed. While the app
// is open and the tab is visible, we periodically stamp the business's own
// document with a serverTimestamp. Anyone viewing that business can then
// work out "Active now / Active 5m ago / Offline" purely from how old that
// timestamp is — cheap (one small write a minute, only while visible) and
// fits entirely in Firestore's free tier.
// ============================================================
let presenceInterval = null;
let presenceVisibilityHandler = null;
function startPresenceHeartbeat() {
  stopPresenceHeartbeat(); // avoid double-registering on repeated auth events
  const beat = () => {
    if (!state.user || document.visibilityState !== "visible") return;
    setDoc(doc(db, "businesses", state.user.uid), { lastActiveAt: serverTimestamp() }, { merge: true }).catch(() => {});
  };
  beat();
  presenceInterval = setInterval(beat, 60000); // every 60s while the tab is open and visible
  presenceVisibilityHandler = () => { if (document.visibilityState === "visible") beat(); };
  document.addEventListener("visibilitychange", presenceVisibilityHandler);
}
function stopPresenceHeartbeat() {
  if (presenceInterval) { clearInterval(presenceInterval); presenceInterval = null; }
  if (presenceVisibilityHandler) { document.removeEventListener("visibilitychange", presenceVisibilityHandler); presenceVisibilityHandler = null; }
}

// Turns a lastActiveAt Firestore timestamp into a human label + dot color.
// Thresholds: <2min = live "now", <60min = "Xm ago", <24h = "Xh ago",
// <7d = "Xd ago", older/missing = "Offline". Nothing here claims certainty
// beyond what a periodic heartbeat can actually promise — a closed tab looks
// identical to a dead connection, which is the honest limit of this approach
// without a real-time presence backend.
function presenceLabel(lastActiveAt) {
  if (!lastActiveAt) return { text: "Offline", dot: "offline-dot" };
  const ms = typeof lastActiveAt.toMillis === "function" ? lastActiveAt.toMillis()
    : (lastActiveAt.seconds ? lastActiveAt.seconds * 1000 : new Date(lastActiveAt).getTime());
  if (!ms || Number.isNaN(ms)) return { text: "Offline", dot: "offline-dot" };
  const minutes = (Date.now() - ms) / 60000;
  if (minutes < 2) return { text: "Active now", dot: "active-dot" };
  if (minutes < 60) return { text: `Active ${Math.round(minutes)}m ago`, dot: "away-dot" };
  const hours = minutes / 60;
  if (hours < 24) return { text: `Active ${Math.round(hours)}h ago`, dot: "away-dot" };
  const days = hours / 24;
  if (days < 7) return { text: `Active ${Math.round(days)}d ago`, dot: "offline-dot" };
  return { text: "Offline", dot: "offline-dot" };
}

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
