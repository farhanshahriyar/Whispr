import React, { useState, useEffect, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator, Text, TouchableOpacity } from 'react-native';
import { Audio, AVPlaybackStatus } from 'expo-av';
import Svg, { Path } from 'react-native-svg';
import { decryptAndCacheFileFromUrl } from '../lib/fileEncryption';
import { decryptFileKey } from '../lib/crypto';
import { getPrivateKeys, getReceiverPublicKeys } from '../lib/keystore';
import type { DecryptedMessage } from '../types';

interface VoicePlayerProps {
  message: DecryptedMessage;
}

export default function VoicePlayer({ message }: VoicePlayerProps) {
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  const soundRef = useRef<Audio.Sound | null>(null);

  // Decrypt and cache voice file on mount
  useEffect(() => {
    let cancelled = false;

    async function loadAndDecryptVoice() {
      try {
        if (!message.fileUrl || !message.encryptedKey) {
          throw new Error('Missing file URL or encrypted key');
        }

        const otherUserId = message.isMine ? message.receiverId : message.senderId;

        const [privateKeys, receiverKeys] = await Promise.all([
          getPrivateKeys(),
          getReceiverPublicKeys(otherUserId),
        ]);

        if (!privateKeys) throw new Error('Private keys not found');
        if (!receiverKeys) throw new Error('Recipient keys not found');

        const fileKeyHex = await decryptFileKey(
          message.encryptedKey,
          receiverKeys.signed_prekey,
          privateKeys.prekeyPrivateKey
        );

        // Download and decrypt the audio file
        const decryptedLocalUri = await decryptAndCacheFileFromUrl(
          message.fileUrl,
          fileKeyHex,
          'm4a', // m4a is the standard format used on Android/iOS in Expo AV
          message.id
        );

        if (!cancelled) {
          setUri(decryptedLocalUri);
          setLoading(false);
        }
      } catch (err) {
        console.error('Voice decryption error:', err);
        if (!cancelled) {
          setError('Failed to decrypt voice message');
          setLoading(false);
        }
      }
    }

    loadAndDecryptVoice();

    return () => {
      cancelled = true;
      // Clean up sound object if playing
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch((err) => {
          console.warn('Failed to unload sound on unmount:', err);
        });
      }
    };
  }, [message]);

  const onPlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    if (status.isLoaded) {
      setPosition(status.positionMillis || 0);
      setDuration(status.durationMillis || 0);
      setIsPlaying(status.isPlaying);

      if (status.didJustFinish) {
        setIsPlaying(false);
        setPosition(0);
        soundRef.current?.setPositionAsync(0).catch((e) => console.warn(e));
      }
    }
  };

  const playPauseAudio = async () => {
    if (!uri) return;

    try {
      if (soundRef.current) {
        const status = await soundRef.current.getStatusAsync();
        if (status.isLoaded) {
          if (status.isPlaying) {
            await soundRef.current.pauseAsync();
          } else {
            // Enable playing in silent mode for iOS
            await Audio.setAudioModeAsync({
              playsInSilentModeIOS: true,
              allowsRecordingIOS: false,
              staysActiveInBackground: false,
            });
            await soundRef.current.playAsync();
          }
        }
      } else {
        // Load and play
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          allowsRecordingIOS: false,
          staysActiveInBackground: false,
        });

        const { sound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: true },
          onPlaybackStatusUpdate
        );
        soundRef.current = sound;
      }
    } catch (err) {
      console.error('Audio playback error:', err);
    }
  };

  const formatTime = (millis: number) => {
    const totalSeconds = millis / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={message.isMine ? '#FFFFFF' : '#6C63FF'} size="small" />
        <Text style={[styles.statusText, { color: message.isMine ? '#E1E1E6' : '#8E8E93' }]}>
          Decrypting voice...
        </Text>
      </View>
    );
  }

  if (error || !uri) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorIcon}>🔒</Text>
        <Text style={styles.errorText}>{error || 'Unable to play voice message'}</Text>
      </View>
    );
  }

  const progress = duration > 0 ? position / duration : 0;

  return (
    <View style={styles.container}>
      {/* Play/Pause Button */}
      <TouchableOpacity
        style={[
          styles.playButton,
          { backgroundColor: message.isMine ? '#FFFFFF' : '#6C63FF' },
        ]}
        onPress={playPauseAudio}
        activeOpacity={0.8}
      >
        {isPlaying ? (
          <Svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <Path
              d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"
              fill={message.isMine ? '#6C63FF' : '#FFFFFF'}
            />
          </Svg>
        ) : (
          <Svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <Path
              d="M8 5v14l11-7z"
              fill={message.isMine ? '#6C63FF' : '#FFFFFF'}
            />
          </Svg>
        )}
      </TouchableOpacity>

      {/* Progress Track */}
      <View style={styles.progressContainer}>
        <View style={styles.track}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${progress * 100}%`,
                backgroundColor: message.isMine ? '#FFFFFF' : '#6C63FF',
              },
            ]}
          />
        </View>
        <View style={styles.timeRow}>
          <Text style={[styles.timeText, { color: message.isMine ? '#CCCCCC' : '#8E8E93' }]}>
            {formatTime(position)}
          </Text>
          <Text style={[styles.timeText, { color: message.isMine ? '#CCCCCC' : '#8E8E93' }]}>
            {duration > 0 ? formatTime(duration) : '0:00'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 220,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  playButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  progressContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 4,
  },
  progressFill: {
    height: '100%',
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  timeText: {
    fontSize: 10,
  },
  statusText: {
    fontSize: 12,
    marginLeft: 8,
  },
  errorIcon: {
    fontSize: 20,
    marginRight: 8,
  },
  errorText: {
    color: '#FF453A',
    fontSize: 11,
    flex: 1,
  },
});
