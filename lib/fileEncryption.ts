import {
  readAsStringAsync,
  writeAsStringAsync,
  downloadAsync,
  deleteAsync,
  getInfoAsync,
  cacheDirectory,
} from 'expo-file-system/legacy';
import { base64ToBytes, bytesToBase64, encryptFileBytes, decryptFileBytes } from './crypto';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit

/**
 * Reads a local file, checks its size (max 50MB), and encrypts its contents.
 *
 * @param localUri - The local URI of the file to encrypt.
 * @returns Object containing the encrypted binary payload as Uint8Array and the generated key in hex.
 */
export async function encryptFile(
  localUri: string
): Promise<{ encryptedBytes: Uint8Array; fileKeyHex: string }> {
  // 1. Verify file exists and is under 50MB
  const fileInfo = await getInfoAsync(localUri);
  if (!fileInfo.exists) {
    throw new Error('File does not exist');
  }
  if (fileInfo.size !== undefined && fileInfo.size > MAX_FILE_SIZE) {
    throw new Error('File size exceeds the 50MB limit');
  }

  // 2. Read local file as Base64
  const base64Content = await readAsStringAsync(localUri, {
    encoding: 'base64',
  });

  // 3. Convert Base64 string to Uint8Array
  const fileBytes = base64ToBytes(base64Content);

  // 4. Encrypt the bytes
  return encryptFileBytes(fileBytes);
}

/**
 * Downloads an encrypted file, decrypts it, and caches the decrypted result locally.
 * If a cached decrypted version already exists, it is returned immediately.
 *
 * @param url - The Supabase Storage download URL of the encrypted file.
 * @param fileKeyHex - The hex-encoded decryption key for the file.
 * @param fileExtension - The file extension (e.g., 'jpg', 'm4a').
 * @param messageId - The UUID of the message (used for unique local caching).
 * @returns The local URI of the decrypted and cached file.
 */
export async function decryptAndCacheFileFromUrl(
  url: string,
  fileKeyHex: string,
  fileExtension: string,
  messageId: string
): Promise<string> {
  const decryptedCachePath = `${cacheDirectory}decrypted_${messageId}.${fileExtension}`;

  // 1. Check if the decrypted file is already cached
  const cacheInfo = await getInfoAsync(decryptedCachePath);
  if (cacheInfo.exists) {
    return decryptedCachePath;
  }

  const tempEncryptedPath = `${cacheDirectory}temp_encrypted_${messageId}`;

  try {
    // 2. Download the encrypted file to a temporary location
    const downloadResult = await downloadAsync(url, tempEncryptedPath);
    if (!downloadResult || (downloadResult.status && downloadResult.status >= 400)) {
      throw new Error(`Download failed with status ${downloadResult?.status ?? 'unknown'}`);
    }

    // 3. Verify the temp file actually exists before reading
    const tempInfo = await getInfoAsync(tempEncryptedPath);
    if (!tempInfo.exists) {
      throw new Error('Downloaded file not found on disk');
    }

    // 4. Read the encrypted file as Base64
    const encryptedBase64 = await readAsStringAsync(tempEncryptedPath, {
      encoding: 'base64',
    });

    // 5. Clean up temp file now that we've read it
    await deleteAsync(tempEncryptedPath, { idempotent: true }).catch(() => {});

    // 6. Convert Base64 string to Uint8Array
    const encryptedBytes = base64ToBytes(encryptedBase64);

    // 7. Decrypt the bytes
    const decryptedBytes = decryptFileBytes(encryptedBytes, fileKeyHex);

    // 8. Convert decrypted bytes back to Base64
    const decryptedBase64 = bytesToBase64(decryptedBytes);

    // 9. Write the decrypted Base64 to the final cached path
    await writeAsStringAsync(decryptedCachePath, decryptedBase64, {
      encoding: 'base64',
    });

    return decryptedCachePath;
  } catch (err) {
    // Clean up temp file on error
    await deleteAsync(tempEncryptedPath, { idempotent: true }).catch(() => {});
    throw err;
  }
}

