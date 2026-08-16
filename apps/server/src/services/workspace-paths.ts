import { join } from 'node:path';
import { settingsService, resolveWorkspacePath } from './settings.service.js';

/** Name of the audio input folder inside the workspace root. */
export const AUDIO_INPUT_DIR_NAME = 'audio';

/**
 * Absolute path of the audio input folder
 * (`{workspace_path}/audio`), resolved from the persisted settings.
 */
export async function getWorkspaceAudioDir(): Promise<string> {
  const settings = await settingsService.getSettings();
  return join(resolveWorkspacePath(settings.workspacePath), AUDIO_INPUT_DIR_NAME);
}
