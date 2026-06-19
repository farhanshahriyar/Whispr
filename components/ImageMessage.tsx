import React, { useState, useEffect } from 'react';
import { View, Image, StyleSheet, ActivityIndicator, Text } from 'react-native';
import { decryptAndCacheFileFromUrl } from '../lib/fileEncryption';
import { decryptFileKey } from '../lib/crypto';
import { getPrivateKeys, getReceiverPublicKeys } from '../lib/keystore';
import type { DecryptedMessage } from '../types';

interface ImageMessageProps {
  message: DecryptedMessage;
}

export default function ImageMessage({ message }: ImageMessageProps) {
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAndDecryptImage() {
      try {
        if (!message.fileUrl || !message.encryptedKey) {
          throw new Error('Missing file URL or encrypted key');
        }

        // 1. Determine other user's ID to fetch public key for ECDH decryption
        const otherUserId = message.isMine ? message.receiverId : message.senderId;

        const [privateKeys, receiverKeys] = await Promise.all([
          getPrivateKeys(),
          getReceiverPublicKeys(otherUserId),
        ]);

        if (!privateKeys) throw new Error('Private keys not found. Please log in again.');
        if (!receiverKeys) throw new Error('Recipient keys not found.');

        // 2. Decrypt the file key using public-key decryption (ECDH)
        const fileKeyHex = await decryptFileKey(
          message.encryptedKey,
          receiverKeys.signed_prekey,
          privateKeys.prekeyPrivateKey
        );

        // 3. Download, decrypt, and cache the image file
        // We use jpg as a safe default extension for image picker outputs
        const decryptedLocalUri = await decryptAndCacheFileFromUrl(
          message.fileUrl,
          fileKeyHex,
          'jpg',
          message.id
        );

        if (!cancelled) {
          setUri(decryptedLocalUri);
          setLoading(false);
        }
      } catch (err) {
        console.error('Image decryption error:', err);
        if (!cancelled) {
          setError('Failed to decrypt image');
          setLoading(false);
        }
      }
    }

    loadAndDecryptImage();
    return () => {
      cancelled = true;
    };
  }, [message]);

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color="#6C63FF" size="small" />
        <Text style={styles.loadingText}>Decrypting image...</Text>
      </View>
    );
  }

  if (error || !uri) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorIcon}>🔒</Text>
        <Text style={styles.errorText}>{error || 'Unable to load image'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.imageContainer}>
      <Image source={{ uri }} style={styles.image} resizeMode="cover" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 240,
    height: 180,
    borderRadius: 16,
    backgroundColor: '#161622',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 12,
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  loadingText: {
    color: '#8E8E93',
    fontSize: 12,
    marginTop: 8,
  },
  errorIcon: {
    fontSize: 24,
    marginBottom: 6,
  },
  errorText: {
    color: '#FF453A',
    fontSize: 12,
    textAlign: 'center',
  },
  imageContainer: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  image: {
    width: 240,
    height: 180,
  },
});
