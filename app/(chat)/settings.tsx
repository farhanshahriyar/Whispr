/**
 * WHISPR — Settings Screen
 *
 * Displays the current user's profile, cryptographic public keys,
 * security instructions, and logout/device-wipe options.
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { getPublicKeys, clearKeys } from '../../lib/keystore';

export default function SettingsScreen() {
  const [username, setUsername] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [keys, setKeys] = useState<{
    identityPublicKey: string;
    prekeyPublicKey: string;
  } | null>(null);
  const router = useRouter();
  const { width: screenWidth } = useWindowDimensions();

  // Responsive sizing based on screen width
  const avatarSize = Math.min(Math.max(screenWidth * 0.15, 52), 68);
  const contentPadding = Math.min(Math.max(screenWidth * 0.04, 14), 20);
  const cardPadding = Math.min(Math.max(screenWidth * 0.05, 16), 24);
  const cardRadius = Math.min(Math.max(screenWidth * 0.04, 12), 18);

  useEffect(() => {
    async function loadSettingsData() {
      try {
        setLoading(true);

        // 1. Get Session & Profile info
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('username')
            .eq('id', session.user.id)
            .single();

          if (profile) {
            setUsername(profile.username);
          }
        }

        // 2. Get local public keys for security verification
        const localKeys = await getPublicKeys();
        if (localKeys) {
          setKeys(localKeys);
        }
      } catch (err) {
        console.error('Failed to load settings data:', err);
      } finally {
        setLoading(false);
      }
    }

    loadSettingsData();
  }, []);

  /**
   * Format public key as a security fingerprint (blocks of 4 characters)
   */
  function formatFingerprint(key: string): string {
    if (!key) return '';
    const cleanKey = key.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const parts = [];
    for (let i = 0; i < cleanKey.length && i < 24; i += 4) {
      parts.push(cleanKey.substring(i, i + 4));
    }
    return parts.join(' ');
  }

  /**
   * Handle regular logout
   */
  async function handleLogout() {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out? Your encryption keys will remain securely stored on this device.',
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

  /**
   * Handle wiping all keys and logging out
   */
  async function handleWipeKeys() {
    Alert.alert(
      'CRITICAL: Wipe Keys',
      'This will delete your cryptographic identity keys from this device. You will NOT be able to decrypt past messages. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Wipe Everything',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Final Confirmation Required',
              'Are you absolutely sure? This action is permanent and cannot be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Yes, Wipe Keys',
                  style: 'destructive',
                  onPress: async () => {
                    await clearKeys();
                    await supabase.auth.signOut();
                  },
                },
              ]
            );
          },
        },
      ]
    );
  }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#6C63FF" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { padding: contentPadding }]}>
      {/* Profile Card */}
      <View style={[styles.card, { padding: cardPadding, borderRadius: cardRadius }]}>
        <View style={styles.profileSection}>
          <View style={[styles.avatar, { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }]}>
            <Text style={[styles.avatarText, { fontSize: avatarSize * 0.4 }]}>
              {username ? username.charAt(0).toUpperCase() : 'U'}
            </Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.usernameText}>@{username || 'user'}</Text>
            <View style={styles.shieldBadge}>
              <Text style={styles.shieldIcon}>🛡️</Text>
              <Text style={styles.shieldText}>Secured session active</Text>
            </View>
          </View>
        </View>
      </View>

      {/* Encryption Fingerprint Card */}
      <View style={[styles.card, { padding: cardPadding, borderRadius: cardRadius }]}>
        <Text style={styles.cardTitle}>Crypto Fingerprint</Text>
        <Text style={styles.cardSubtitle}>
          Verify this fingerprint with contacts to confirm your end-to-end encrypted connection is secure.
        </Text>

        {keys ? (
          <View style={styles.keysSection}>
            <View style={styles.keyContainer}>
              <Text style={styles.keyLabel}>Identity Key (Ed25519)</Text>
              <Text style={styles.keyFingerprint} selectable>
                {formatFingerprint(keys.identityPublicKey)}
              </Text>
              <Text style={styles.keyRaw} numberOfLines={1} selectable>
                {keys.identityPublicKey}
              </Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.keyContainer}>
              <Text style={styles.keyLabel}>Signed Prekey (X25519)</Text>
              <Text style={styles.keyFingerprint} selectable>
                {formatFingerprint(keys.prekeyPublicKey)}
              </Text>
              <Text style={styles.keyRaw} numberOfLines={1} selectable>
                {keys.prekeyPublicKey}
              </Text>
            </View>
          </View>
        ) : (
          <Text style={styles.noKeysText}>⚠️ No cryptographic keys found on device.</Text>
        )}
      </View>

      {/* Trust & E2EE Info Card */}
      <View style={[styles.card, { padding: cardPadding, borderRadius: cardRadius }]}>
        <Text style={styles.cardTitle}>Zero-Knowledge Guarantee</Text>
        <Text style={styles.infoText}>
          Whispr messages are encrypted on your device before upload. Your secret private keys are kept in your device's hardware-backed Secure Store and never transmitted to the server.
        </Text>
        <Text style={styles.infoText}>
          Even if the database is compromised, your conversations remain completely private and unreadable to outsiders.
        </Text>
      </View>

      {/* Actions */}
      <View style={styles.actionsSection}>
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          activeOpacity={0.8}
        >
          <Text style={styles.logoutButtonText}>Sign Out</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.wipeButton}
          onPress={handleWipeKeys}
          activeOpacity={0.8}
        >
          <Text style={styles.wipeButtonText}>Wipe Cryptographic Keys</Text>
        </TouchableOpacity>
      </View>
      
      <Text style={styles.versionText}>Whispr Private Messenger • v1.0.0</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  content: {
    paddingBottom: 40,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#0A0A0F',
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    backgroundColor: '#12121F',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#1E1E2E',
  },
  profileSection: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    backgroundColor: '#6C63FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  avatarText: {
    fontWeight: '700',
    color: '#FFFFFF',
  },
  profileInfo: {
    flex: 1,
  },
  usernameText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 6,
  },
  shieldBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(108, 99, 255, 0.15)',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  shieldIcon: {
    fontSize: 12,
    marginRight: 4,
  },
  shieldText: {
    color: '#9E9EFA',
    fontSize: 11,
    fontWeight: '600',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  cardSubtitle: {
    fontSize: 13,
    color: '#8E8E93',
    lineHeight: 18,
    marginBottom: 16,
  },
  keysSection: {
    marginTop: 8,
  },
  keyContainer: {
    marginBottom: 12,
  },
  keyLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6C63FF',
    marginBottom: 4,
  },
  keyFingerprint: {
    fontSize: 15,
    fontFamily: 'monospace',
    color: '#FFFFFF',
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  keyRaw: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#55556B',
  },
  divider: {
    height: 1,
    backgroundColor: '#1E1E2E',
    marginVertical: 12,
  },
  noKeysText: {
    color: '#FF453A',
    fontSize: 14,
    fontWeight: '600',
  },
  infoText: {
    fontSize: 13,
    color: '#8E8E93',
    lineHeight: 19,
    marginBottom: 12,
  },
  actionsSection: {
    gap: 12,
    marginTop: 8,
  },
  logoutButton: {
    backgroundColor: '#1E1E2E',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  logoutButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  wipeButton: {
    backgroundColor: 'rgba(255, 69, 58, 0.1)',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 69, 58, 0.25)',
  },
  wipeButtonText: {
    color: '#FF453A',
    fontSize: 15,
    fontWeight: '600',
  },
  versionText: {
    textAlign: 'center',
    color: '#444455',
    fontSize: 12,
    marginTop: 24,
  },
});
