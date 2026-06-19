/**
 * WHISPR — useMessages Hook
 *
 * Fetches, decrypts, and sends encrypted messages for a conversation.
 * All encryption/decryption happens on-device via lib/crypto.ts.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import {
  deriveSharedSecret,
  deriveMessageKey,
  encryptMessage,
  decryptMessage,
} from '../lib/crypto';
import { getPrivateKeys, getReceiverPublicKeys } from '../lib/keystore';
import type { Message, DecryptedMessage } from '../types';

interface UseMessagesReturn {
  messages: DecryptedMessage[];
  loading: boolean;
  error: string | null;
  sendMessage: (plaintext: string) => Promise<void>;
  markAsRead: () => Promise<void>;
}

/**
 * Hook for managing encrypted messages in a conversation.
 *
 * @param receiverUserId - The UUID of the other user in the conversation
 * @param currentUserId - The UUID of the current authenticated user
 */
export function useMessages(
  receiverUserId: string,
  currentUserId: string
): UseMessagesReturn {
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messageKey, setMessageKey] = useState<string | null>(null);

  /**
   * Derive the shared message key for this conversation.
   * Uses X25519 ECDH + HMAC-SHA512/256 KDF.
   */
  useEffect(() => {
    let cancelled = false;

    async function deriveKey() {
      try {
        const privateKeys = await getPrivateKeys();
        if (!privateKeys) {
          throw new Error('Private keys not found. Please log in again.');
        }

        const receiverKeys = await getReceiverPublicKeys(receiverUserId);
        if (!receiverKeys) {
          throw new Error('Receiver public keys not found.');
        }

        // X25519 ECDH: derive shared secret from my private key + their public key
        const sharedSecret = await deriveSharedSecret(
          privateKeys.prekeyPrivateKey,
          receiverKeys.signed_prekey
        );

        // Derive symmetric message key from shared secret
        const key = await deriveMessageKey(sharedSecret);

        if (!cancelled) {
          setMessageKey(key);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to derive keys');
        }
      }
    }

    deriveKey();
    return () => { cancelled = true; };
  }, [receiverUserId]);

  /**
   * Fetch and decrypt message history once the key is derived.
   */
  useEffect(() => {
    if (!messageKey) return;
    const key = messageKey; // capture for closure narrowing
    let cancelled = false;

    async function fetchMessages() {
      try {
        setLoading(true);

        // Fetch messages between the two users (both directions)
        const { data, error: fetchError } = await supabase
          .from('messages')
          .select('*')
          .or(
            `and(sender_id.eq.${currentUserId},receiver_id.eq.${receiverUserId}),` +
            `and(sender_id.eq.${receiverUserId},receiver_id.eq.${currentUserId})`
          )
          .eq('message_type', 'text')
          .order('created_at', { ascending: true });

        if (fetchError) {
          throw new Error(`Failed to fetch messages: ${fetchError.message}`);
        }

        if (!data || cancelled) return;

        // Decrypt each message on-device
        const decrypted: DecryptedMessage[] = [];
        for (const msg of data as Message[]) {
          try {
            const content = await decryptMessage(msg.ciphertext, msg.nonce, key);
            decrypted.push({
              id: msg.id,
              senderId: msg.sender_id,
              receiverId: msg.receiver_id,
              content,
              messageType: msg.message_type,
              delivered: msg.delivered,
              read: msg.read,
              createdAt: new Date(msg.created_at),
              isMine: msg.sender_id === currentUserId,
            });
          } catch {
            // If a single message fails to decrypt, show placeholder
            decrypted.push({
              id: msg.id,
              senderId: msg.sender_id,
              receiverId: msg.receiver_id,
              content: '🔒 Unable to decrypt message',
              messageType: msg.message_type,
              delivered: msg.delivered,
              read: msg.read,
              createdAt: new Date(msg.created_at),
              isMine: msg.sender_id === currentUserId,
            });
          }
        }

        if (!cancelled) {
          setMessages(decrypted);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load messages');
          setLoading(false);
        }
      }
    }

    fetchMessages();
    return () => { cancelled = true; };
  }, [messageKey, currentUserId, receiverUserId]);

  /**
   * Send an encrypted message.
   *
   * Flow:
   *   1. Encrypt plaintext with message key (on device)
   *   2. Insert encrypted blob + nonce into Supabase
   *   3. Supabase never sees plaintext
   */
  const sendMessage = useCallback(async (plaintext: string) => {
    if (!messageKey) {
      throw new Error('Message key not derived yet.');
    }

    // Encrypt on device BEFORE sending
    const { ciphertext, nonce } = await encryptMessage(plaintext, messageKey);

    // Insert encrypted blob into Supabase
    const { data, error: insertError } = await supabase
      .from('messages')
      .insert({
        sender_id: currentUserId,
        receiver_id: receiverUserId,
        ciphertext,
        nonce,
        message_type: 'text',
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to send message: ${insertError.message}`);
    }

    // Add to local state immediately (optimistic update)
    if (data) {
      const newMessage: DecryptedMessage = {
        id: data.id,
        senderId: currentUserId,
        receiverId: receiverUserId,
        content: plaintext,
        messageType: 'text',
        delivered: false,
        read: false,
        createdAt: new Date(data.created_at),
        isMine: true,
      };
      setMessages(prev => [...prev, newMessage]);
    }
  }, [messageKey, currentUserId, receiverUserId]);

  /**
   * Mark all unread messages from the other user as read.
   * Called when the receiver opens the chat screen.
   */
  const markAsRead = useCallback(async () => {
    const { error: updateError } = await supabase
      .from('messages')
      .update({ read: true })
      .eq('sender_id', receiverUserId)
      .eq('receiver_id', currentUserId)
      .eq('read', false);

    if (updateError) {
      console.error('Failed to mark messages as read:', updateError.message);
    }

    // Update local state
    setMessages(prev =>
      prev.map(msg =>
        !msg.isMine && !msg.read ? { ...msg, read: true } : msg
      )
    );
  }, [currentUserId, receiverUserId]);

  return { messages, loading, error, sendMessage, markAsRead };
}
