/**
 * WHISPR — Conversation List Screen
 *
 * Shows existing conversations and a "New Chat" button.
 *
 * PRIVACY: Does NOT show all registered users.
 * Users must enter a username manually to start a new conversation.
 * This prevents exposing the user list.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  TextInput,
  Modal,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
  StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { supabase } from '../../lib/supabase';
import type { Conversation, Profile, Message } from '../../types';
import { getPrivateKeys, getReceiverPublicKeys } from '../../lib/keystore';
import { deriveSharedSecret, deriveMessageKey, decryptMessage } from '../../lib/crypto';

export default function ConversationListScreen() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewChat, setShowNewChat] = useState(false);
  const [searchUsername, setSearchUsername] = useState('');
  const [searching, setSearching] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [currentUsername, setCurrentUsername] = useState('');
  const router = useRouter();
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // Responsive dropdown dimensions
  const dropdownWidth = Math.min(Math.max(screenWidth * 0.52, 180), 240);
  const headerBarHeight = Platform.OS === 'ios' ? 44 : 56;
  const dropdownTop = insets.top + headerBarHeight + 4;

  // Get current user and profile details
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setCurrentUserId(session.user.id);
        
        // Fetch current user's profile details
        supabase
          .from('profiles')
          .select('username')
          .eq('id', session.user.id)
          .single()
          .then(({ data, error }) => {
            if (data && !error) {
              setCurrentUsername(data.username);
            }
          });
      }
    });
  }, []);

  // Load conversations
  useEffect(() => {
    if (!currentUserId) return;
    loadConversations();
  }, [currentUserId]);

  /**
   * Load existing conversations by finding unique users
   * the current user has exchanged messages with.
   */
  const loadConversations = useCallback(async () => {
    if (!currentUserId) return;

    try {
      setLoading(true);

      // Fetch all messages involving this user
      const { data: messages, error } = await supabase
        .from('messages')
        .select('sender_id, receiver_id, ciphertext, nonce, message_type, created_at, read')
        .or(`sender_id.eq.${currentUserId},receiver_id.eq.${currentUserId}`)
        .order('created_at', { ascending: false });

      if (error) throw error;
      if (!messages || messages.length === 0) {
        setConversations([]);
        setLoading(false);
        return;
      }

      // Find unique conversation partners
      const partnerMap = new Map<string, { lastMsg: Message; unreadCount: number }>();
      for (const msg of messages as Message[]) {
        const partnerId = msg.sender_id === currentUserId
          ? msg.receiver_id
          : msg.sender_id;

        if (!partnerMap.has(partnerId)) {
          partnerMap.set(partnerId, {
            lastMsg: msg,
            unreadCount: 0,
          });
        }

        // Count unread messages from this partner
        if (msg.sender_id !== currentUserId && !msg.read) {
          const existing = partnerMap.get(partnerId)!;
          existing.unreadCount += 1;
        }
      }

      // Fetch usernames for all partners
      const partnerIds = Array.from(partnerMap.keys());
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username')
        .in('id', partnerIds);

      const profileMap = new Map<string, string>();
      if (profiles) {
        for (const p of profiles as Profile[]) {
          profileMap.set(p.id, p.username);
        }
      }

      // Decrypt last messages
      const privateKeys = await getPrivateKeys();
      const convos: Conversation[] = [];

      for (const [partnerId, data] of partnerMap.entries()) {
        let lastMessage: string | null = null;

        // Try to decrypt the last message for preview
        if (privateKeys) {
          try {
            // Use special labels for non-text message types
            const msgType = (data.lastMsg as any).message_type;
            if (msgType === 'screenshot_alert') {
              lastMessage = '⚠️ Screenshot taken';
            } else if (msgType === 'image') {
              lastMessage = '📷 Image';
            } else if (msgType === 'voice') {
              lastMessage = '🎵 Voice message';
            } else {
              const receiverKeys = await getReceiverPublicKeys(partnerId);
              if (receiverKeys) {
                const sharedSecret = await deriveSharedSecret(
                  privateKeys.prekeyPrivateKey,
                  receiverKeys.signed_prekey
                );
                const msgKey = await deriveMessageKey(sharedSecret);
                lastMessage = await decryptMessage(
                  data.lastMsg.ciphertext,
                  data.lastMsg.nonce,
                  msgKey
                );
                // Truncate for preview
                if (lastMessage.length > 40) {
                  lastMessage = lastMessage.substring(0, 40) + '...';
                }
              }
            }
          } catch {
            lastMessage = '🔒 Encrypted message';
          }
        }

        convos.push({
          userId: partnerId,
          username: profileMap.get(partnerId) || 'Unknown',
          lastMessage,
          lastMessageTime: new Date(data.lastMsg.created_at),
          unreadCount: data.unreadCount,
        });
      }

      // Sort by most recent
      convos.sort((a, b) => {
        const timeA = a.lastMessageTime?.getTime() || 0;
        const timeB = b.lastMessageTime?.getTime() || 0;
        return timeB - timeA;
      });

      setConversations(convos);
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  /**
   * Start a new chat by searching for a username.
   * Does NOT expose all users — user must type the exact username.
   */
  async function handleNewChat() {
    const username = searchUsername.trim().toLowerCase();
    if (!username) {
      Alert.alert('Error', 'Please enter a username.');
      return;
    }

    setSearching(true);
    try {
      // Look up the username
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, username')
        .eq('username', username)
        .limit(1);

      if (error) throw error;

      if (!profiles || profiles.length === 0) {
        Alert.alert('Not Found', `No user found with username "${username}".`);
        return;
      }

      const profile = profiles[0] as Profile;

      if (profile.id === currentUserId) {
        Alert.alert('Error', 'You cannot message yourself.');
        return;
      }

      // Check they have public keys (are properly registered)
      const receiverKeys = await getReceiverPublicKeys(profile.id);
      if (!receiverKeys) {
        Alert.alert(
          'Error',
          'This user has not set up encryption keys yet.'
        );
        return;
      }

      // Navigate to chat with this user
      setShowNewChat(false);
      setSearchUsername('');
      router.push(`/(chat)/${profile.id}?username=${profile.username}`);
    } catch (err) {
      Alert.alert('Error', 'Failed to search for user. Please try again.');
    } finally {
      setSearching(false);
    }
  }

  /**
   * Handle logout
   */
  async function handleLogout() {
    Alert.alert(
      'Sign Out',
      'Are you sure? Your encryption keys will remain on this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            await supabase.auth.signOut();
          },
        },
      ]
    );
  }

  function formatTime(date: Date | null): string {
    if (!date) return '';
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function renderConversation({ item }: { item: Conversation }) {
    return (
      <TouchableOpacity
        style={styles.conversationItem}
        onPress={() => router.push(`/(chat)/${item.userId}?username=${item.username}`)}
        activeOpacity={0.7}
      >
        {/* Avatar */}
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {item.username.charAt(0).toUpperCase()}
          </Text>
        </View>

        {/* Content */}
        <View style={styles.conversationContent}>
          <View style={styles.conversationHeader}>
            <Text style={styles.conversationName}>{item.username}</Text>
            <Text style={styles.conversationTime}>
              {formatTime(item.lastMessageTime)}
            </Text>
          </View>
          <View style={styles.conversationFooter}>
            <Text style={styles.conversationPreview} numberOfLines={1}>
              {item.lastMessage || '🔒 Encrypted'}
            </Text>
            {item.unreadCount > 0 && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadText}>{item.unreadCount}</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <TouchableOpacity
              style={styles.profileHeaderButton}
              onPress={() => setShowDropdown(true)}
              activeOpacity={0.7}
            >
              <View style={styles.headerAvatar}>
                <Text style={styles.headerAvatarText}>
                  {currentUsername ? currentUsername.charAt(0).toUpperCase() : 'U'}
                </Text>
              </View>
            </TouchableOpacity>
          ),
        }}
      />

      {/* Profile Dropdown Modal */}
      <Modal
        visible={showDropdown}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDropdown(false)}
      >
        <TouchableOpacity
          style={styles.dropdownOverlay}
          activeOpacity={1}
          onPress={() => setShowDropdown(false)}
        >
          <View style={[styles.dropdownMenu, { top: dropdownTop, width: dropdownWidth }]}>
            <View style={styles.dropdownHeader}>
              <Text style={styles.dropdownUsername}>@{currentUsername || 'user'}</Text>
              <Text style={styles.dropdownStatus}>Active Secure Session</Text>
            </View>
            
            <View style={styles.dropdownDivider} />
            
            <TouchableOpacity
              style={styles.dropdownItem}
              onPress={() => {
                setShowDropdown(false);
                router.push('/(chat)/settings');
              }}
            >
              <Text style={styles.dropdownItemText}>⚙️  Settings</Text>
            </TouchableOpacity>
            
            <View style={styles.dropdownDivider} />
            
            <TouchableOpacity
              style={styles.dropdownItem}
              onPress={() => {
                setShowDropdown(false);
                handleLogout();
              }}
            >
              <Text style={[styles.dropdownItemText, styles.dropdownLogoutText]}>
                🚪  Logout
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Conversation list */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#6C63FF" />
        </View>
      ) : conversations.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>💬</Text>
          <Text style={styles.emptyTitle}>No conversations yet</Text>
          <Text style={styles.emptySubtitle}>
            Tap the button below to start a new encrypted chat
          </Text>
        </View>
      ) : (
        <FlatList
          data={conversations}
          renderItem={renderConversation}
          keyExtractor={item => item.userId}
          style={styles.list}
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* New Chat FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setShowNewChat(true)}
        activeOpacity={0.8}
      >
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>

      {/* New Chat Modal */}
      <Modal
        visible={showNewChat}
        animationType="slide"
        transparent
        onRequestClose={() => setShowNewChat(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>New Encrypted Chat</Text>
            <Text style={styles.modalSubtitle}>
              Enter the exact username of the person you want to message
            </Text>

            <TextInput
              style={styles.modalInput}
              placeholder="Username"
              placeholderTextColor="#555"
              value={searchUsername}
              onChangeText={setSearchUsername}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              editable={!searching}
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => {
                  setShowNewChat(false);
                  setSearchUsername('');
                }}
                disabled={searching}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalStartButton, searching && styles.buttonDisabled]}
                onPress={handleNewChat}
                disabled={searching}
              >
                {searching ? (
                  <ActivityIndicator color="#FFF" size="small" />
                ) : (
                  <Text style={styles.modalStartText}>Start Chat</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  profileHeaderButton: {
    padding: 4,
    marginRight: 4,
  },
  headerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#6C63FF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerAvatarText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  dropdownOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  dropdownMenu: {
    position: 'absolute',
    right: 16,
    backgroundColor: '#12121F',
    borderRadius: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#1E1E2E',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 10,
  },
  dropdownHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  dropdownUsername: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 2,
  },
  dropdownStatus: {
    fontSize: 11,
    color: '#00B06F',
    fontWeight: '600',
  },
  dropdownDivider: {
    height: 0.5,
    backgroundColor: '#1E1E2E',
    marginVertical: 4,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  dropdownItemText: {
    fontSize: 14,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  dropdownLogoutText: {
    color: '#FF453A',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
    lineHeight: 20,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 100,
  },
  conversationItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: '#1E1E2E',
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#6C63FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  avatarText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  conversationContent: {
    flex: 1,
  },
  conversationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  conversationName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  conversationTime: {
    fontSize: 12,
    color: '#8E8E93',
  },
  conversationFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  conversationPreview: {
    fontSize: 14,
    color: '#8E8E93',
    flex: 1,
    marginRight: 8,
  },
  unreadBadge: {
    backgroundColor: '#6C63FF',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  unreadText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  fab: {
    position: 'absolute',
    bottom: 30,
    right: 24,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#6C63FF',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#6C63FF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  fabText: {
    fontSize: 28,
    color: '#FFFFFF',
    fontWeight: '300',
    marginTop: -2,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalContent: {
    backgroundColor: '#1A1A2E',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  modalSubtitle: {
    fontSize: 13,
    color: '#8E8E93',
    marginBottom: 20,
    lineHeight: 18,
  },
  modalInput: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#FFFFFF',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  modalCancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  modalCancelText: {
    color: '#8E8E93',
    fontSize: 15,
    fontWeight: '600',
  },
  modalStartButton: {
    flex: 1,
    backgroundColor: '#6C63FF',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalStartText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
