'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { timetableEditorApi, type ChangeSummary, type TimetableMessage } from '@/lib/api';
import { ChangeDiff } from './change-diff';
import { cn } from '@/lib/utils';

/**
 * Conversational timetable editor. Right-rail chat panel: counsellor types,
 * the worker proposes operations, the diff renders inline below the
 * proposing message, Apply/Revert buttons commit/undo.
 *
 * `onApplied` fires after a successful apply with the earliest scheduledStart
 * across all added/moved tasks — caller uses this to jump the week view to
 * where the new tasks landed (otherwise they may fall outside the visible
 * window).
 */
export function EditorChat({
  studentId,
  initialConversationId,
  onApplied,
}: {
  studentId: string;
  initialConversationId?: string;
  onApplied?: (earliestStart: Date | null) => void;
}) {
  const qc = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [draft, setDraft] = useState('');
  // Pending image attachments — base64 data URLs as the file reader
  // produces them; we strip the data: prefix before posting.
  const [pendingImages, setPendingImages] = useState<
    Array<{ name: string; mediaType: string; dataUrl: string }>
  >([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Pull recent conversations so the counsellor can resume one.
  const { data: convs } = useQuery({
    queryKey: ['timetable-conversations', studentId],
    queryFn: () => timetableEditorApi.listConversations(studentId),
  });

  // Auto-select most recent if none chosen — but only when an explicit
  // initialConversationId wasn't provided (otherwise we'd flip away from
  // the one the deep-link asked us to open).
  useEffect(() => {
    if (initialConversationId) return;
    if (!conversationId && convs?.data?.[0]?.id) {
      setConversationId(convs.data[0].id);
    }
  }, [convs, conversationId, initialConversationId]);

  const { data: history } = useQuery({
    queryKey: ['timetable-conversation-history', conversationId],
    queryFn: () => timetableEditorApi.history(conversationId!),
    enabled: Boolean(conversationId),
  });

  const messages: TimetableMessage[] = history?.messages ?? [];

  const startNew = useMutation({
    mutationFn: (isBootstrap: boolean) =>
      timetableEditorApi.startConversation(studentId, { isBootstrap }),
    onSuccess: (conv) => {
      setConversationId(conv.id);
      qc.invalidateQueries({ queryKey: ['timetable-conversations', studentId] });
    },
  });

  const send = useMutation({
    mutationFn: async (content: string) => {
      const images = pendingImages.map((p) => ({
        mediaType: p.mediaType,
        data: p.dataUrl.split(',', 2)[1] ?? '', // strip "data:image/png;base64," prefix
      }));
      return timetableEditorApi.send(conversationId!, content, images);
    },
    onSuccess: (resp) => {
      setDraft('');
      setPendingImages([]);
      qc.invalidateQueries({ queryKey: ['timetable-conversation-history', conversationId] });
      // The route returns HTTP 200 with an `error` field when the LLM
      // call itself fails (truncation, schema fail, etc). Without
      // surfacing this, the user sees their message appear and then
      // nothing — no proposal, no error — and assumes the system is
      // broken. Show the reason in the notice bar.
      if ('error' in resp && resp.error) {
        setNotice({ tone: 'error', text: `Editor failed: ${resp.error}` });
      }
    },
    onError: (err) => {
      setNotice({ tone: 'error', text: `Send failed: ${(err as Error).message}` });
    },
  });

  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const apply = useMutation({
    mutationFn: (changeId: string) => timetableEditorApi.apply(studentId, changeId),
    onSuccess: async (resp) => {
      qc.invalidateQueries({ queryKey: ['student-tasks', studentId] });
      qc.invalidateQueries({ queryKey: ['student-tasks-timetable', studentId] });
      qc.invalidateQueries({ queryKey: ['timetable-change-summary'] });
      const earliest = pickEarliest(resp.summary);
      if (resp.appliedNow) {
        setNotice({
          tone: 'success',
          text:
            resp.tasksAffected === 0
              ? 'Applied — but no tasks were created (recurrence rule expanded to 0 occurrences).'
              : `Applied — ${resp.tasksAffected} task${resp.tasksAffected === 1 ? '' : 's'} affected.`,
        });
      } else if (resp.alreadyApplied) {
        setNotice({
          tone: 'success',
          text: `Already applied earlier — jumping you to ${resp.tasksAffected} affected task${resp.tasksAffected === 1 ? '' : 's'}.`,
        });
      }
      if (onApplied) onApplied(earliest);
    },
    onError: (err) => {
      setNotice({ tone: 'error', text: `Apply failed: ${(err as Error).message}` });
    },
  });
  const revert = useMutation({
    mutationFn: (changeId: string) => timetableEditorApi.revert(studentId, changeId),
    onSuccess: (resp) => {
      qc.invalidateQueries({ queryKey: ['student-tasks', studentId] });
      qc.invalidateQueries({ queryKey: ['student-tasks-timetable', studentId] });
      qc.invalidateQueries({ queryKey: ['timetable-change-summary'] });
      if (resp.revertedNow) {
        setNotice({
          tone: 'success',
          text: `Reverted — restored ${resp.tasksRestored}, cancelled ${resp.tasksCancelled}.`,
        });
      } else if (resp.alreadyReverted) {
        setNotice({ tone: 'success', text: 'Already reverted earlier.' });
      }
    },
    onError: (err) => {
      setNotice({ tone: 'error', text: `Revert failed: ${(err as Error).message}` });
    },
  });
  const deleteConversation = useMutation({
    mutationFn: (cid: string) => timetableEditorApi.deleteConversation(cid),
    onSuccess: (_resp, cid) => {
      if (conversationId === cid) setConversationId(null);
      qc.invalidateQueries({ queryKey: ['timetable-conversations', studentId] });
    },
  });

  // Auto-scroll on new message.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, send.isPending]);

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <h3 className="text-sm font-semibold">Timetable editor</h3>
          <p className="text-[11px] text-muted-foreground">
            Describe a change; review the diff; apply.
          </p>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => startNew.mutate(false)}
            disabled={startNew.isPending}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            New chat
          </button>
          <button
            onClick={() => startNew.mutate(true)}
            disabled={startNew.isPending}
            title="Use for the student's very first timetable (paste schedule from Excel etc.)"
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            Bootstrap
          </button>
        </div>
      </header>

      {notice && (
        <div
          className={cn(
            'flex items-start justify-between gap-2 border-b border-border px-3 py-1.5 text-xs',
            notice.tone === 'success'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
          )}
        >
          <span>{notice.text}</span>
          <button
            onClick={() => setNotice(null)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Conversation list — collapsed by default. Lets the counsellor
          switch between threads or delete stale ones so the editor stays
          clean. Hidden when no other conversations exist. */}
      {convs?.data && convs.data.length > 1 && (
        <details className="border-b border-border">
          <summary className="cursor-pointer px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
            {convs.data.length} conversations · click to manage
          </summary>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto border-t border-border px-2 py-1">
            {convs.data.map((conv) => (
              <li
                key={conv.id}
                className={cn(
                  'flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-muted',
                  conv.id === conversationId && 'bg-muted font-medium',
                )}
              >
                <button
                  onClick={() => setConversationId(conv.id)}
                  className="flex-1 truncate text-left"
                >
                  {conv.title || (conv.isBootstrap ? 'Bootstrap' : 'Untitled')} ·{' '}
                  <span className="text-muted-foreground">
                    {new Date(conv.startedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </button>
                <button
                  onClick={() => {
                    if (window.confirm('Delete this conversation? This can’t be undone.')) {
                      deleteConversation.mutate(conv.id);
                    }
                  }}
                  className="ml-2 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="Delete conversation"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {!conversationId && (
        <div className="flex-1 px-3 py-6 text-center text-xs text-muted-foreground">
          Start a new chat to propose schedule changes.
        </div>
      )}

      {conversationId && (
        <>
          <div ref={scrollerRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.length === 0 && (
              <p className="text-center text-xs text-muted-foreground">
                No messages yet. Try: &ldquo;Move Math AI from MWF 8am to TuTh 8am.&rdquo;
              </p>
            )}
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                studentId={studentId}
                onApply={(cid) => apply.mutate(cid)}
                onRevert={(cid) => revert.mutate(cid)}
                applying={apply.isPending}
                reverting={revert.isPending}
              />
            ))}
            {send.isPending && (
              <p className="text-xs text-muted-foreground">Editor is thinking…</p>
            )}
          </div>

          <footer className="space-y-2 border-t border-border p-2">
            {/* Thumbnails for any attached images. Click × to remove
                before sending. */}
            {pendingImages.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {pendingImages.map((img, i) => (
                  <li
                    key={i}
                    className="relative rounded-md border border-border bg-muted/30 p-1"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      className="h-14 w-14 rounded object-cover"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setPendingImages((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="absolute -right-1 -top-1 rounded-full bg-background p-0.5 text-xs text-muted-foreground shadow ring-1 ring-border hover:text-destructive"
                      aria-label={`Remove ${img.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!draft.trim() && pendingImages.length === 0) return;
                send.mutate(draft.trim() || '(see attached image)');
              }}
              className="flex gap-2"
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  pendingImages.length > 0
                    ? 'Add a note (or send the image as-is)…'
                    : 'Describe a change…'
                }
                rows={2}
                disabled={send.isPending}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (draft.trim() || pendingImages.length > 0) {
                      send.mutate(draft.trim() || '(see attached image)');
                    }
                  }
                }}
                className="flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              />
              <div className="flex flex-col gap-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  className="hidden"
                  onChange={async (e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length === 0) return;
                    const next: typeof pendingImages = [];
                    for (const f of files) {
                      if (pendingImages.length + next.length >= 4) break;
                      // 5 MB raw cap per image; the server also enforces an
                      // aggregate budget.
                      if (f.size > 5 * 1024 * 1024) continue;
                      const dataUrl = await new Promise<string>((resolve, reject) => {
                        const r = new FileReader();
                        r.onload = () => resolve(r.result as string);
                        r.onerror = () => reject(r.error);
                        r.readAsDataURL(f);
                      });
                      next.push({ name: f.name, mediaType: f.type, dataUrl });
                    }
                    setPendingImages((prev) => [...prev, ...next]);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={send.isPending || pendingImages.length >= 4}
                  className="self-end rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                  title="Attach image (screenshot of an Excel sheet, paper schedule, etc.)"
                >
                  📎
                </button>
                <button
                  type="submit"
                  disabled={(!draft.trim() && pendingImages.length === 0) || send.isPending}
                  className="self-end rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </form>
          </footer>
        </>
      )}
    </div>
  );
}

function pickEarliest(summary: ChangeSummary | undefined): Date | null {
  if (!summary) return null;
  const all = [
    ...summary.added.map((t) => t.scheduledStart),
    ...summary.moved.map((m) => m.to.scheduledStart),
  ];
  if (all.length === 0) return null;
  const earliestStr = all.reduce((a, b) => (a < b ? a : b));
  return new Date(earliestStr);
}

function MessageBubble({
  message,
  studentId,
  onApply,
  onRevert,
  applying,
  reverting,
}: {
  message: TimetableMessage;
  studentId: string;
  onApply: (cid: string) => void;
  onRevert: (cid: string) => void;
  applying: boolean;
  reverting: boolean;
}) {
  const isUser = message.role === 'user';
  // Read the change's current status from the summary cache so the buttons
  // reflect the actual state machine: draft → Apply only; active → Revert
  // only; reverted → no buttons. ChangeDiff observes the same query so the
  // cache is hot. Falls back to 'draft' until the first fetch lands.
  const summary = useQuery({
    queryKey: ['timetable-change-summary', message.proposedChangeId],
    queryFn: () => timetableEditorApi.summary(studentId, message.proposedChangeId!),
    enabled: Boolean(message.proposedChangeId),
  });
  const status: 'draft' | 'active' | 'reverted' | 'unknown' =
    summary.data?.change?.status ?? 'unknown';

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[90%] space-y-2 rounded-lg px-3 py-2 text-sm',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted',
        )}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
        {message.proposedChangeId && (
          <div className="space-y-2 rounded-md border border-border bg-background p-2 text-foreground">
            <ChangeDiff studentId={studentId} changeId={message.proposedChangeId} />
            <div className="flex gap-2">
              {status === 'draft' && (
                <button
                  onClick={() => onApply(message.proposedChangeId!)}
                  disabled={applying}
                  className="rounded-md bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {applying ? 'Applying…' : 'Apply'}
                </button>
              )}
              {status === 'active' && (
                <button
                  onClick={() => onRevert(message.proposedChangeId!)}
                  disabled={reverting}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {reverting ? 'Reverting…' : 'Revert'}
                </button>
              )}
              {status === 'reverted' && (
                <span className="text-xs text-muted-foreground">
                  Send a new message to redo this change.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
