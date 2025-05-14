const fetch = require('node-fetch');
const mime = require('mime-types');

class FileValidator {
  static async validatePublicUrl(url, fileName) {
    const maxRetries = 10;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get MIME type from filename as fallback
        const mimeType = mime.lookup(fileName) || 'application/octet-stream';

        // Safer than HEAD — avoids S3 signed URL issues
        const res = await fetch(url, {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
        });

        if (res.ok) {
          const contentType = res.headers.get('content-type') || mimeType;
          return {
            isValid: FileValidator.isValidFileType(contentType),
            contentType,
          };
        }

        if (res.status === 403) {
          console.warn(`[${attempt}] 403 Forbidden for ${url}`);
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
            continue;
          }

          // After retries, assume valid if we can determine MIME type
          console.warn(`⚠️ Bypassing validation after multiple 403s for ${url}`);
          return {
            isValid: FileValidator.isValidFileType(mimeType),
            contentType: mimeType,
          };
        }

        throw new Error(`URL validation failed with status ${res.status}`);
      } catch (err) {
        console.warn(`Attempt ${attempt} failed: ${err.message}`);
        if (attempt === maxRetries) {
          throw new Error(`URL validation failed: ${err.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  static isValidFileType(contentType) {
    // List of allowed MIME types
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/svg+xml',
      'image/webp',
      'image/bmp',
      'image/tiff',
      'image/heic',
      'video/mp4',
      'video/x-msvideo',
      'video/quicktime',
      'video/x-ms-wmv',
      'video/x-matroska',
      'video/webm',
      'video/quicktime',
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/aac',
      'audio/ogg',
      'audio/flac',
      'application/rtf',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'text/plain',
      'text/rtf',
      'text/csv'
    ];

    return allowedTypes.includes(contentType?.toLowerCase());
  }
}

module.exports = FileValidator;
