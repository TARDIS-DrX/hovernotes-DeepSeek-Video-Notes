// Minimal ULID generator (Crockford base32, 26 chars, lexicographically sortable).
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(time, len) {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    out = ULID_ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

export function ulid() {
  const time = encodeTime(Date.now(), 10);
  let rand = "";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 16; i++) {
    rand += ULID_ALPHABET[bytes[i] % 32];
  }
  return time + rand;
}
