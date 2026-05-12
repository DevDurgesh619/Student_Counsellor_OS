export default function ConversationsPlaceholder() {
  return (
    <div className="rounded-lg border border-dashed border-border p-10 text-center">
      <h2 className="text-lg font-medium">Conversations</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Empty until WhatsApp Receiver ships in Phase 10. The schema is in place
        (the <code>conversations</code> table) but no inbound channel exists yet
        in v1.
      </p>
    </div>
  );
}
