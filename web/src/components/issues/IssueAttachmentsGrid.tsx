import { Upload, X, Plus, Image as ImageIcon, Paperclip } from 'lucide-react';
import type { RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { IssueAttachment } from '@/stores/issues';

export interface IssueAttachmentsGridProps {
  attachments: IssueAttachment[];
  onUpload?: () => void;
  onDelete?: (id: string) => void;
  canDelete?: boolean;
  allowAdd?: boolean;
  uploadRef?: RefObject<HTMLInputElement | null>;
  addAttachments?: (files: FileList | null) => Promise<void>;
  accept?: string;
  multiple?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function IssueAttachmentsGrid({
  attachments,
  onUpload,
  onDelete,
  canDelete = true,
  allowAdd = true,
  uploadRef,
  addAttachments,
  accept = 'image/*',
  multiple = true,
}: IssueAttachmentsGridProps) {
  const isEmpty = attachments.length === 0;

  return (
    <div className="space-y-3">
      {allowAdd && (
        <div className="flex items-center justify-between">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold">
            <Paperclip className="h-4 w-4" />
            Attachments <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{attachments.length}</Badge>
          </h4>
          <div className="flex items-center gap-2">
            {addAttachments && uploadRef && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => uploadRef.current?.click()}
              >
                <Upload className="mr-1 h-3 w-3" />Add files
              </Button>
            )}
            {onUpload && (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onUpload}>
                <Plus className="mr-1 h-3 w-3" />Upload
              </Button>
            )}
            {addAttachments && uploadRef && (
              <input
                ref={uploadRef}
                className="hidden"
                type="file"
                accept={accept}
                multiple={multiple}
                onChange={(e) => {
                  addAttachments(e.target.files);
                  // reset so re-selecting the same file fires change again
                  e.target.value = '';
                }}
              />
            )}
          </div>
        </div>
      )}

      {isEmpty ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
          <ImageIcon className="mb-1 h-8 w-8 opacity-50" />
          <p>No attachments yet.</p>
          {allowAdd && <p className="mt-0.5">Use the Add button above to upload images or files.</p>}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {attachments.map((attachment) => {
            const isImage = attachment.mime_type.startsWith('image/');
            return (
              <div
                key={attachment.id}
                className="group relative overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
              >
                {isImage ? (
                  <a
                    href={attachment.data_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                    download={attachment.filename}
                  >
                    <img
                      src={attachment.data_url}
                      alt={attachment.filename}
                      className="h-28 w-full object-cover"
                      loading="lazy"
                    />
                  </a>
                ) : (
                  <a
                    href={attachment.data_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-28 w-full items-center justify-center bg-muted/30"
                    download={attachment.filename}
                  >
                    <Paperclip className="h-10 w-10 opacity-60" />
                  </a>
                )}
                <div className="border-t bg-background/80 p-2">
                  <p className="truncate text-[11px] font-medium" title={attachment.filename}>
                    {attachment.filename}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{formatSize(attachment.size_bytes)}</p>
                </div>
                {canDelete && onDelete && (
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute right-1 top-1 h-6 w-6 opacity-0 shadow-md transition-opacity group-hover:opacity-100"
                    onClick={() => onDelete(attachment.id)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
