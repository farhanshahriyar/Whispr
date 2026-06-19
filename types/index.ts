/**
 * WHISPR — Type Definitions
 *
 * All types match the Supabase schema in supabase_schema.sql.
 * These types are used throughout the app for type safety.
 */

// ============================================================
// Database row types (match Supabase tables exactly)
// ============================================================

/** Matches `profiles` table */
export interface Profile {
  id: string;
  username: string;
  created_at: string;
}

/** Matches `public_keys` table */
export interface PublicKeyBundle {
  id: string;
  user_id: string;
  identity_key: string;    // Ed25519 public key (base64)
  signed_prekey: string;   // X25519 public key (base64)
  prekey_signature: string; // Ed25519 signature of prekey (base64)
  created_at: string;
}

/** Matches `messages` table */
export interface Message {
  id: string;
  sender_id: string;
  receiver_id: string;
  ciphertext: string;      // AES-256-GCM encrypted blob (base64)
  nonce: string;           // Encryption nonce (base64)
  message_type: 'text' | 'image' | 'voice';
  file_url: string | null;
  encrypted_key: string | null;
  delivered: boolean;
  read: boolean;
  created_at: string;
}

/** Matches `screenshot_alerts` table (Phase 3) */
export interface ScreenshotAlert {
  id: string;
  conversation_id: string;
  triggered_by: string;
  created_at: string;
}

// ============================================================
// Crypto types
// ============================================================

/** Keypair with base64-encoded keys */
export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

/** Result of encryption — ciphertext + nonce both needed for decryption */
export interface EncryptedPayload {
  ciphertext: string;  // base64
  nonce: string;       // base64
}

/** All keypairs generated during registration */
export interface GeneratedKeys {
  identityKeyPair: KeyPair;    // Ed25519 — signing
  signedPreKeyPair: KeyPair;   // X25519 — key exchange
  preKeySignature: string;      // base64 signature of prekey
}

// ============================================================
// App state types
// ============================================================

/** Decrypted message for UI display */
export interface DecryptedMessage {
  id: string;
  senderId: string;
  receiverId: string;
  content: string;
  messageType: 'text' | 'image' | 'voice';
  delivered: boolean;
  read: boolean;
  createdAt: Date;
  isMine: boolean;
}

/** Conversation preview for the conversation list */
export interface Conversation {
  userId: string;
  username: string;
  lastMessage: string | null;
  lastMessageTime: Date | null;
  unreadCount: number;
}
