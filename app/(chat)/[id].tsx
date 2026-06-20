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
import * as ImagePicker from 'expo-image-picker';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '../../lib/supabase';
import { getPrivateKeys, getReceiverPublicKeys } from '../../lib/keystore';
import {
  deriveSharedSecret,
  deriveMessageKey,
  encryptMessage,
  decryptMessage,
  encryptFileKey,
} from '../../lib/crypto';
import { encryptFile } from '../../lib/fileEncryption';
import * as ScreenCapture from 'expo-screen-capture';
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
  
  // Media sharing and recording states (Phase 2)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingInstance, setRecordingInstance] = useState<Audio.Recording | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingTimerRef = useRef<any>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const startXRef = useRef<number>(0);
  const isCancelledRef = useRef<boolean>(false);
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

  // Enable screenshot prevention (this sets native FLAG_SECURE on Android and blocks recordings/screenshots)
  ScreenCapture.usePreventScreenCapture();

  // Handle screenshot alert creation
  const handleScreenshotDetected = useCallback(async () => {
    if (!currentUserId || !receiverUserId || !messageKey) return;

    const conversationId = currentUserId < receiverUserId
      ? `${currentUserId}:${receiverUserId}`
      : `${receiverUserId}:${currentUserId}`;

    try {
      // 1. Insert alert into screenshot_alerts table
      const { error: alertError } = await supabase
        .from('screenshot_alerts')
        .insert({
          conversation_id: conversationId,
          triggered_by: currentUserId,
        });

      if (alertError) {
        console.error('Failed to log screenshot alert:', alertError.message);
      }

      // 2. Encrypt alert warning message E2EE
      const alertPlaceholder = 'took a screenshot';
      const { ciphertext, nonce } = await encryptMessage(alertPlaceholder, messageKey);

      // 3. Insert encrypted screenshot warning message into messages table
      const { data, error: insertError } = await supabase
        .from('messages')
        .insert({
          sender_id: currentUserId,
          receiver_id: receiverUserId,
          ciphertext,
          nonce,
          message_type: 'screenshot_alert',
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // 4. Optimistic update
      if (data) {
        const newMsg: DecryptedMessage = {
          id: data.id,
          senderId: currentUserId,
          receiverId: receiverUserId,
          content: alertPlaceholder,
          messageType: 'screenshot_alert',
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
      console.error('Error handling screenshot detection:', err);
    }
  }, [currentUserId, receiverUserId, messageKey]);

  // Listen for screenshot events
  useEffect(() => {
    if (!messageKey || !currentUserId || !receiverUserId) return;
    let subscription: any;

    async function setupScreenshotListener() {
      try {
        const { status } = await ScreenCapture.requestPermissionsAsync();
        if (status === 'granted') {
          subscription = ScreenCapture.addScreenshotListener(() => {
            handleScreenshotDetected();
          });
        }
      } catch (err) {
        console.warn('Failed to setup screenshot listener:', err);
      }
    }

    setupScreenshotListener();

    return () => {
      if (subscription) {
        subscription.remove();
      }
    };
  }, [currentUserId, receiverUserId, messageKey, handleScreenshotDetected]);

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
              fileUrl: msg.file_url,
              encryptedKey: msg.encrypted_key,
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
              fileUrl: msg.file_url,
              encryptedKey: msg.encrypted_key,
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

  /**
   * Encrypt, upload to storage, and send public-key encrypted file key message
   */
  async function sendMediaMessage(localUri: string, type: 'image' | 'voice') {
    if (!messageKey || !currentUserId || !receiverUserId) return;

    setSending(true);
    setUploadProgress(0);

    try {
      // 1. Encrypt file bytes on device
      const { encryptedBytes, fileKeyHex } = await encryptFile(localUri);

      // Convert Uint8Array to ArrayBuffer for React Native fetch compatibility
      const arrayBuffer = (encryptedBytes.buffer as ArrayBuffer).slice(
        encryptedBytes.byteOffset,
        encryptedBytes.byteOffset + encryptedBytes.byteLength
      );

      // 2. Generate unique filename for storage
      const fileExtension = type === 'image' ? 'jpg' : 'm4a';
      const fileName = `${currentUserId}/${Date.now()}.${fileExtension}`;

      // 3. Upload encrypted bytes to Supabase Storage media bucket
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('media')
        .upload(fileName, arrayBuffer, {
          contentType: 'application/octet-stream',
          onUploadProgress: (progress: any) => {
            const percent = Math.round((progress.loaded / progress.total) * 100);
            setUploadProgress(percent);
          },
        } as any);

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('media')
        .getPublicUrl(fileName);

      // 4. Fetch receiver's public keys
      const receiverKeys = await getReceiverPublicKeys(receiverUserId);
      if (!receiverKeys) throw new Error('Receiver public keys not found');

      // Fetch my private keys
      const privateKeys = await getPrivateKeys();
      if (!privateKeys) throw new Error('Private keys not found');

      // 5. Encrypt file key for receiver using public-key encryption (ECDH nacl.box)
      const encryptedKey = await encryptFileKey(
        fileKeyHex,
        receiverKeys.signed_prekey,
        privateKeys.prekeyPrivateKey
      );

      // 6. Encrypt message placeholder using conversation key
      const placeholderText = type === 'image' ? '📷 Image' : '🎵 Voice message';
      const { ciphertext, nonce } = await encryptMessage(placeholderText, messageKey);

      // 7. Insert message record
      const { data, error: insertError } = await supabase
        .from('messages')
        .insert({
          sender_id: currentUserId,
          receiver_id: receiverUserId,
          ciphertext,
          nonce,
          message_type: type,
          file_url: publicUrl,
          encrypted_key: encryptedKey,
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // 8. Optimistic update
      if (data) {
        const newMsg: DecryptedMessage = {
          id: data.id,
          senderId: currentUserId,
          receiverId: receiverUserId,
          content: placeholderText,
          messageType: type,
          fileUrl: publicUrl,
          encryptedKey: encryptedKey,
          delivered: false,
          read: false,
          createdAt: new Date(data.created_at),
          isMine: true,
        };
        setMessages(prev => [...prev, newMsg]);
        setTimeout(() => {
          flatListRef.current?.scrollToEnd({ animated: true });
        }, 100);
      }
    } catch (err) {
      console.error('Error sending media message:', err);
      Alert.alert('Error', `Failed to send ${type === 'image' ? 'image' : 'voice message'}. Please try again.`);
    } finally {
      setSending(false);
      setUploadProgress(null);
    }
  }

  /**
   * Launch camera or gallery to pick image
   */
  async function selectImage(useCamera: boolean) {
    try {
      const permissionResult = useCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permissionResult.granted) {
        Alert.alert('Permission Denied', `Permission to access the ${useCamera ? 'camera' : 'gallery'} is required.`);
        return;
      }

      const result = useCamera
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            quality: 0.7,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            quality: 0.7,
          });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const uri = result.assets[0].uri;
        await sendMediaMessage(uri, 'image');
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to pick image.');
    }
  }

  /**
   * Display attachment selection dialog
   */
  function showAttachmentOptions() {
    Alert.alert(
      'Send Media',
      'Choose an option:',
      [
        { text: '📷 Take Photo', onPress: () => selectImage(true) },
        { text: '🖼️ Choose from Gallery', onPress: () => selectImage(false) },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  }

  /**
   * Start recording audio
   */
  async function handleStartRecording() {
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission Denied', 'Microphone permission is required to record voice notes.');
        return;
      }

      // Clean up any existing recording instance first
      if (recordingInstance) {
        try {
          const status = await recordingInstance.getStatusAsync();
          if (status.isRecording || status.canRecord) {
            await recordingInstance.stopAndUnloadAsync();
          }
        } catch {
          // Already unloaded, ignore
        }
        setRecordingInstance(null);
      }

      // Configure audio session for recording
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      setRecordingInstance(recording);
      setIsRecording(true);
      setRecordingDuration(0);
      recordingStartTimeRef.current = Date.now();

      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((prev) => {
          if (prev >= 300) { // 5 minutes limit
            handleStopRecording(true);
            return 300;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (err) {
      console.error('Failed to start recording:', err);
      Alert.alert('Error', 'Failed to start recording voice note.');
    }
  }

  /**
   * Stop recording audio
   */
  async function handleStopRecording(shouldSend: boolean) {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    if (!recordingInstance) return;

    setIsRecording(false);
    try {
      await recordingInstance.stopAndUnloadAsync();
      const uri = recordingInstance.getURI();
      setRecordingInstance(null);
      setRecordingDuration(0);

      const durationMs = Date.now() - (recordingStartTimeRef.current || Date.now());
      recordingStartTimeRef.current = null;

      if (shouldSend && uri) {
        if (durationMs < 1000) {
          Alert.alert('Hold to Record', 'Hold the microphone button to record. Release to send.');
          await FileSystem.deleteAsync(uri, { idempotent: true });
        } else {
          await sendMediaMessage(uri, 'voice');
        }
      } else if (uri) {
        // Discarded recording
        await FileSystem.deleteAsync(uri, { idempotent: true });
      }
    } catch (err) {
      console.error('Failed to stop recording:', err);
    }
  }

  function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Swipe-to-cancel gestures via Touch events
  function handleTouchStart(e: any) {
    startXRef.current = e.nativeEvent.pageX;
    isCancelledRef.current = false;
    handleStartRecording();
  }

  function handleTouchMove(e: any) {
    if (isCancelledRef.current || !isRecording) return;
    const currentX = e.nativeEvent.pageX;
    // Slide left by 60px to cancel
    if (startXRef.current - currentX > 60) {
      isCancelledRef.current = true;
      handleStopRecording(false);
      Alert.alert('Recording Discarded', 'Voice note recording was deleted.');
    }
  }

  function handleTouchEnd() {
    if (isCancelledRef.current) return;
    handleStopRecording(true);
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
          renderItem={({ item }) => <MessageBubble message={item} partnerUsername={username} />}
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

      {/* Upload progress indicator */}
      {uploadProgress !== null && (
        <View style={styles.progressContainer}>
          <ActivityIndicator size="small" color="#6C63FF" style={{ marginRight: 8 }} />
          <Text style={styles.progressText}>Uploading encrypted media: {uploadProgress}%</Text>
        </View>
      )}

      {/* Input bar */}
      <View style={[styles.inputBar, { paddingHorizontal: inputBarPadH, paddingBottom: Math.max(insets.bottom, 10) }]}>
        {isRecording ? (
          <>
            <View style={styles.recordingRow}>
              <Text style={styles.recordingText}>🔴 Recording: {formatDuration(recordingDuration)}</Text>
              <Text style={styles.slideText}>← Slide left to cancel</Text>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => handleStopRecording(false)}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
            
            <View
              style={[
                styles.sendButton,
                {
                  width: sendBtnSize,
                  height: sendBtnSize,
                  borderRadius: sendBtnSize * 0.28,
                  backgroundColor: '#FF453A',
                },
              ]}
              onTouchStart={(loading || sending || !messageKey) ? undefined : handleTouchStart}
              onTouchMove={(loading || sending || !messageKey) ? undefined : handleTouchMove}
              onTouchEnd={(loading || sending || !messageKey) ? undefined : handleTouchEnd}
            >
              {sending ? (
                <ActivityIndicator color="#6C63FF" size="small" />
              ) : (
                <Text style={{ fontSize: 18, color: '#FFFFFF' }}>🎙️</Text>
              )}
            </View>
          </>
        ) : (
          <>
            <TouchableOpacity
              style={styles.attachButton}
              onPress={showAttachmentOptions}
              disabled={loading || sending || !messageKey}
              activeOpacity={0.7}
            >
              <Text style={styles.attachText}>+</Text>
            </TouchableOpacity>
            <TextInput
              style={[styles.textInput, { paddingHorizontal: inputHorizontalPad, maxHeight: inputMaxHeight, marginRight: 8 }]}
              placeholder="Type a message..."
              placeholderTextColor="#555"
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={5000}
              editable={!loading && !sending && !!messageKey}
              autoCorrect={false}
              autoComplete="off"
            />

            {/* Mic button */}
            <View
              style={[
                styles.sendButton,
                {
                  width: sendBtnSize,
                  height: sendBtnSize,
                  borderRadius: sendBtnSize * 0.28,
                  backgroundColor: '#1E1E2E',
                  marginRight: 6,
                },
              ]}
              onTouchStart={(loading || sending || !messageKey) ? undefined : handleTouchStart}
              onTouchMove={(loading || sending || !messageKey) ? undefined : handleTouchMove}
              onTouchEnd={(loading || sending || !messageKey) ? undefined : handleTouchEnd}
            >
              {sending ? (
                <ActivityIndicator color="#6C63FF" size="small" />
              ) : (
                <Text style={{ fontSize: 18, color: '#8E8E93' }}>🎙️</Text>
              )}
            </View>

            {/* Send button (always visible, disabled if no text) */}
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
          </>
        )}
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
  attachButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#161622',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  attachText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '300',
    marginTop: -2,
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0F0F18',
    paddingVertical: 10,
    borderTopWidth: 0.5,
    borderTopColor: '#1E1E2E',
  },
  progressText: {
    color: '#8E8E93',
    fontSize: 13,
  },
  recordingRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 8,
  },
  recordingText: {
    color: '#FF453A',
    fontWeight: '700',
    fontSize: 14,
  },
  slideText: {
    color: '#8E8E93',
    fontSize: 12,
    fontStyle: 'italic',
  },
  cancelButton: {
    backgroundColor: '#1E1E2E',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  cancelText: {
    color: '#FF453A',
    fontSize: 12,
    fontWeight: '600',
  },
});
