import { Audio } from 'expo-av';

let isAudioInitialized = false;

/**
 * Initialize audio configuration once.
 * Configures both playsInSilentModeIOS and allowsRecordingIOS as true
 * to allow message sounds to play without disrupting microphone/recording state.
 */
async function initAudioMode() {
  if (isAudioInitialized) return;
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      allowsRecordingIOS: true,
      staysActiveInBackground: false,
    });
    isAudioInitialized = true;
  } catch (error) {
    console.warn('[Sounds] Failed to initialize audio mode:', error);
  }
}

/**
 * Play a sound effect from local asset and clean up resources afterwards.
 */
async function playSound(asset: any) {
  try {
    await initAudioMode();
    const { sound } = await Audio.Sound.createAsync(
      asset,
      { shouldPlay: true, volume: 1.0 }
    );
    
    // Listen for playback status to unload the sound once it finishes playing
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded && status.didJustFinish) {
        sound.unloadAsync().catch((err) => {
          console.warn('[Sounds] Failed to unload sound asset:', err);
        });
      }
    });
  } catch (error) {
    console.warn('[Sounds] Error during sound playback:', error);
  }
}

/**
 * Play iPhone-style sent message sound effect
 */
export async function playSendSound() {
  // Use require for asset bundling via Metro
  await playSound(require('../assets/sounds/SentMessage.m4a'));
}

/**
 * Play iPhone-style received message sound effect
 */
export async function playReceiveSound() {
  await playSound(require('../assets/sounds/ReceivedMessage.m4a'));
}
