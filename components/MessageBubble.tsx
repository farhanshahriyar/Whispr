import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { DecryptedMessage } from '../types';
import ImageMessage from './ImageMessage';
import VoicePlayer from './VoicePlayer';

interface MessageBubbleProps {
  message: DecryptedMessage;
  partnerUsername?: string;
  onLongPress?: (message: DecryptedMessage) => void;
}

/**
 * Status indicator:
 *   ✓  = Sent (inserted into Supabase)
 *   ✓✓ = Delivered
 *   ✓✓ (blue) = Read
 */
function getStatusIcon(message: DecryptedMessage): string {
  if (!message.isMine) return '';
  if (message.read) return '✓✓';
  if (message.delivered) return '✓✓';
  return '✓';
}

function getStatusColor(message: DecryptedMessage): string {
  if (message.read) return '#FFFFFF'; // White/bright on user bubbles
  return 'rgba(255, 255, 255, 0.6)';
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function MessageBubble({ message, partnerUsername, onLongPress }: MessageBubbleProps) {
  const statusIcon = getStatusIcon(message);
  const statusColor = getStatusColor(message);

  const isImage = message.messageType === 'image';
  const isVoice = message.messageType === 'voice';
  const isScreenshotAlert = message.messageType === 'screenshot_alert';

  if (isScreenshotAlert) {
    const displayName = message.isMine ? 'You' : (partnerUsername ? `@${partnerUsername}` : 'The other user');
    return (
      <View style={styles.alertContainer}>
        <View style={styles.alertBadge}>
          <Text style={styles.alertText}>
            ⚠️ {displayName} took a screenshot
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        message.isMine ? styles.myMessage : styles.theirMessage,
      ]}
    >
      <TouchableOpacity
        activeOpacity={0.8}
        onLongPress={() => onLongPress?.(message)}
        delayLongPress={400}
        style={[
          styles.bubble,
          message.isMine ? styles.myBubble : styles.theirBubble,
          isImage && styles.imageBubble,
        ]}
      >
        {isImage ? (
          <ImageMessage message={message} />
        ) : isVoice ? (
          <VoicePlayer message={message} />
        ) : (
          <Text
            style={[
              styles.messageText,
              message.isMine ? styles.myText : styles.theirText,
            ]}
          >
            {message.content}
          </Text>
        )}
        <View style={[styles.metaRow, isImage && styles.imageMetaRow]}>
          <Text style={[styles.timestamp, isImage && styles.imageTimestamp]}>
            {formatTime(message.createdAt)}
          </Text>
          {message.isMine && statusIcon ? (
            <Text style={[styles.status, { color: isImage ? '#FFFFFF' : statusColor }]}>
              {' '}{statusIcon}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    marginVertical: 3,
  },
  myMessage: {
    alignItems: 'flex-end',
  },
  theirMessage: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
    borderRadius: 18,
  },
  myBubble: {
    backgroundColor: '#6C63FF',
    borderBottomRightRadius: 4,
  },
  theirBubble: {
    backgroundColor: '#1E1E2E',
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  myText: {
    color: '#FFFFFF',
  },
  theirText: {
    color: '#E0E0E8',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 4,
  },
  timestamp: {
    fontSize: 11,
    color: '#8E8E93',
  },
  status: {
    fontSize: 12,
    fontWeight: '600',
  },
  imageBubble: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  imageMetaRow: {
    position: 'absolute',
    bottom: 6,
    right: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  imageTimestamp: {
    color: '#FFFFFF',
    fontSize: 10,
  },
  alertContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 10,
    width: '100%',
  },
  alertBadge: {
    backgroundColor: '#2C1B2B',
    borderColor: '#FF453A',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#FF453A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  alertText: {
    color: '#FF453A',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
