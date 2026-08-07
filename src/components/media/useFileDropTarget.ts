/* ---------------------------------------------------------------------------
   useFileDropTarget — the OS-to-app file drop, for the whole window.

   PLAN §8.5, two drag systems in one region:
     · This handler runs ONLY when dataTransfer.types includes 'Files'. A clip
       being dragged inside the timeline is a pointer-events gesture and a media
       row dragged to the timeline carries DND_MEDIA_MIME — neither of them can
       light this up.
     · dropActive is set on dragenter and cleared with a DEPTH COUNTER, because
       dragleave fires on every child the pointer crosses, plus on drop and on
       dragend.
     · Paths resolve through media.pathForFile inside importFiles (PLAN §3.2).
       There is no `file.path` anywhere in this codebase.

   Mounted once, by FileDropTarget — which the shell mounts unconditionally at
   the app root, NEVER inside a collapsible region. The media slice owns these
   listeners; it does not own where they are mounted.
--------------------------------------------------------------------------- */

import { useEffect } from 'react';
import { readStore } from '../../state/store';

const hasFiles = (event: DragEvent): boolean => {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) if (types[i] === 'Files') return true;
  return false;
};

export function useFileDropTarget(): void {
  useEffect(() => {
    let depth = 0;

    const clear = (): void => {
      depth = 0;
      readStore().setDropActive(false);
    };

    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      depth += 1;
      if (depth === 1) readStore().setDropActive(true);
    };

    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      // Without this the drop never fires and the window navigates to the file.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) readStore().setDropActive(false);
    };

    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      clear();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void readStore().importFiles(files);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', clear);
    window.addEventListener('blur', clear);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', clear);
      window.removeEventListener('blur', clear);
      clear();
    };
  }, []);
}
