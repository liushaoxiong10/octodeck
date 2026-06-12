import { create } from 'zustand';
import { api, apiFetch } from '../api/client';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  isSystem: boolean;
  absolutePath?: string;
}

export interface UploadProgress {
  total: number;
  completed: number;
  currentFile: string;
  /** bytes for current batch */
  totalBytes: number;
  uploadedBytes: number;
}

interface FileState {
  files: Record<string, FileEntry[]>;
  currentPath: Record<string, string>;
  loading: boolean;
  uploading: boolean;
  uploadProgress: UploadProgress | null;
  error: string | null;

  loadFiles: (jid: string, path?: string, agentId?: string | null) => Promise<void>;
  uploadFiles: (jid: string, files: File[], basePath?: string, agentId?: string | null) => Promise<boolean>;
  deleteFile: (jid: string, filePath: string, agentId?: string | null) => Promise<boolean>;
  createDirectory: (jid: string, parentPath: string, name: string, agentId?: string | null) => Promise<void>;
  navigateTo: (jid: string, path: string, agentId?: string | null) => void;
  getFileContent: (jid: string, filePath: string, agentId?: string | null) => Promise<string | null>;
  saveFileContent: (jid: string, filePath: string, content: string, agentId?: string | null) => Promise<boolean>;
}

export function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function fileStateKey(jid: string, agentId?: string | null): string {
  return agentId ? `${jid}#agent:${agentId}` : jid;
}

function addAgentParam(params: URLSearchParams, agentId?: string | null): void {
  if (agentId) params.set('agentId', agentId);
}

export const useFileStore = create<FileState>((set, get) => ({
  files: {},
  currentPath: {},
  loading: false,
  uploading: false,
  uploadProgress: null,
  error: null,

  loadFiles: async (jid: string, path?: string, agentId?: string | null) => {
    set({ loading: true, error: null });
    try {
      const key = fileStateKey(jid, agentId);
      const targetPath = path !== undefined ? path : (get().currentPath[key] || '');
      const params = new URLSearchParams();
      if (targetPath) params.set('path', targetPath);
      addAgentParam(params, agentId);

      const data = await api.get<{ files: FileEntry[]; currentPath: string }>(
        `/api/groups/${encodeURIComponent(jid)}/files?${params}`
      );

      set((s) => ({
        files: { ...s.files, [key]: data.files },
        currentPath: { ...s.currentPath, [key]: data.currentPath },
        loading: false,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load files';
      console.error('Failed to load files:', err);
      set({ loading: false, error: msg });
    }
  },

  uploadFiles: async (jid: string, files: File[], basePath?: string, agentId?: string | null) => {
    if (files.length === 0) return false;

    const total = files.length;
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    set({
      uploading: true,
      uploadProgress: { total, completed: 0, currentFile: files[0].name, totalBytes, uploadedBytes: 0 },
    });

    const key = fileStateKey(jid, agentId);
    const targetBase = basePath !== undefined ? basePath : (get().currentPath[key] || '');
    const apiUrl = `/api/groups/${encodeURIComponent(jid)}/files`;
    let uploadedBytes = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // For folder uploads, webkitRelativePath = "folderName/sub/file.txt"
        // Extract directory portion to preserve structure
        const relativePath = file.webkitRelativePath;
        let uploadPath = targetBase;
        if (relativePath) {
          const lastSlash = relativePath.lastIndexOf('/');
          if (lastSlash > 0) {
            const dir = relativePath.substring(0, lastSlash);
            uploadPath = targetBase ? `${targetBase}/${dir}` : dir;
          }
        }

        set({
          uploadProgress: { total, completed: i, currentFile: file.name, totalBytes, uploadedBytes },
        });

        const formData = new FormData();
        formData.append('files', file);
        if (uploadPath) formData.append('path', uploadPath);
        if (agentId) formData.append('agentId', agentId);

        await apiFetch(apiUrl, {
          method: 'POST',
          body: formData,
          headers: {},
        });

        uploadedBytes += file.size;

        set({
          uploadProgress: { total, completed: i + 1, currentFile: i + 1 < total ? files[i + 1].name : '', totalBytes, uploadedBytes },
        });
      }

      // Reload file list
      await get().loadFiles(jid, targetBase, agentId);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to upload files';
      console.error('Failed to upload files:', err);
      set({ error: msg });
      return false;
    } finally {
      set({ uploading: false, uploadProgress: null });
    }
  },

  deleteFile: async (jid: string, filePath: string, agentId?: string | null) => {
    try {
      const encoded = toBase64Url(filePath);
      const params = new URLSearchParams();
      addAgentParam(params, agentId);
      await api.delete(`/api/groups/${encodeURIComponent(jid)}/files/${encoded}${params.toString() ? `?${params}` : ''}`);

      const currentPath = get().currentPath[fileStateKey(jid, agentId)] || '';
      await get().loadFiles(jid, currentPath, agentId);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete file';
      console.error('Failed to delete file:', err);
      set({ error: msg });
      return false;
    }
  },

  createDirectory: async (jid: string, parentPath: string, name: string, agentId?: string | null) => {
    try {
      await api.post(`/api/groups/${encodeURIComponent(jid)}/directories`, {
        path: parentPath,
        name,
        agentId,
      });

      await get().loadFiles(jid, parentPath, agentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create directory';
      console.error('Failed to create directory:', err);
      set({ error: msg });
    }
  },

  navigateTo: (jid: string, path: string, agentId?: string | null) => {
    const key = fileStateKey(jid, agentId);
    set((s) => ({
      currentPath: { ...s.currentPath, [key]: path },
      files: { ...s.files, [key]: [] },
    }));
    get().loadFiles(jid, path, agentId);
  },

  getFileContent: async (jid: string, filePath: string, agentId?: string | null) => {
    try {
      const encoded = toBase64Url(filePath);
      const params = new URLSearchParams();
      addAgentParam(params, agentId);
      const data = await api.get<{ content: string }>(
        `/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}${params.toString() ? `?${params}` : ''}`
      );
      return data.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to read file';
      console.error('Failed to read file content:', err);
      set({ error: msg });
      return null;
    }
  },

  saveFileContent: async (jid: string, filePath: string, content: string, agentId?: string | null) => {
    try {
      const encoded = toBase64Url(filePath);
      const params = new URLSearchParams();
      addAgentParam(params, agentId);
      await api.put(`/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}${params.toString() ? `?${params}` : ''}`, { content });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save file';
      console.error('Failed to save file content:', err);
      set({ error: msg });
      return false;
    }
  },
}));
