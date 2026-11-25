export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

// Count UTF-8 bytes without allocating an encoded copy of the backup. An
// unpaired UTF-16 surrogate encodes as U+FFFD, which occupies three bytes.
export function fitsBackupByteLimit(text, limit = MAX_BACKUP_BYTES) {
  let bytes = text.length;
  for (let i = 0; i < text.length && bytes <= limit; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) continue;
    if (unit < 0x800) bytes++;
    else {
      bytes += 2;
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) i++;
      }
    }
  }
  return bytes <= limit;
}
