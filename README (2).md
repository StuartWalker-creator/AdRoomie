# adRoomie — Consolidated MVP

One `index.html`, one `styles.css`, one `app.js`. Everything else (Netlify function, rules) is structural and can't be merged in without losing what it does.

## Files

- **index.html** — thin shell. Just a topbar container, an `#app` container, a bottom-nav container, and script tags. `app.js` renders every screen into `#app`.
- **styles.css** — every style for every screen, in the adRoomie purple brand from your mockup.
- **app.js** — everything else: Firebase init, auth, hash-based router, Firestore reads/writes, Cloudinary uploads, OneSignal wiring, and a render function for each of the 11 screens.
- **netlify.toml** / **netlify/functions/send-notification.js** — has to stay separate; it's the serverless piece that keeps your OneSignal REST key off the client. Explained in our previous message.
- **firestore.rules** — paste into Firebase Console → Firestore → Rules.

## How navigation works

It's a single page. `app.js` listens for `hashchange` and re-renders `#app` based on the URL hash:

```
#/rooms                     → Browse Open Rooms (home)
#/profile                   → Create/Edit Profile
#/create-room                → Create Room
#/room/{id}                  → Room Details (before joining)
#/room/{id}/join              → Request to Join
#/room/{id}/chat               → Chat & Agree
#/room/{id}/workspace           → Workspace (partners, plan, creatives)
#/room/{id}/launch                → Launch guidance (the v1 diagram)
#/room/{id}/track                    → Track Performance
#/room/{id}/support                    → Support & Check-ins
#/room/{id}/complete                    → Campaign Complete
#/room/{id}/review                       → Leave a Review
#/room/{id}/whatsnext                     → What's Next
```

The Chat/Workspace/Launch/Track/Support screens share one tab bar inside `renderRoomHub()` rather than being five separate mockup screens — same content, fewer moving parts to wire up.

## Setup (same as before, three services)

1. **Firebase** — enable Email/Password auth + Firestore, paste `firestore.rules` in, fill in the config object at the top of `app.js`.
2. **Cloudinary** — unsigned upload preset, fill in `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_UPLOAD_PRESET` in `app.js`.
3. **OneSignal** — Web Push app, fill in `ONESIGNAL_APP_ID` in `app.js`, and set `ONESIGNAL_APP_ID` + `ONESIGNAL_REST_KEY` as environment variables in the Netlify dashboard (not in `app.js` — the REST key is secret, the App ID is not).

## Latest updates (this round)

- **Public landing page** for logged-out visitors, matching your reference image — hero, trust badges, "how it works" steps, "why adRoomie" cards, testimonials, and a closing CTA banner, all built from your actual v1 flow so the marketing copy matches what the product really does. "Log in" / "Sign up free" sit top-right; both route to the real auth form (`#/login` / `#/signup`) rather than a separate page. No bottom nav on this screen, same as you asked. Once authenticated, this page never shows again — the router checks `state.user` first and only falls back to the landing page when logged out.
- I deliberately left out the FAQ/Resources/Pricing nav links from your reference image, per your note that those shouldn't be there — kept it to Log in / Sign up only.

## Previous updates

- **Nav restructured around the room lifecycle**: "Rooms" (home) now shows the rooms you're actively part of — what used to live under "Chats." The old browse screen is now "Explore." "Inbox" is new — aggregates join requests to your rooms (actionable, accept/decline right there) and the status of requests you've sent elsewhere. A one-time Firestore composite index is needed for the "sent requests" query (`collectionGroup("requests")` + `where("requesterId","==",...)`) — Firestore will log a direct "create index" link in the browser console the first time it runs; click it once and it's done permanently.
- **Message timestamps**: every chat bubble now shows a WhatsApp-style time (`formatTime()` in `app.js`), reading from Firestore's `createdAt`. Briefly blank while `serverTimestamp()` is still resolving — that's expected, not a bug.
- **Room status pill moved to the topbar**, top-right, whenever you're inside a room — no longer buried in the scrolling content.
- **Sticky layout, done properly**: the whole app shell is now a fixed-height flex column with `.content` as the *only* scrolling pane (`overflow-y: auto`). That's what makes the tab bar (Chat/Workspace/Launch/Track/Support) stick to the top and the chat input bar stick to the bottom while messages scroll underneath — sticky positioning only works reliably when there's one clear scrolling container, so this was a real structural fix, not just a CSS tweak.

## Previous updates

- **Icons**: every icon in the app is now Font Awesome, loaded via CDN in `index.html` (`cdnjs.cloudflare.com/.../font-awesome`). No emoji left anywhere.
- **Profile picture**: tap the avatar circle on the Profile screen to upload a real photo (via Cloudinary, same pattern as creatives). Stored as `photoURL` on the business doc, and now shown wherever a business appears — partner rows, room cards, join requests, reviews — falling back to initials if no photo's been set.
- **Target Audience** is now a multi-select chip picker with a preset list (Students, Young Adults, Families, etc.) instead of free text, on both the Profile and Create Room screens. **Type of partner you're looking for** on Create Room got the same treatment, reusing the category list. Matching logic (`matchScore()`) was updated to compare these as real arrays instead of guessing from free text — more accurate, not just cosmetic.
- **Boot loading screen** is now a full branded splash (logo mark, "adRoomie", tagline, a short blurb on what the app does, and a spinner) shown in `index.html` until Firebase resolves the auth state, instead of a bare spinner + text.

## What's simplified vs. the mockup — worth knowing

- **Matching is a rule-based score**, not AI — approximates the blueprint's weights (audience/industry/location/budget/platform). The "complementary industry" factor uses a placeholder heuristic (different category = bonus points) since a real industry-pairing table doesn't exist yet — flagged in a code comment in `matchScore()`.
- **Phone verification is self-declared**, not OTP-verified (real Firebase phone auth needs the Blaze plan).
- **Tracking is manual screenshot upload**, not pulled from Meta's API (requires business verification + app review to access other businesses' ad accounts — deferred, as discussed).
- **Support actions** (moderator/check-in/report) write a request to Firestore rather than actually paging you — you'd check `supportRequests` subcollections manually for now, or wire up a notification to yourself later.

## Deploying without a computer

Push this whole folder to a GitHub repo (GitHub's mobile app supports this), then in Netlify: **Add new site → Import an existing project → GitHub**, pick the repo. Add your two env vars in the Netlify dashboard once. Every push after that auto-deploys.
