// The server layout (app/layout.tsx) resolves the destination for `/` before
// this component ever renders, so this body is effectively unreachable. Kept
// as a tiny fallback in case the gate ever defers (e.g. dev HMR).
export default function Home() {
  return <p className="p-6 text-sm text-muted-foreground">Redirecting…</p>;
}
