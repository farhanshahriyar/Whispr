/**
 * WHISPR — Crypto Module (Pure JS Fallback for Expo Go)
 *
 * All encryption and decryption logic lives here — NOWHERE ELSE.
 *
 * Phase 1 protocol (simplified Signal):
 *   1. X25519 ECDH (tweetnacl) → shared secret
 *   2. HMAC-SHA512 (js-sha512) → derive symmetric message key (truncated to 32 bytes)
 *   3. XSalsa20-Poly1305 (tweetnacl secretbox) → encrypt/decrypt messages
 *   4. Ed25519 (tweetnacl sign) → sign/verify message authenticity
 *
 * SECURITY RULES:
 * - Uses pure JS (tweetnacl/js-sha512) ONLY — compatible with Expo Go
 * - Encrypts on device BEFORE sending anywhere
 * - Decrypts on device AFTER receiving
 * - Never stores plaintext in Supabase
 */

import nacl from 'tweetnacl';
import { sha512 } from 'js-sha512';
import * as Crypto from 'expo-crypto';
import type { EncryptedPayload } from '../types';

// Context string for key derivation (used as HMAC key domain separator)
const KDF_CONTEXT = 'whispr-v1-msg-key';

// Configure tweetnacl's random number generator to use expo-crypto
nacl.setPRNG((x, n) => {
  const bytes = new Uint8Array(n);
  Crypto.getRandomValues(bytes);
  for (let i = 0; i < n; i++) {
    x[i] = bytes[i];
  }
});

// ============================================================
// Helper Utilities for Type Conversions (Hex ↔ Bytes ↔ String)
// ============================================================

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function stringToHex(str: string): string {
  return bytesToHex(stringToBytes(str));
}

export function hexToString(hex: string): string {
  return bytesToString(hexToBytes(hex));
}

// ============================================================
// Cryptographic Operations
// ============================================================

/**
 * Derive a shared secret using X25519 ECDH key exchange.
 */
export async function deriveSharedSecret(
  myPrivateKey: string,
  theirPublicKey: string
): Promise<string> {
  const mySkBytes = hexToBytes(myPrivateKey);
  const theirPkBytes = hexToBytes(theirPublicKey);

  // nacl.scalarMult performs X25519 ECDH
  const sharedSecretBytes = nacl.scalarMult(mySkBytes, theirPkBytes);
  return bytesToHex(sharedSecretBytes);
}

/**
 * Derive a symmetric message key from a shared secret.
 * Uses HMAC-SHA512 KDF, truncated to 32 bytes (HMAC-SHA512/256 style).
 */
export async function deriveMessageKey(
  sharedSecret: string
): Promise<string> {
  const keyBytes = hexToBytes(sharedSecret);
  const messageBytes = stringToBytes(KDF_CONTEXT);

  // Compute HMAC-SHA512
  const hmacBytes = sha512.hmac.create(keyBytes as any).update(messageBytes).array();

  // Truncate to first 32 bytes (256-bit key) for secretbox
  const messageKeyBytes = new Uint8Array(hmacBytes.slice(0, 32));
  return bytesToHex(messageKeyBytes);
}

/**
 * Encrypt a plaintext message using XSalsa20-Poly1305 (secretbox).
 */
export async function encryptMessage(
  plaintext: string,
  messageKey: string
): Promise<EncryptedPayload> {
  // Generate a random 24-byte nonce
  const nonceBytes = nacl.randomBytes(24);
  const plaintextBytes = stringToBytes(plaintext);
  const keyBytes = hexToBytes(messageKey);

  // Encrypt with XSalsa20-Poly1305
  const ciphertextBytes = nacl.secretbox(plaintextBytes, nonceBytes, keyBytes);

  return {
    ciphertext: bytesToHex(ciphertextBytes),
    nonce: bytesToHex(nonceBytes),
  };
}

/**
 * Decrypt a ciphertext message using XSalsa20-Poly1305 (secretbox).
 */
export async function decryptMessage(
  ciphertext: string,
  nonce: string,
  messageKey: string
): Promise<string> {
  try {
    const ciphertextBytes = hexToBytes(ciphertext);
    const nonceBytes = hexToBytes(nonce);
    const keyBytes = hexToBytes(messageKey);

    // Decrypt and verify
    const plaintextBytes = nacl.secretbox.open(ciphertextBytes, nonceBytes, keyBytes);
    if (!plaintextBytes) {
      throw new Error('Verification failed');
    }

    return bytesToString(plaintextBytes);
  } catch (error) {
    throw new Error(
      'Message decryption failed. The message may have been tampered with, ' +
      'or the wrong key was used.'
    );
  }
}

/**
 * Sign a message with Ed25519 for authenticity verification.
 */
export async function signMessage(
  message: string,
  privateSigningKey: string
): Promise<string> {
  const messageBytes = hexToBytes(message);
  const secretKeyBytes = hexToBytes(privateSigningKey);

  const signatureBytes = nacl.sign.detached(messageBytes, secretKeyBytes);
  return bytesToHex(signatureBytes);
}

/**
 * Verify an Ed25519 signature.
 */
