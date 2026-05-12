'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Send, Trash2 } from 'lucide-react';
import { assistantApi, type AssistantMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function AskAIPage() {
  const { id: studentId } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: conversations } = useQuery({
    queryKey: ['ai-conversations', studentId],
    queryFn: () => assistantApi.list(studentId),
  });

  const { data: history } = useQuery({
    queryKey: ['ai-history', activeConvId],
    queryFn: () => (activeConvId ? assistantApi.history(activeConvId) : Promise.resolve(null)),
    enabled: Boolean(activeConvId),
  });

  // Auto-select most recent (or create) when the page mounts.
  useEffect(() => {
    if (activeConvId || !conversations) return;
    if (conversations.data.length > 0) {
      setActiveConvId(conversations.data[0]!.id);
    }
  }, [conversations, activeConvId]);

  // Scroll to bottom on new messages.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history?.messages.length]);

  const start = useMutation({
    mutationFn: () => assistantApi.start(studentId),
    onSuccess: async (conv) => {
      setActiveConvId(conv.id);
      await qc.invalidateQueries({ queryKey: ['ai-conversations', studentId] });
    },
  });

  const send = useMutation({
    mutationFn: async (content: string) => {
      if (!activeConvId) {
        const created = await assistantApi.start(studentId);
        setActiveConvId(created.id);
        await qc.invalidateQueries({ queryKey: ['ai-conversations', studentId] });
        return assistantApi.send(created.id, content);
      }
      return assistantApi.send(activeConvId, content);
    },
    onSuccess: async () => {
      setDraft('');
      await qc.invalidateQueries({ queryKey: ['ai-history', activeConvId] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => assistantApi.delete(id),
    onSuccess: async (_, id) => {
      if (activeConvId === id) setActiveConvId(null);
      await qc.invalidateQueries({ queryKey: ['ai-conversations', studentId] });
    },
  });

  return (
    <div className="grid h-[70vh] grid-cols-[200px_1fr] gap-4">
      <aside className="flex flex-col gap-2 overflow-y-auto border-r border-border pr-3">
        <button
          onClick={() => start.mutate()}
          disabled={start.isPending}
          className="flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          <Plus className="h-3 w-3" /> New thread
        </button>
        <ul className="space-y-1">
          {conversations?.data.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setActiveConvId(c.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs',
                  activeConvId === c.id ? 'bg-muted' : 'hover:bg-muted/50',
                )}
              >
                <span className="truncate">
                  {c.title || new Date(c.startedAt).toLocaleDateString()}
                </span>
                <Trash2
                  className="h-3 w-3 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Delete this thread?')) remove.mutate(c.id);
                  }}
                />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex flex-col">
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-2">
          {!activeConvId && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Ask anything about this student. Try: "How is reading going this week?" or
              "Show me skipped tasks from the last 14 days."
            </div>
          )}
          {history?.messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {send.isPending && (
            <div className="text-xs text-muted-foreground italic">Thinking…</div>
          )}
          {send.error && (
            <p className="text-xs text-destructive">{(send.error as Error).message}</p>
          )}
          {send.data?.error && (
            <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">
              <p className="text-destructive">{send.data.error}</p>
              {send.data.rawResponse && (
                <details>
                  <summary className="cursor-pointer text-muted-foreground">Raw model output</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
                    {send.data.rawResponse}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() && !send.isPending) send.mutate(draft.trim());
          }}
          className="mt-3 flex gap-2 border-t border-border pt-3"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about this student…"
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={!draft.trim() || send.isPending}
            className="flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            <Send className="h-4 w-4" /> Send
          </button>
        </form>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: AssistantMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted',
        )}
      >
        {renderWithCitations(message.content, message.citations)}
        {message.citations.length > 0 && !isUser && (
          <div className="mt-2 border-t border-border/40 pt-2 text-[10px] text-muted-foreground">
            {message.citations.length} citation{message.citations.length === 1 ? '' : 's'}
          </div>
        )}
      </div>
    </div>
  );
}

function renderWithCitations(
  text: string,
  citations: Array<{ entity: string; id: string; label?: string }>,
): React.ReactNode {
  // Inline citations look like [tasks:abc...] in the model output. Replace
  // each match with a clickable badge that shows the entity + short id.
  const re = /\[(\w+):([0-9a-f-]+)\]/g;
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    const entity = m[1]!;
    const id = m[2]!;
    const cite = citations.find((c) => c.id.startsWith(id) || id.startsWith(c.id));
    out.push(
      <span
        key={key++}
        title={cite?.label ?? `${entity} ${id}`}
        className="mx-0.5 rounded bg-background/60 px-1 py-0.5 text-[10px] font-mono text-muted-foreground"
      >
        {entity}:{id.slice(0, 6)}
      </span>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}
