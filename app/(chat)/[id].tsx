/**
 * WHISPR — Chat Screen
 *
 * Individual encrypted conversation with another user.
 *
 * Flow:
 *   1. Derive shared secret (X25519 ECDH) + message key (HMAC-SHA512/256 KDF)
 *   2. Load + decrypt message history from Supabase
 *   3. Subscribe to Supabase Realtime for new messages + read receipts
 *   4. On send: encrypt on device → insert to Supabase → Supabase never sees plaintext
 *   5. On receive: Realtime delivers encrypted blob → decrypt on device → display
 *   6. On open: mark all incoming messages as read → sender sees double tick via Realtime
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { supabase } from '../../lib/supabase';
import { getPrivateKeys, getReceiverPublicKeys } from '../../lib/keystore';
import {
  deriveSharedSecret,
  deriveMessageKey,
  encryptMessage,
  decryptMessage,
} from '../../lib/crypto';
import { useRealtime } from '../../hooks/useRealtime';
import MessageBubble from '../../components/MessageBubble';
import type { DecryptedMessage, Message } from '../../types';

export default function ChatScreen() {
  const { id: receiverUserId, username } = useLocalSearchParams<{
    id: string;
    username?: string;
  }>();
  const navigation = useNavigation();

  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [messageKey, setMessageKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();

  // Responsive input bar sizing
  const sendBtnSize = Math.min(Math.max(screenWidth * 0.105, 36), 46);
  const inputHorizontalPad = Math.min(Math.max(screenWidth * 0.035, 10), 16);
  const inputBarPadH = Math.min(Math.max(screenWidth * 0.03, 10), 16);
  const inputMaxHeight = Math.min(Math.max(screenWidth * 0.3, 100), 150);
  const headerBarHeight = Platform.OS === 'ios' ? 44 : 56;
  const kbOffset = insets.top + headerBarHeight;
  const isDisabled = !inputText.trim() || sending || !messageKey;

  // Set the header title to the username
  useEffect(() => {
    if (username) {
      navigation.setOptions({ title: username });
    }
  }, [username, navigation]);

  // Get current user ID
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setCurrentUserId(session.user.id);
      }
    });
  }, []);

  /**
   * Step 1: Derive shared secret and message key
   */
  useEffect(() => {
    if (!currentUserId || !receiverUserId) return;
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

        // X25519 ECDH: my private + their public → shared secret
        const sharedSecret = await deriveSharedSecret(
          privateKeys.prekeyPrivateKey,
          receiverKeys.signed_prekey
        );

        // HMAC-SHA512/256 KDF: shared secret → 256-bit message key
        const key = await deriveMessageKey(sharedSecret);

        if (!cancelled) {
          setMessageKey(key);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to derive keys');
          setLoading(false);
        }
      }
    }

    deriveKey();
    return () => { cancelled = true; };
  }, [currentUserId, receiverUserId]);

  /**
   * Step 2: Load and decrypt message history
   */
  useEffect(() => {
    if (!messageKey || !currentUserId || !receiverUserId) return;
    const key = messageKey; // capture for closure narrowing
    let cancelled = false;

    async function loadMessages() {
      try {
        setLoading(true);

        const { data, error: fetchError } = await supabase
          .from('messages')
          .select('*')
          .or(
            `and(sender_id.eq.${currentUserId},receiver_id.eq.${receiverUserId}),` +
            `and(sender_id.eq.${receiverUserId},receiver_id.eq.${currentUserId})`
          )
          .order('created_at', { ascending: true });

        if (fetchError) throw fetchError;
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
            decrypted.push({
              id: msg.id,
              senderId: msg.sender_id,
              receiverId: msg.receiver_id,
              content: '🔒 Unable to decrypt',
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

          // Step 5: Mark incoming messages as read
          markMessagesAsRead();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load messages');
          setLoading(false);
        }
      }
    }

    loadMessages();
    return () => { cancelled = true; };
  }, [messageKey, currentUserId, receiverUserId]);

  /**
   * Step 5: Mark all unread messages from the other user as read.
   * Sender sees double tick (blue) via Realtime UPDATE subscription.
   */
  const markMessagesAsRead = useCallback(async () => {
    if (!currentUserId || !receiverUserId) return;

    const { error: updateError } = await supabase
      .from('messages')
      .update({ read: true })
      .eq('sender_id', receiverUserId)
      .eq('receiver_id', currentUserId)
      .eq('read', false);

    if (updateError) {
      console.error('Failed to mark as read:', updateError.message);
    }
  }, [currentUserId, receiverUserId]);

  /**
   * Step 3: Subscribe to Supabase Realtime
   */
  const handleNewMessage = useCallback((message: DecryptedMessage) => {
    setMessages(prev => {
      // Avoid duplicates
      if (prev.some(m => m.id === message.id)) return prev;
      return [...prev, message];
    });

    // Mark as read immediately since user has the chat open
    markMessagesAsRead();

    // Scroll to bottom
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [markMessagesAsRead]);

  const handleMessageUpdate = useCallback(
    (messageId: string, updates: { delivered?: boolean; read?: boolean }) => {
      setMessages(prev =>
        prev.map(msg =>
          msg.id === messageId
            ? { ...msg, ...updates }
            : msg
        )
      );
    },
    []
  );

  // Realtime subscription
  useRealtime({
    currentUserId: currentUserId || '',
    receiverUserId: receiverUserId || '',
    messageKey,
    onNewMessage: handleNewMessage,
    onMessageUpdate: handleMessageUpdate,
  });

  /**
   * Step 4: Send an encrypted message
   */
  async function handleSend() {
    const text = inputText.trim();
    if (!text || !messageKey || !currentUserId || !receiverUserId) return;

    setSending(true);
    setInputText('');

    try {
      // Encrypt on device BEFORE sending
      const { ciphertext, nonce } = await encryptMessage(text, messageKey);

      // Insert encrypted blob into Supabase — server never sees plaintext
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

      if (insertError) throw insertError;

      // Optimistic update — add to local state immediately
      if (data) {
        const newMsg: DecryptedMessage = {
          id: data.id,
          senderId: currentUserId,
          receiverId: receiverUserId,
          content: text,
          messageType: 'text',
          delivered: false,
          read: false,
          createdAt: new Date(data.created_at),
          isMine: true,
        };
        setMessages(prev => [...prev, newMsg]);

        // Scroll to bottom
        setTimeout(() => {
          flatListRef.current?.scrollToEnd({ animated: true });
        }, 100);
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to send message. Please try again.');
      setInputText(text); // Restore the text
    } finally {
      setSending(false);
    }
  }

  // Error state
  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorIcon}>⚠️</Text>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={kbOffset}
    >
      {/* Messages */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#6C63FF" />
          <Text style={styles.loadingText}>Decrypting messages...</Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={({ item }) => <MessageBubble message={item} />}
          keyExtractor={item => item.id}
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          onContentSizeChange={() => {
            flatListRef.current?.scrollToEnd({ animated: false });
          }}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyIcon}>🔐</Text>
              <Text style={styles.emptyTitle}>End-to-end encrypted</Text>
              <Text style={styles.emptySubtitle}>
                Messages are encrypted on your device.{'\n'}
                Not even the server can read them.
              </Text>
            </View>
          }
        />
      )}

      {/* Input bar */}
      <View style={[styles.inputBar, { paddingHorizontal: inputBarPadH, paddingBottom: Math.max(insets.bottom, 10) }]}>
        <TextInput
          style={[styles.textInput, { paddingHorizontal: inputHorizontalPad, maxHeight: inputMaxHeight, marginRight: inputBarPadH * 0.8 }]}
          placeholder="Type a message..."
          placeholderTextColor="#555"
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={5000}
          editable={!loading && !sending && !!messageKey}
        />
        <TouchableOpacity
          style={[
            styles.sendButton,
            {
              width: sendBtnSize,
              height: sendBtnSize,
              borderRadius: sendBtnSize * 0.28,
              backgroundColor: isDisabled ? '#1E1E2E' : '#FFFFFF',
            },
            !isDisabled && {
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.15,
              shadowRadius: 3,
              elevation: 2,
            },
          ]}
          onPress={handleSend}
          disabled={isDisabled}
          activeOpacity={0.75}
        >
          {sending ? (
            <ActivityIndicator color={isDisabled ? '#8E8E93' : '#00A5E3'} size="small" />
          ) : (
            <Svg
              width={sendBtnSize * 0.55}
              height={sendBtnSize * 0.55}
              viewBox="0 0 24 24"
              fill="none"
            >
              <Path
                d="M3.5,11.2 L3.5,5.2 C3.5,4.3 4.2,3.6 5.1,3.7 L21.1,11 A0.7,0.7 0 0 1 21.1,11.8 L11.5,11.2 Z"
                fill={isDisabled ? '#555566' : '#00A5E3'}
              />
              <Path
                d="M3.5,12.8 L3.5,18.8 C3.5,19.7 4.2,20.4 5.1,20.3 L21.1,13 A0.7,0.7 0 0 0 21.1,12.2 L11.5,12.8 Z"
                fill={isDisabled ? '#444455' : '#0082B4'}
              />
            </Svg>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingVertical: 12,
    flexGrow: 1,
  },
  loadingText: {
    color: '#8E8E93',
    fontSize: 14,
    marginTop: 12,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#8E8E93',
    textAlign: 'center',
    lineHeight: 19,
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  errorText: {
    color: '#FF453A',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: '#1E1E2E',
    backgroundColor: '#0F0F18',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#1A1A2E',
    borderRadius: 20,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
    color: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  sendButton: {
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 1,
  },
});