export async function verifySignature(
  signature: string,
  message: string,
  publicSigningKey: string
): Promise<boolean> {
  try {
    const signatureBytes = hexToBytes(signature);
    const messageBytes = hexToBytes(message);
    const publicKeyBytes = hexToBytes(publicSigningKey);

    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

/**
 * Convert an Ed25519 public key to an X25519 public key.
 * Stubbed since signing & encryption use separate keys in Phase 1.
 */
export async function ed25519PkToX25519(
  ed25519PublicKey: string
): Promise<string> {
  throw new Error('Key conversion is not supported in pure JS fallback mode.');
}

/**
 * Convert an Ed25519 private key to an X25519 private key.
 * Stubbed since signing & encryption use separate keys in Phase 1.
 */
export async function ed25519SkToX25519(
  ed25519PrivateKey: string
): Promise<string> {
  throw new Error('Key conversion is not supported in pure JS fallback mode.');
}

// ============================================================
// Base64 & File Key Encryption Helpers (Phase 2)
// ============================================================

const b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  const l = bytes.length;
  for (let i = 0; i < l; i += 3) {
    const c1 = bytes[i];
    const c2 = i + 1 < l ? bytes[i + 1] : NaN;
    const c3 = i + 2 < l ? bytes[i + 2] : NaN;
    const byte1 = c1 >> 2;
    const byte2 = ((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4);
    const byte3 = isNaN(c2) ? 64 : ((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 6);
    const byte4 = isNaN(c3) ? 64 : c3 & 63;
    result += b64Chars.charAt(byte1) + b64Chars.charAt(byte2) +
      (byte3 === 64 ? '=' : b64Chars.charAt(byte3)) +
      (byte4 === 64 ? '=' : b64Chars.charAt(byte4));
  }
  return result;
}

export function base64ToBytes(base64: string): Uint8Array {
  // Strip whitespace, newlines, and padding before decoding
  const cleaned = base64.replace(/[\s=]+/g, '');
  const len = cleaned.length;
  const bufferLength = Math.floor(len * 3 / 4);
  const bytes = new Uint8Array(bufferLength);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const encoded1 = b64Chars.indexOf(cleaned[i]);
    const encoded2 = i + 1 < len ? b64Chars.indexOf(cleaned[i + 1]) : 0;
    const encoded3 = i + 2 < len ? b64Chars.indexOf(cleaned[i + 2]) : 0;
    const encoded4 = i + 3 < len ? b64Chars.indexOf(cleaned[i + 3]) : 0;
    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (p < bufferLength) bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    if (p < bufferLength) bytes[p++] = ((encoded3 & 3) << 6) | encoded4;
  }
  return bytes;
}

/**
 * Encrypt a file key using public-key encryption (nacl.box) for the receiver.
 * Format is "nonce_hex:ciphertext_hex"
 */
export async function encryptFileKey(
  fileKeyHex: string,
  theirPublicKeyHex: string,
  myPrivateKeyHex: string
): Promise<string> {
  const fileKeyBytes = hexToBytes(fileKeyHex);
  const theirPkBytes = hexToBytes(theirPublicKeyHex);
  const mySkBytes = hexToBytes(myPrivateKeyHex);
  const nonceBytes = nacl.randomBytes(24);

  const encryptedBytes = nacl.box(
    fileKeyBytes,
    nonceBytes,
    theirPkBytes,
    mySkBytes
  );

  return bytesToHex(nonceBytes) + ':' + bytesToHex(encryptedBytes);
}

/**
 * Decrypt a file key using public-key decryption (nacl.box.open) from the sender.
 */
export async function decryptFileKey(
  encryptedFileKey: string,
  theirPublicKeyHex: string,
  myPrivateKeyHex: string
): Promise<string> {
  const parts = encryptedFileKey.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted file key format');
  }

  const nonceBytes = hexToBytes(parts[0]);
  const encryptedBytes = hexToBytes(parts[1]);
  const theirPkBytes = hexToBytes(theirPublicKeyHex);
  const mySkBytes = hexToBytes(myPrivateKeyHex);

  const decryptedBytes = nacl.box.open(
    encryptedBytes,
    nonceBytes,
    theirPkBytes,
    mySkBytes
  );

  if (!decryptedBytes) {
    throw new Error('Failed to decrypt file key');
  }

  return bytesToHex(decryptedBytes);
}

/**
 * Encrypt file bytes using XSalsa20-Poly1305 (secretbox).
 * Returns the key (hex) and the encrypted payload (combined nonce + ciphertext) as Uint8Array.
 */
export function encryptFileBytes(
  fileBytes: Uint8Array
): { encryptedBytes: Uint8Array; fileKeyHex: string } {
  const fileKeyBytes = nacl.randomBytes(32);
  const nonceBytes = nacl.randomBytes(24);

  const ciphertextBytes = nacl.secretbox(fileBytes, nonceBytes, fileKeyBytes);

  const encryptedBytes = new Uint8Array(nonceBytes.length + ciphertextBytes.length);
  encryptedBytes.set(nonceBytes, 0);
  encryptedBytes.set(ciphertextBytes, nonceBytes.length);

  return {
    encryptedBytes,
    fileKeyHex: bytesToHex(fileKeyBytes),
  };
}

/**
 * Decrypt file bytes using XSalsa20-Poly1305 (secretbox).
 * Takes combined nonce + ciphertext and the hex key.
 */
export function decryptFileBytes(
  encryptedBytes: Uint8Array,
  fileKeyHex: string
): Uint8Array {
  if (encryptedBytes.length < 24) {
    throw new Error('Encrypted file bytes too short');
  }

  const nonceBytes = encryptedBytes.slice(0, 24);
  const ciphertextBytes = encryptedBytes.slice(24);
  const fileKeyBytes = hexToBytes(fileKeyHex);

  const decryptedBytes = nacl.secretbox.open(
    ciphertextBytes,
    nonceBytes,
    fileKeyBytes
  );

  if (!decryptedBytes) {
    throw new Error('File decryption verification failed');
  }

  return decryptedBytes;
}


