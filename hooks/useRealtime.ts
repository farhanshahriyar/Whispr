/**
 * WHISPR — useRealtime Hook
 *
 * Subscribes to Supabase Realtime for live message delivery, read receipts,
 * and message deletions (unsend).
 */

import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { decryptMessage } from '../lib/crypto';
import type { DecryptedMessage, Message } from '../types';

interface UseRealtimeOptions {
  /** The current authenticated user's UUID */
  currentUserId: string;
  /** The other user's UUID in this conversation */
  receiverUserId: string;
  /** The derived symmetric message key for decryption */
  messageKey: string | null;
  /** Callback when a new message is received and decrypted */
  onNewMessage: (message: DecryptedMessage) => void;
  /** Callback when a message's read/delivered status changes */
  onMessageUpdate: (messageId: string, updates: { delivered?: boolean; read?: boolean }) => void;
  /** Callback when a message is deleted (unsent) by the other user */
  onMessageDelete?: (messageId: string) => void;
}

/**
 * Hook that subscribes to Supabase Realtime for:
 *   1. New incoming messages → decrypt and display
 *   2. Message status updates → update delivered/read indicators
 *   3. Message deletions → remove from UI (unsend feature)
 *
 * Handles auto-reconnection automatically via Supabase Realtime.
 */
export function useRealtime({
  currentUserId,
  receiverUserId,
  messageKey,
  onNewMessage,
  onMessageUpdate,
  onMessageDelete,
}: UseRealtimeOptions): void {
  // Use refs for callbacks to avoid resubscribing on every render
  const onNewMessageRef = useRef(onNewMessage);
  const onMessageUpdateRef = useRef(onMessageUpdate);
  const onMessageDeleteRef = useRef(onMessageDelete);
  const messageKeyRef = useRef(messageKey);

  useEffect(() => {
    onNewMessageRef.current = onNewMessage;
  }, [onNewMessage]);

  useEffect(() => {
    onMessageUpdateRef.current = onMessageUpdate;
  }, [onMessageUpdate]);

  useEffect(() => {
    onMessageDeleteRef.current = onMessageDelete;
  }, [onMessageDelete]);

  useEffect(() => {
    messageKeyRef.current = messageKey;
  }, [messageKey]);

  useEffect(() => {
    if (!messageKey) return;

    // Channel name unique to this conversation
    const channelName = `messages:${currentUserId}:${receiverUserId}`;

    const channel = supabase
      .channel(channelName)
      // Listen for new messages sent TO me from this specific user
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${currentUserId}`,
        },
        async (payload) => {
          const msg = payload.new as Message;

          // Only handle messages from the current conversation partner
          if (msg.sender_id !== receiverUserId) return;

          const key = messageKeyRef.current;
          if (!key) return;

          try {
            // Decrypt on device
            const content = await decryptMessage(msg.ciphertext, msg.nonce, key);

            const decrypted: DecryptedMessage = {
              id: msg.id,
              senderId: msg.sender_id,
              receiverId: msg.receiver_id,
              content,
              messageType: msg.message_type,
              fileUrl: msg.file_url,
              encryptedKey: msg.encrypted_key,
              delivered: msg.delivered,
              read: msg.read,
              createdAt: new Date(msg.created_at),
              isMine: false,
            };

            onNewMessageRef.current(decrypted);
          } catch (err) {
            console.error('Failed to decrypt realtime message:', err);
            // Still show the message, but indicate decryption failure
            onNewMessageRef.current({
              id: msg.id,
              senderId: msg.sender_id,
              receiverId: msg.receiver_id,
              content: '🔒 Unable to decrypt message',
              messageType: msg.message_type,
              fileUrl: msg.file_url,
              encryptedKey: msg.encrypted_key,
              delivered: msg.delivered,
              read: msg.read,
              createdAt: new Date(msg.created_at),
              isMine: false,
            });
          }
        }
      )
      // Listen for updates to messages I SENT (read receipts, delivery status)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `sender_id=eq.${currentUserId}`,
        },
        (payload) => {
          const updated = payload.new as Message;

          // Only handle updates from this conversation
          if (updated.receiver_id !== receiverUserId) return;

          onMessageUpdateRef.current(updated.id, {
            delivered: updated.delivered,
            read: updated.read,
          });
        }
      )
      // Listen for message deletions (unsend for everyone)
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
        },
        (payload) => {
          const deleted = payload.old as Partial<Message>;
          if (!deleted.id) return;

          // If REPLICA IDENTITY FULL is set, we can filter by conversation.
          // If not, sender_id/receiver_id may be missing — in that case,
          // we still forward the delete and let the chat screen check
          // against its own local message list.
          if (deleted.sender_id && deleted.receiver_id) {
            const isFromConversation =
              (deleted.sender_id === receiverUserId && deleted.receiver_id === currentUserId) ||
              (deleted.sender_id === currentUserId && deleted.receiver_id === receiverUserId);

            if (!isFromConversation) return;
          }

          onMessageDeleteRef.current?.(deleted.id);
        }
      )
      .subscribe();

    // Cleanup: unsubscribe when component unmounts or deps change
    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUserId, receiverUserId, messageKey]);
}
