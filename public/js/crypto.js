/**
 * CIPHER — Cryptographic primitives
 * ECDH-P256 key exchange → HKDF-SHA-256 → AES-256-GCM
 * All operations run client-side via Web Crypto API.
 */
const Crypto = (() => {
  const s = crypto.subtle;

  // ── Key generation ──────────────────────────────────────────
  async function generateKeyPair() {
    return s.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
  }

  async function exportPublicKey(kp) {
    const raw = await s.exportKey('raw', kp.publicKey);
    return _u8b64(new Uint8Array(raw));
  }

  async function importPublicKey(b64) {
    return s.importKey(
      'raw', _b64u8(b64),
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
  }

  // ── Key derivation ──────────────────────────────────────────
  // ECDH shared secret → HKDF → AES-256-GCM session key
  async function deriveSharedKey(myPrivKey, theirPubKey) {
    const bits = await s.deriveBits(
      { name: 'ECDH', public: theirPubKey },
      myPrivKey,
      256
    );
    const hkdf = await s.importKey('raw', bits, { name: 'HKDF' }, false, ['deriveKey']);
    return s.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('CIPHER-P2P-v1-SALT'),
        info: new TextEncoder().encode('AES-GCM-256-SESSION-KEY'),
      },
      hkdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ── AES-256-GCM ─────────────────────────────────────────────
  async function encrypt(aesKey, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = typeof plaintext === 'string'
      ? new TextEncoder().encode(plaintext)
      : plaintext; // ArrayBuffer / TypedArray
    const ct = await s.encrypt({ name: 'AES-GCM', iv }, aesKey, data);
    return { iv: _u8b64(iv), ct: _u8b64(new Uint8Array(ct)) };
  }

  async function decrypt(aesKey, ivB64, ctB64) {
    return s.decrypt(
      { name: 'AES-GCM', iv: _b64u8(ivB64) },
      aesKey,
      _b64u8(ctB64)
    ); // → ArrayBuffer
  }

  // ── SHA-256 fingerprint ──────────────────────────────────────
  // Returns first 32 hex chars grouped as XXXX-XXXX-…
  async function fingerprint(pubKeyB64) {
    const hash = await s.digest('SHA-256', _b64u8(pubKeyB64));
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
      .slice(0, 32)
      .match(/.{4}/g)
      .join('-');
  }

  // ── Base64 helpers ───────────────────────────────────────────
  function _u8b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function _b64u8(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  return { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encrypt, decrypt, fingerprint };
})();
