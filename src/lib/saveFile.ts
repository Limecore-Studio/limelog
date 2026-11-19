// The native "create document" picker (SaveFilePlugin.java), shared by the
// data export and, since v1.22 (limelog#126), "save a copy" of a progress
// photo. Registered once: Capacitor refuses a second registration by name.
import { registerPlugin } from '@capacitor/core';

export const SaveFile = registerPlugin<{
  save(o: {
    filename: string;
    mimeType: string;
    data: string;
    /** 'base64' for binary content (a JPEG); text otherwise. */
    encoding?: 'base64';
  }): Promise<{ saved: boolean; cancelled?: boolean; interrupted?: boolean }>;
}>('SaveFile');
