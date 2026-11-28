import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// v1.22 (as StudyDesk#320) — "Export my data" must never leave a blank file:
// the native save streams the text (no full getBytes copy), treats any
// Throwable (OutOfMemoryError included) as a failure, and then removes the
// empty file the picker created and rejects, which the Profile page reports.
const java = readFileSync(
  join(__dirname, '../../android/app/src/main/java/com/limecore/workouttracker/SaveFilePlugin.java'),
  'utf8',
);

describe('SaveFilePlugin write', () => {
  it('streams the write and treats any Throwable as a failure', () => {
    expect(java).toMatch(/catch \(Throwable e\)/);
    expect(java).not.toMatch(/data\.getBytes\(/);
  });
  it('removes the empty file the picker created when the write fails', () => {
    expect(java).toMatch(/DocumentsContract\.deleteDocument/);
    expect(java).toMatch(/call\.reject\("Could not write the file\."\)/);
  });
});
