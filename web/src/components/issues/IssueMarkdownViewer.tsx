import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import React, { memo, useMemo, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import 'highlight.js/styles/github.css';
import { cn } from '@/lib/utils';

export interface IssueMarkdownViewerProps {
  children: string;
  className?: string;
}

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), 'class', 'className'],
    span: [...(defaultSchema.attributes?.span || []), 'class', 'className', 'style', 'aria-hidden'],
    div: [...(defaultSchema.attributes?.div || []), 'class', 'className', 'style'],
    img: ['src', 'alt', 'width', 'height', 'loading', 'title'],
    a: [...(defaultSchema.attributes?.a || []), 'target', 'rel'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || []), 'data'],
  },
};

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) return extractText((node.props as { children?: React.ReactNode }).children);
  return '';
}

function CodeBlock({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'code'> & { className?: string }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const codeString = extractText(children).replace(/\n$/, '');
  const isBlock = Boolean(match) || codeString.includes('\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isBlock) {
    return (
      <div className="relative group my-3 overflow-hidden">
        <div className="absolute right-2 top-2 opacity-70 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity z-10">
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-md bg-muted hover:bg-muted/80 text-muted-foreground text-xs flex items-center gap-1"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
        <pre className="!bg-[var(--code-block-bg)] rounded-md p-3 overflow-x-auto font-mono text-sm border border-border">
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      </div>
    );
  }

  return (
    <code
      className="bg-[var(--inline-code-bg)] text-[var(--inline-code-text)] px-1 py-px rounded-md text-[0.9em] leading-relaxed font-mono break-all"
      {...props}
    >
      {children}
    </code>
  );
}

export const IssueMarkdownViewer = memo(function IssueMarkdownViewer({
  children,
  className,
}: IssueMarkdownViewerProps) {
  const remarkPlugins = useMemo(() => [remarkGfm, remarkBreaks], []);
  const rehypePlugins = useMemo(
    () => [
      rehypeRaw,
      [rehypeHighlight] as const,
      [rehypeSanitize, sanitizeSchema] as const,
    ],
    [],
  );

  return (
    <div className={cn('text-sm leading-relaxed text-foreground', className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins as any}
        rehypePlugins={rehypePlugins as any}
        components={{
          code: (props) => <CodeBlock {...props} />,
          img: ({ src, alt }) => (
            <img
              src={src || ''}
              alt={alt || ''}
              loading="lazy"
              className="my-2 max-w-full rounded-lg border border-border"
              style={{ maxHeight: '300px', objectFit: 'contain' }}
            />
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary underline break-all"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 max-w-full overflow-x-auto">
              <table className="min-w-full border-collapse border border-border">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-border">{children}</tbody>,
          tr: ({ children }) => <tr className="even:bg-surface odd:bg-muted/30">{children}</tr>,
          th: ({ children }) => (
            <th className="px-3 py-1.5 text-left font-semibold text-foreground border border-border whitespace-nowrap align-top text-xs">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-1.5 text-foreground border border-border whitespace-nowrap align-top text-xs">
              {children}
            </td>
          ),
          ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="[&>p]:inline [&>p]:my-0">{children}</li>,
          p: ({ children }) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
          h1: ({ children }) => <h1 className="text-xl font-bold mt-4 mb-2 leading-tight">{children}</h1>,
          h2: ({ children }) => <h2 className="text-lg font-bold mt-3 mb-1.5 leading-tight">{children}</h2>,
          h3: ({ children }) => <h3 className="text-base font-semibold mt-2 mb-1 leading-snug">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-border pl-3 my-2 text-muted-foreground italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-border" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
