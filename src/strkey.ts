/**
 * Minimal, dependency-free StrKey decoding for the address forms AnchorTrace compares:
 * ed25519 public keys (G...) and muxed accounts (M...). Checks the version byte and CRC16-XModem.
 * Browser-safe: this keeps the SDK bundle small by not depending on @stellar/stellar-sdk.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const VERSION_ACCOUNT = 6 << 3; // 'G'
const VERSION_MUXED = 12 << 3; // 'M'

function base32Decode(s: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Canonical encodings leave only zero padding bits.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

interface Decoded {
  version: number;
  payload: Uint8Array;
}

function decode(s: string): Decoded | null {
  if (!/^[A-Z2-7]+$/.test(s)) return null;
  const raw = base32Decode(s);
  if (raw === null || raw.length < 3) return null;
  const body = raw.slice(0, raw.length - 2);
  const crc = raw[raw.length - 2]! | (raw[raw.length - 1]! << 8);
  if (crc16(body) !== crc) return null;
  // Re-encode to reject non-canonical strings.
  if (base32Encode(raw) !== s) return null;
  return { version: body[0]!, payload: body.slice(1) };
}

function encode(version: number, payload: Uint8Array): string {
  const body = new Uint8Array(1 + payload.length);
  body[0] = version;
  body.set(payload, 1);
  const crc = crc16(body);
  const full = new Uint8Array(body.length + 2);
  full.set(body);
  full[body.length] = crc & 0xff;
  full[body.length + 1] = crc >> 8;
  return base32Encode(full);
}

export function isAccountId(s: string): boolean {
  const d = s.length === 56 && s.startsWith("G") ? decode(s) : null;
  return d !== null && d.version === VERSION_ACCOUNT && d.payload.length === 32;
}

export function isMuxedAccount(s: string): boolean {
  const d = s.length === 69 && s.startsWith("M") ? decode(s) : null;
  return d !== null && d.version === VERSION_MUXED && d.payload.length === 40;
}

/** For a valid M... address, the underlying G... account; for a valid G... address, itself; otherwise null. */
export function baseAccountOf(s: string): string | null {
  if (isAccountId(s)) return s;
  if (!isMuxedAccount(s)) return null;
  const d = decode(s)!;
  return encode(VERSION_ACCOUNT, d.payload.slice(0, 32));
}

export function isStellarAddress(s: string): boolean {
  return isAccountId(s) || isMuxedAccount(s);
}
