/* haba-push-decrypt.js
   Decrypts the text of an end-to-end encrypted push so the notification shows the real message.
   Load it from firebase-messaging-sw.js with: importScripts('./haba-push-decrypt.js');
   Then: const body = (await habaPushBody(data)) || mediaLabel || 'New message'; */
(function (self) {
  const E2E = '\u27e6e2e1\u27e7';
  const DB_URL = 'https://newstart-64c43-default-rtdb.firebaseio.com';

  const idbGet = (name, store, key) => new Promise((res, rej) => {
    const q = indexedDB.open(name, 1);
    q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains(store)) q.result.createObjectStore(store); };
    q.onerror = () => rej(q.error);
    q.onsuccess = () => {
      const d = q.result;
      try {
        const r = d.transaction(store).objectStore(store).get(key);
        r.onsuccess = () => { d.close(); res(r.result); };
        r.onerror = () => { d.close(); rej(r.error); };
      } catch (e) { d.close(); rej(e); }
    };
  });

  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;

  async function decryptWith(priv, peerJwk, payload) {
    const pub = await crypto.subtle.importKey('jwk', peerJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const [iv, ct] = payload.slice(E2E.length).split(':');
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(unb64(iv)) }, key, unb64(ct)));
  }

  async function fetchPeerKey(peer, auth) {
    if (!auth || !auth.token) return null;
    const r = await fetch(`${DB_URL}/users/${encodeURIComponent(peer)}/e2ee/publicKey.json?auth=${encodeURIComponent(auth.token)}`);
    return r.ok ? r.json() : null;
  }

  /* returns the plain text, or null when it can't be decrypted (caller then shows a generic label) */
  self.habaPushBody = async function (d) {
    try {
      const body = d && d.body;
      if (typeof body !== 'string' || !body.startsWith(E2E)) return body || null;
      if (!d.chatUid || d.groupId) return null;                 // 1:1 chats only
      const auth = await idbGet('gozaAuthCache', 'tokens', 'current');
      const uid = auth && auth.uid; if (!uid) return null;
      const kp = await idbGet('haba-messenger', 'keys', 'keypair-' + uid);
      if (!kp || !kp.privateKey) return null;
      const cached = await idbGet('haba-messenger', 'keys', 'peerpub-' + uid + '-' + d.chatUid).catch(() => null);
      if (cached) { try { return await decryptWith(kp.privateKey, cached, body); } catch (_) {} }
      const fresh = await fetchPeerKey(d.chatUid, auth);        // new sender, or their key changed
      return fresh ? await decryptWith(kp.privateKey, fresh, body) : null;
    } catch (_) { return null; }
  };
})(self);
