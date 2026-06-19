/**
 * WHISPR — Key Store
 *
 * Handles cryptographic key generation, storage, and retrieval.
 *
 * SECURITY RULES:
 * - Private keys are stored ONLY in expo-secure-store (Android Keystore backed)
 * - Private keys NEVER leave the device
 * - Private keys NEVER go to Supabase, AsyncStorage, or any server
 * - Public keys are uploaded to Supabase (safe — public by design)
 *
 * Uses tweetnacl exclusively for all crypto operations.
 */

import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { supabase } from './supabase';
import { bytesToHex } from './crypto';
import type { GeneratedKeys, PublicKeyBundle } from '../types';

// SecureStore key identifiers
const IDENTITY_PRIVATE_KEY = 'whispr_identity_private_key';
const IDENTITY_PUBLIC_KEY = 'whispr_identity_public_key';
const PREKEY_PRIVATE_KEY = 'whispr_prekey_private_key';
const PREKEY_PUBLIC_KEY = 'whispr_prekey_public_key';

/**
 * Generate X25519 + Ed25519 keypairs using tweetnacl.
 *
 * - Ed25519 (identity keypair): used for message signing & identity verification
 * - X25519 (signed prekey): used for ECDH key exchange
 *
 * The prekey is signed with the identity key to prove ownership.
 *
 * @returns GeneratedKeys with all keypairs and prekey signature
 */
export async function generateKeyPairs(): Promise<GeneratedKeys> {
  // Generate Ed25519 identity keypair (for signing)
  const identityKeyPair = nacl.sign.keyPair();

  // Generate X25519 prekey keypair (for key exchange)
  const signedPreKeyPair = nacl.box.keyPair();

  // Sign the prekey public key with identity private key
  // This proves the prekey belongs to this identity
  const preKeySignature = nacl.sign.detached(
    signedPreKeyPair.publicKey,
    identityKeyPair.secretKey
  );

  return {
    identityKeyPair: {
      publicKey: bytesToHex(identityKeyPair.publicKey),
      privateKey: bytesToHex(identityKeyPair.secretKey),
    },
    signedPreKeyPair: {
      publicKey: bytesToHex(signedPreKeyPair.publicKey),
      privateKey: bytesToHex(signedPreKeyPair.secretKey),
    },
    preKeySignature: bytesToHex(preKeySignature),
  };
}

/**
 * Store private keys in expo-secure-store ONLY.
 * Also stores public keys locally for convenience (they are not secret).
 *
 * ❌ NEVER store private keys in AsyncStorage, Supabase, or anywhere else.
 * ✅ expo-secure-store uses Android Keystore (hardware-backed on modern devices).
 */
export async function storeKeys(keys: GeneratedKeys): Promise<void> {
  // Store private keys — DEVICE ONLY, NEVER leaves SecureStore
  await SecureStore.setItemAsync(IDENTITY_PRIVATE_KEY, keys.identityKeyPair.privateKey);
  await SecureStore.setItemAsync(PREKEY_PRIVATE_KEY, keys.signedPreKeyPair.privateKey);

  // Store public keys locally for quick access (these are not secret)
  await SecureStore.setItemAsync(IDENTITY_PUBLIC_KEY, keys.identityKeyPair.publicKey);
  await SecureStore.setItemAsync(PREKEY_PUBLIC_KEY, keys.signedPreKeyPair.publicKey);
}

/**
 * Retrieve private keys from SecureStore.
 * Returns null if keys don't exist (user hasn't registered on this device).
 */
export async function getPrivateKeys(): Promise<{
  identityPrivateKey: string;
  prekeyPrivateKey: string;
} | null> {
  const identityPrivateKey = await SecureStore.getItemAsync(IDENTITY_PRIVATE_KEY);
  const prekeyPrivateKey = await SecureStore.getItemAsync(PREKEY_PRIVATE_KEY);

  if (!identityPrivateKey || !prekeyPrivateKey) {
    return null;
  }

  return { identityPrivateKey, prekeyPrivateKey };
}

/**
 * Retrieve public keys from SecureStore (local copy).
 */
export async function getPublicKeys(): Promise<{
  identityPublicKey: string;
  prekeyPublicKey: string;
} | null> {
  const identityPublicKey = await SecureStore.getItemAsync(IDENTITY_PUBLIC_KEY);
  const prekeyPublicKey = await SecureStore.getItemAsync(PREKEY_PUBLIC_KEY);

  if (!identityPublicKey || !prekeyPublicKey) {
    return null;
  }

  return { identityPublicKey, prekeyPublicKey };
}

/**
 * Check if cryptographic keys exist on this device.
 * Returns true if the user has registered and keys are available.
 */
export async function hasKeys(): Promise<boolean> {
  const identityKey = await SecureStore.getItemAsync(IDENTITY_PRIVATE_KEY);
  return identityKey !== null;
}

/**
 * Upload public keys to Supabase `public_keys` table.
 * This is safe — public keys are designed to be shared.
 *
 * @param userId - The authenticated user's UUID
 * @param keys - The generated keypairs containing public keys and signature
 */
export async function uploadPublicKeys(
  userId: string,
  keys: GeneratedKeys
): Promise<void> {
  const { error } = await supabase.from('public_keys').insert({
    user_id: userId,
    identity_key: keys.identityKeyPair.publicKey,
    signed_prekey: keys.signedPreKeyPair.publicKey,
    prekey_signature: keys.preKeySignature,
  });

  if (error) {
    throw new Error(`Failed to upload public keys: ${error.message}`);
  }
}

/**
 * Fetch another user's public keys from Supabase.
 * Used before establishing an encrypted conversation.
 *
 * @param userId - The target user's UUID
 * @returns The user's public key bundle, or null if not found
 */
export async function getReceiverPublicKeys(
  userId: string
): Promise<PublicKeyBundle | null> {
  const { data, error } = await supabase
    .from('public_keys')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    return null;
  }

  return data as PublicKeyBundle;
}

/**
 * Delete all stored keys from SecureStore.
 * Use on logout or account deletion.
 */
export async function clearKeys(): Promise<void> {
  await SecureStore.deleteItemAsync(IDENTITY_PRIVATE_KEY);
  await SecureStore.deleteItemAsync(IDENTITY_PUBLIC_KEY);
  await SecureStore.deleteItemAsync(PREKEY_PRIVATE_KEY);
  await SecureStore.deleteItemAsync(PREKEY_PUBLIC_KEY);
}
