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
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

export function bytesToString(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
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
