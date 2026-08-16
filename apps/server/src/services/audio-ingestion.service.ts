import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import type { AudioStatus } from '@freebuff/contracts';
import { SUPPORTED_AUDIO_EXTENSIONS } from '@freebuff/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { getDatabase } from '../core/database/client.js';
import { audioFiles } from '../core/database/schema.js';
import { DomainError } from './errors.js';
import type { DbExecutor } from './jobs.service.js';

export interface DiscoveredAudioFile {
  absolutePath: string;
  originalName: string;
  extension: string;
  mimeType: string;
  fileSize: number;
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

const SUPPORTED_SET = new Set<string>(SUPPORTED_AUDIO_EXTENSIONS);

/**
 * Low-level audio file operations: filesystem discovery, format validation,
 * SHA-256 hashing and duplicate lookup. No batch or job logic here.
 */
export class AudioIngestionService {
  /** List files in the audio input folder (top level, deterministic order). */
  async discoverFiles(dir: string): Promise<DiscoveredAudioFile[]> {
    await fs.mkdir(dir, { recursive: true });
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    const result: DiscoveredAudioFile[] = [];
    for (const name of files) {
      const absolutePath = join(dir, name);
      const extension = extname(name).toLowerCase();
      if (!SUPPORTED_SET.has(extension)) {
        continue; // Unsupported files are silently ignored by discovery.
      }
      try {
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile() || stat.size === 0) continue;
        result.push({
          absolutePath,
          originalName: name,
          extension,
          mimeType: MIME_BY_EXT[extension] ?? 'application/octet-stream',
          fileSize: stat.size,
        });
      } catch {
        // Skip unreadable entries — a missing file must not crash a scan.
        continue;
      }
    }
    return result;
  }

  /** Reject formats outside the supported audio whitelist. */
  validateAudioFile(extension: string): void {
    if (!SUPPORTED_SET.has(extension)) {
      throw new DomainError('AUDIO_FORMAT_UNSUPPORTED', `فرمت «${extension}» پشتیبانی نمی‌شود.`);
    }
  }

  /** SHA-256 of the file contents — the deduplication identity. */
  async calculateHash(absolutePath: string): Promise<string> {
    const hash = createHash('sha256');
    try {
      const stream = createReadStream(absolutePath);
      for await (const chunk of stream) {
        hash.update(chunk as Buffer);
      }
      return hash.digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DomainError('AUDIO_FILE_NOT_FOUND', 'فایل صوتی پیدا نشد.', { cause: error });
      }
      throw new DomainError('AUDIO_FILE_READ_ERROR', 'خواندن فایل صوتی ممکن نشد.', {
        cause: error,
      });
    }
  }

  /**
   * The first audio row with this hash, if any. Duplicate detection is
   * content-based (SHA-256) and global across all batches — never by filename.
   */
  async detectDuplicate(sha256: string, db: DbExecutor = getDatabase()): Promise<number | null> {
    const row = await db
      .select({ id: audioFiles.id })
      .from(audioFiles)
      .where(and(eq(audioFiles.sha256, sha256), isNull(audioFiles.deletedAt)))
      .orderBy(audioFiles.id)
      .limit(1)
      .get();
    return row?.id ?? null;
  }

  /** Whether this path is already registered in the given batch. */
  async isRegisteredInBatch(batchId: number, absolutePath: string): Promise<boolean> {
    const db = getDatabase();
    const byPath = await db
      .select({ id: audioFiles.id })
      .from(audioFiles)
      .where(
        and(eq(audioFiles.batchId, batchId), eq(audioFiles.absolutePath, absolutePath)),
      )
      .get();
    return Boolean(byPath);
  }

  /** Insert an audio row. Caller owns the surrounding transaction. */
  async insertAudio(
    input: {
      batchId: number;
      absolutePath: string;
      originalName: string;
      extension: string;
      mimeType: string;
      fileSize: number;
      sha256: string;
      status: AudioStatus;
      duplicateOfAudioId?: number | null;
    },
    db: DbExecutor = getDatabase(),
  ): Promise<number> {
    const now = new Date();
    const inserted = await db
      .insert(audioFiles)
      .values({
        batchId: input.batchId,
        originalName: input.originalName,
        absolutePath: input.absolutePath,
        extension: input.extension,
        mimeType: input.mimeType,
        fileSize: input.fileSize,
        sha256: input.sha256,
        status: input.status,
        duplicateOfAudioId: input.duplicateOfAudioId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: audioFiles.id });
    return inserted[0]?.id ?? -1;
  }

  /** Move a registered audio row to QUEUED once its job exists. */
  async markQueued(audioId: number, db: DbExecutor = getDatabase()): Promise<void> {
    await db
      .update(audioFiles)
      .set({ status: 'QUEUED', updatedAt: new Date() })
      .where(eq(audioFiles.id, audioId));
  }
}

export const audioIngestionService = new AudioIngestionService();
