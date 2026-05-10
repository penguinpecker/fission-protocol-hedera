// Shared shell + typography for /privacy, /terms, /risks. Keeps the legal
// pages visually consistent without bringing in MDX or a doc-site dep.

export function LegalShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-[760px] px-6 py-20">
      <article className="space-y-5 text-[15px] leading-[1.7] text-textSec">{children}</article>
    </section>
  );
}

export function H1({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="mb-2 text-[44px] font-light leading-[1.05] tracking-[-1.5px] text-text">
      {children}
    </h1>
  );
}

export function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-10 text-[22px] font-semibold tracking-tight text-text">{children}</h2>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="text-textSec">{children}</p>;
}

export function UL({ children }: { children: React.ReactNode }) {
  return <ul className="ml-5 list-disc space-y-2 text-textSec">{children}</ul>;
}
