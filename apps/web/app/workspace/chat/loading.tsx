import './workspace.css';

export default function WorkspaceChatLoading() {
  return (
    <main className="workspace-root min-h-screen bg-[#f2e6cf] text-[#111]">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
        <div className="workspace-panel w-full max-w-xl rounded-2xl border border-[#b8a98b] bg-[#f7edd9] p-8 shadow-[0_12px_40px_rgba(15,23,42,0.12)]">
          <h2 className="text-2xl font-semibold tracking-tight">Opening AI Chat</h2>
          <p className="mt-2 text-sm text-[#303030]">Loading project context and workspace panels...</p>
          <div className="mt-6 typing-dots" aria-hidden>
            <span />
            <span />
            <span />
          </div>
        </div>
      </section>
    </main>
  );
}
