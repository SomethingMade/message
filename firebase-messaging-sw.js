importScripts("https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging-compat.js");

// =========================================================================
// 1. INITIALIZE FIREBASE
// =========================================================================
firebase.initializeApp({
    apiKey: "AIzaSyBQSPwpVbGrdCuOoyitAeWQHIeipj2MgIY",
    authDomain: "newstart-64c43.firebaseapp.com",
    databaseURL: "https://newstart-64c43-default-rtdb.firebaseio.com",
    projectId: "newstart-64c43",
    storageBucket: "newstart-64c43.firebasestorage.app",
    messagingSenderId: "941619830061",
    appId: "1:941619830061:web:de9e0f791eb8f6eacf87a4"
});

const messaging = firebase.messaging();
const NOTIF_ICON = "https://i.postimg.cc/Bv3sQWxd/1783111354171.png";
const DB_URL = "https://newstart-64c43-default-rtdb.firebaseio.com";

// =========================================================================
// 2. FIREBASE CLOUD MESSAGING (BACKGROUND HANDLER)
// =========================================================================
// Resolve the sender's avatar (and name) from the database so the notification
// shows who the message is from. Cached in memory for the life of the worker.
const profileCache = {};
const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);

async function fetchJson(path, token) {
    const url = `${DB_URL}/${path}.json` + (token ? `?auth=${token}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    return res.json();
}

async function lookupProfile(chatUid, groupId) {
    const key = groupId ? 'g:' + groupId : 'u:' + chatUid;
    if (profileCache[key]) return profileCache[key];
    const cached = await getCachedAuth();
    const token = cached && cached.token;
    const path = groupId ? `groups/${groupId}` : `users/${chatUid}`;
    let data = null;
    try { data = await fetchJson(path, token); }
    catch (e) {
        // token may be expired/missing — retry once without auth (works if rules allow)
        if (token) { try { data = await fetchJson(path, null); } catch (_) {} }
    }
    const out = data ? { name: data.name, photoURL: isHttps(data.photoURL) ? data.photoURL : null } : null;
    if (out) profileCache[key] = out;
    return out;
}

// Encrypted/garbled text reads as spam to Chrome's on-device notification filter,
// so never show ciphertext — fall back to a plain readable line.
function cleanBody(b) {
    const t = (b || '').trim();
    if (!t || t.includes('\u27e6e2e') || /^[A-Za-z0-9+\/=_-]{24,}$/.test(t)) return 'Sent you a message';
    return t;
}

// Never let the lookup delay the notification for long
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

messaging.onBackgroundMessage((payload) => {
    // Extract variables directly from our data-only payload
    const { title, body, icon, url, chatUid, groupId } = payload.data || {};

    return (async () => {
        let profile = null;
        if (chatUid || groupId) {
            try { profile = await withTimeout(lookupProfile(chatUid, chatUid ? null : groupId), 2500); } catch (_) {}
            // group message with no usable sender avatar: fall back to the group photo
            if (groupId && chatUid && !(profile && profile.photoURL)) {
                try { profile = await withTimeout(lookupProfile(null, groupId), 2500); } catch (_) {}
            }
        }

        const avatar = (profile && profile.photoURL) || (isHttps(icon) ? icon : null) || NOTIF_ICON;

        const notificationOptions = {
            body: cleanBody(body),
            icon: avatar,
            badge: NOTIF_ICON,
            tag: groupId ? ('group-' + groupId) : (chatUid ? ('chat-' + chatUid) : 'new-message'),
            data: {
                url: url || '/',
                uid: chatUid,
                groupId: groupId
            },
            actions: [
                { action: 'reply', title: 'Reply', type: 'text', placeholder: 'Type a message…' },
                { action: 'close', title: 'Dismiss' }
            ]
        };

        return self.registration.showNotification(
            title || (profile && profile.name) || 'New Message',
            notificationOptions
        );
    })();
});

// =========================================================================
// 3. AUTH TOKEN CACHE (read-only here — index.html writes it)
// =========================================================================
const AUTH_CACHE_DB = 'gozaAuthCache';
const AUTH_CACHE_STORE = 'tokens';

function getCachedAuth() {
    return new Promise((resolve) => {
        const req = indexedDB.open(AUTH_CACHE_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(AUTH_CACHE_STORE);
        req.onsuccess = () => {
            const db = req.result;
            try {
                const tx = db.transaction(AUTH_CACHE_STORE, 'readonly');
                const getReq = tx.objectStore(AUTH_CACHE_STORE).get('current');
                getReq.onsuccess = () => resolve(getReq.result || null);
                getReq.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        };
        req.onerror = () => resolve(null);
    });
}

async function restPost(path, body, token) {
    const res = await fetch(`${DB_URL}/${path}.json?auth=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('REST POST ' + path + ' failed: ' + res.status);
    return res.json(); // { name: "<new key>" }
}

async function restPatch(updates, token) {
    const res = await fetch(`${DB_URL}/.json?auth=${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
    });
    if (!res.ok) throw new Error('REST PATCH failed: ' + res.status);
    return res.json();
}

async function restGet(path, token) {
    const res = await fetch(`${DB_URL}/${path}.json?auth=${token}`);
    if (!res.ok) throw new Error('REST GET ' + path + ' failed: ' + res.status);
    return res.json();
}

// --- DM reply: mirrors sendChatMessage() in the main app ---
async function sendDmReplyFromSW(text, myUid, otherUid, token) {
    const threadId = [myUid, otherUid].sort().join('_');
    const createdAt = Date.now();
    const msgPayload = { text, senderUid: myUid, createdAt };

    await restPost(`dm_threads/${threadId}/messages`, msgPayload, token);
    await restPatch({
        [`user_chats/${myUid}/${otherUid}`]: { text, timestamp: createdAt, unreadCount: 0, senderUid: myUid },
        [`user_chats/${otherUid}/${myUid}/text`]: text,
        [`user_chats/${otherUid}/${myUid}/timestamp`]: createdAt,
        [`user_chats/${otherUid}/${myUid}/unreadCount`]: { '.sv': { increment: 1 } },
        [`user_chats/${otherUid}/${myUid}/senderUid`]: myUid
    }, token);
}

// --- Group reply: mirrors sendGroupMessage() in the main app ---
async function sendGroupReplyFromSW(text, myUid, groupId, token) {
    const group = await restGet(`groups/${groupId}`, token);
    if (!group || !group.members || !group.members[myUid]) return; // not a member, bail silently
    if (group.onlyOwnerCanPost && group.ownerUid !== myUid) return; // respect owner-only posting

    const createdAt = Date.now();
    const senderName = group.memberNames?.[myUid] || 'Someone'; // best-effort; falls back if unknown
    const msgPayload = { text, senderUid: myUid, senderName, createdAt };

    await restPost(`group_threads/${groupId}/messages`, msgPayload, token);

    const updates = {};
    Object.keys(group.members).forEach((memberUid) => {
        if (memberUid === myUid) {
            updates[`user_group_chats/${memberUid}/${groupId}`] = {
                groupName: group.name || 'Group',
                groupPhotoURL: group.photoURL || '',
                text, senderUid: myUid, senderName, timestamp: createdAt, unreadCount: 0
            };
        } else {
            updates[`user_group_chats/${memberUid}/${groupId}/groupName`] = group.name || 'Group';
            updates[`user_group_chats/${memberUid}/${groupId}/groupPhotoURL`] = group.photoURL || '';
            updates[`user_group_chats/${memberUid}/${groupId}/text`] = text;
            updates[`user_group_chats/${memberUid}/${groupId}/senderUid`] = myUid;
            updates[`user_group_chats/${memberUid}/${groupId}/senderName`] = senderName;
            updates[`user_group_chats/${memberUid}/${groupId}/timestamp`] = createdAt;
            updates[`user_group_chats/${memberUid}/${groupId}/unreadCount`] = { '.sv': { increment: 1 } };
        }
    });
    await restPatch(updates, token);
}

// =========================================================================
// 4. NOTIFICATION CLICK HANDLER (default open/focus + reply action)
// =========================================================================
self.addEventListener('notificationclick', (event) => {
    const data = event.notification.data || {};

    // --- "Dismiss" action: just close, nothing else to do ---
    if (event.action === 'close') {
        event.notification.close();
        return;
    }

    // --- "Reply" action: send the message directly, no app launch ---
    if (event.action === 'reply') {
        const text = (event.reply || '').trim();
        event.notification.close();
        if (!text) return;

        event.waitUntil((async () => {
            const cached = await getCachedAuth();
            if (!cached || !cached.token) return; // no cached session — nothing we can do headlessly
            try {
                if (data.groupId) {
                    await sendGroupReplyFromSW(text, cached.uid, data.groupId, cached.token);
                } else if (data.uid) {
                    await sendDmReplyFromSW(text, cached.uid, data.uid, cached.token);
                }
            } catch (err) {
                console.error('SW reply send failed', err);
                // Fallback: open/focus the app to that chat so the person can retry manually
                const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
                for (const client of clientList) {
                    if ('focus' in client) {
                        if (data.uid) client.postMessage({ type: 'open-chat', uid: data.uid });
                        return client.focus();
                    }
                }
                if (self.clients.openWindow) return self.clients.openWindow(data.url || '/');
            }
        })());
        return;
    }

    // --- Default (body) click: existing open/focus-chat behavior, unchanged ---
    event.notification.close();
    const urlToOpen = data.url;
    const chatUid = data.uid;

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // If the app is already open in a tab, focus it and tell the frontend to open the specific chat
            for (const client of clientList) {
                if ('focus' in client) {
                    if (chatUid) client.postMessage({ type: 'open-chat', uid: chatUid });
                    return client.focus();
                }
            }
            // If no app window is open, launch a new one
            if (self.clients.openWindow) {
                return self.clients.openWindow(urlToOpen);
            }
        })
    );
});

// =========================================================================
// 5. PWA CACHING LOGIC (APP SHELL)
// =========================================================================
const CACHE_NAME = "web-messenger-shell-v1";
const APP_SHELL = [
    "./",
    "./index.html",
    "./manifest.json"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const url = event.request.url;

    // Never cache Firebase/Cloudinary/API calls — always go to network for live data.
    if (
        url.includes("firebaseio.com") ||
        url.includes("googleapis.com") ||
        url.includes("firebasestorage") ||
        url.includes("cloudinary.com")
    ) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cached) => {
            return (
                cached ||
                fetch(event.request)
                    .then((response) => {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
                        return response;
                    })
                    .catch(() => cached)
            );
        })
    );
});
