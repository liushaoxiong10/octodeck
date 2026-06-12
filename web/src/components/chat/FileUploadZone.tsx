import { useState, useRef, DragEvent } from 'react';
import { Upload, FolderUp } from 'lucide-react';
import { useFileStore } from '../../stores/files';

interface FileUploadZoneProps {
  groupJid: string;
  agentId?: string | null;
  disabled?: boolean;
  disabledReason?: string;
}

export function FileUploadZone({ groupJid, agentId, disabled = false, disabledReason }: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const { uploadFiles, uploading, uploadProgress } = useFileStore();

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    setIsDragging(false);
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (disabled) return;

    const fileList = e.dataTransfer.files;
    if (fileList.length > 0) {
      await uploadFiles(groupJid, Array.from(fileList), undefined, agentId);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (disabled) return;
    if (fileList && fileList.length > 0) {
      await uploadFiles(groupJid, Array.from(fileList), undefined, agentId);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (disabled) return;
    if (fileList && fileList.length > 0) {
      await uploadFiles(groupJid, Array.from(fileList), undefined, agentId);
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const progressPercent =
    uploadProgress && uploadProgress.totalBytes > 0
      ? Math.round((uploadProgress.uploadedBytes / uploadProgress.totalBytes) * 100)
      : 0;

  return (
    <div className="space-y-2">
      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative border-2 border-dashed rounded-lg p-3 transition-all ${
          isDragging
            ? 'border-primary bg-brand-50'
            : 'border-border'
        } ${uploading || disabled ? 'pointer-events-none opacity-60' : ''}`}
        title={disabled ? disabledReason : undefined}
      >
        {/* Hidden inputs */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          disabled={uploading || disabled}
        />
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error webkitdirectory is non-standard but widely supported
          webkitdirectory=""
          onChange={handleFolderSelect}
          className="hidden"
          disabled={uploading || disabled}
        />

        {uploading && uploadProgress ? (
          /* Upload progress */
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate max-w-[60%]">{uploadProgress.currentFile || '完成'}</span>
              <span>{uploadProgress.completed}/{uploadProgress.total} 个文件</span>
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground text-center">{progressPercent}%</p>
          </div>
        ) : (
          /* Idle state */
          <div className="flex flex-col items-center gap-2 text-center py-1">
            <p className="text-xs text-muted-foreground">
              {disabled ? (disabledReason || '当前不可上传') : isDragging ? '释放以上传' : '拖拽文件到这里，或'}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-primary bg-brand-50 hover:bg-brand-100 rounded-md transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Upload className="w-3.5 h-3.5" />
                上传文件
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                disabled={disabled}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-foreground bg-muted hover:bg-muted/80 rounded-md transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <FolderUp className="w-3.5 h-3.5" />
                上传文件夹
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
