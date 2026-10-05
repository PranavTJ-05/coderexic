'use client';

import { useEffect } from 'react';
import './landing.css';

const LANGUAGES = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'Ruby'];
const PROVIDERS = ['Gemini', 'OpenAI', 'Anthropic', 'Groq'];

const STEPS = [
  {
    n: '01',
    title: 'PR opened or pushed',
    body: 'GitHub sends a webhook; the signature is verified over the raw bytes before anything else runs.',
  },
  {
    n: '02',
    title: 'Job queued',
    body: 'A review job lands on Redis/BullMQ - idempotent, so a redelivered webhook never double-reviews a PR.',
  },
  {
    n: '03',
    title: 'Diff + config fetched',
    body: "The worker reads the PR's files, its .coderexic.yml and rules - from the base commit, never the head.",
  },
  {
    n: '04',
    title: 'Graph context assembled',
    body: 'The dependency graph resolves what changed files import and what depends on them.',
  },
  {
    n: '05',
    title: 'Model reviews',
    body: 'One-shot, or - opt-in - an agent loop that fetches more context on demand before submitting findings.',
  },
  {
    n: '06',
    title: 'Review posted',
    body: 'Filtered by severity and ignore rules, deduped, placed on real diff lines - inline comments plus a summary.',
  },
];

const HERO_FEATURES = [
  {
    mark: '◈',
    markColor: 'var(--ember)',
    markBg: 'rgba(255,106,61,0.12)',
    title: 'Dependency-aware context',
    body: 'An incremental graph indexer resolves imports across TypeScript, JavaScript, Python, Go, Rust, Java and Ruby - both forward and reverse - so review isn’t limited to the diff’s own lines.',
  },
  {
    mark: '◉',
    markColor: 'var(--teal)',
    markBg: 'rgba(79,227,193,0.12)',
    title: 'Agentic review loop',
    body: 'Opt-in: the model decides when to call get_imports, get_dependents and get_file_content before ending with submit_review, instead of everything pre-fetched for it.',
  },
];

const FEATURE_TILES = [
  {
    title: 'Automatic PR review',
    body: 'Opening or pushing to a PR queues a review - no setup beyond installing the App.',
  },
  {
    title: 'One-shot fallback',
    body: 'A single deterministic prompt when the agent loop is off - cheap and always available.',
  },
  {
    title: 'Multi-provider models',
    body: "Gemini, OpenAI, Anthropic or Groq - a repo's .coderexic.yml can select a different configured provider per review.",
  },
  {
    title: 'Bring your own key',
    body: 'Encrypted at rest (AES-256-GCM, versioned, rotatable), resolved repo > user > system at review time.',
  },
  {
    title: 'Repo-specific rules',
    body: "Loaded from the PR's base commit - it can't edit its own rules to silence findings about itself.",
  },
  {
    title: 'Manual re-review',
    body: 'Comment /review review on an open PR to trigger a fresh pass on demand.',
  },
  {
    title: 'Web dashboard',
    body: 'Sign in with GitHub, browse review history, manage settings - authorization re-checked live, never cached.',
  },
  {
    title: 'Observability',
    body: 'Prometheus metrics on queue depth, latency, token usage and errors - bearer-token gated.',
  },
  {
    title: 'Evaluation harness',
    body: 'A scored suite of known-bug and false-positive fixtures runs through the exact pipeline production uses.',
  },
];

function Marquee({ items, reverse = false }: { items: string[]; reverse?: boolean }) {
  const row = (
    <span className="flex gap-12 pr-12">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-12">
          <span style={reverse ? { color: 'var(--ink)' } : undefined}>{item}</span>
          <span style={{ color: 'var(--border)' }}>&#9670;</span>
        </span>
      ))}
    </span>
  );
  return (
    <div className="overflow-hidden border-y border-[var(--border)] py-5 reveal">
      <div
        className={`marquee-track font-mono-landing ${reverse ? 'rev' : ''}`}
        style={{ fontSize: 14, color: 'var(--muted)' }}
      >
        {row}
        {row}
      </div>
    </div>
  );
}

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3.5 8H12.5M12.5 8L8.5 4M12.5 8L8.5 12"
        stroke="#141414"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3L4 6.5V11.5C4 16.5 7.4 20.7 12 22C16.6 20.7 20 16.5 20 11.5V6.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M9 12L11 14L15.5 9.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The marketing landing page at `/` (apps/web/app/page.tsx renders this for
 * signed-out visitors only - a signed-in visitor is redirected to
 * /dashboard before this ever mounts). Ported from the approved design
 * (an artifact shared during planning) into real components; copy mirrors
 * README.md's own Features section so it can't drift from what's actually
 * shipped.
 */
export function LandingPage() {
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) entry.target.classList.add('in');
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    );
    for (const el of document.querySelectorAll('.coderexic-landing .reveal')) io.observe(el);
    return () => {
      io.disconnect();
    };
  }, []);

  return (
    <div className="coderexic-landing relative min-h-screen w-full overflow-x-hidden">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(900px 500px at 15% -10%, rgba(255,106,61,0.10), transparent 60%), radial-gradient(800px 600px at 110% 10%, rgba(79,227,193,0.08), transparent 55%)',
        }}
      />

      {/* NAV */}
      <div
        className="sticky top-0 z-50 border-b border-[var(--border)]"
        style={{ backdropFilter: 'blur(14px)', background: 'rgba(14,16,19,0.72)' }}
      >
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-7 py-[18px]">
          <a href="#top" className="flex items-center gap-3 no-underline">
            <img src="/icon.png" alt="" width={34} height={34} className="block rounded-[9px]" />
            <span className="text-[19px] font-bold tracking-tight">coderexic</span>
          </a>
          <div className="flex items-center gap-7">
            <a
              href="#features"
              className="nav-link font-mono-landing hide-mobile text-[13px] no-underline"
              style={{ color: 'var(--muted)' }}
            >
              features
            </a>
            <a
              href="#how"
              className="nav-link font-mono-landing hide-mobile text-[13px] no-underline"
              style={{ color: 'var(--muted)' }}
            >
              how it works
            </a>
            <a
              href="https://github.com/PranavTJ-05/coderexic"
              className="nav-link font-mono-landing hide-mobile text-[13px] no-underline"
              style={{ color: 'var(--muted)' }}
            >
              github
            </a>
            <a
              href="/api/auth/signin/github"
              className="btn-primary rounded-[10px] px-[18px] py-[9px] text-sm font-semibold no-underline"
            >
              Let&rsquo;s start now
            </a>
          </div>
        </div>
      </div>

      {/* HERO */}
      <div id="top" className="relative mx-auto max-w-[1200px] px-7 pb-20 pt-14 md:pt-24">
        <div
          className="glow hide-mobile pointer-events-none absolute right-[-60px] top-10 h-[360px] w-[360px] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(255,106,61,0.22), transparent 70%)',
            filter: 'blur(10px)',
          }}
        />

        <div
          className="font-mono-landing reveal in inline-flex items-center gap-2 rounded-full px-[14px] py-[7px] text-[12.5px] uppercase tracking-wide"
          style={{
            color: 'var(--teal)',
            background: 'rgba(79,227,193,0.08)',
            border: '1px solid rgba(79,227,193,0.25)',
          }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--teal)' }}
          />
          agentic pr review &middot; open source
        </div>

        <h1
          className="reveal in reveal-d1 mt-6 max-w-[920px] font-bold"
          style={{ fontSize: 'clamp(40px,6.2vw,84px)', lineHeight: 1.02, letterSpacing: '-0.03em' }}
        >
          Code review that reads
          <br />
          the whole repo<span style={{ color: 'var(--ember)' }}>,</span> not just the diff.
        </h1>

        <p
          className="reveal in reveal-d2 mt-6 max-w-[640px]"
          style={{ fontSize: 'clamp(16px,1.7vw,20px)', lineHeight: 1.6, color: 'var(--muted)' }}
        >
          Coderexic maps what every changed file imports and what depends on it, lets an AI agent
          pull in exactly the context it needs, and posts validated findings as real inline comments
          on the PR &mdash; not guesses from a diff in isolation.
        </p>

        <div className="reveal in reveal-d2 mt-9 flex flex-wrap gap-3.5">
          <a
            href="/api/auth/signin/github"
            className="btn-primary inline-flex items-center gap-2.5 rounded-xl px-7 py-[15px] text-base font-bold no-underline"
          >
            Let&rsquo;s start now
            <ArrowIcon />
          </a>
          <a
            href="#how"
            className="btn-ghost rounded-xl border px-7 py-[15px] text-base font-semibold no-underline"
            style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
          >
            See how it works
          </a>
        </div>

        {/* floating review mock */}
        <div className="reveal in reveal-d3 mt-16 flex items-start gap-5">
          <div className="card font-mono-landing min-w-0 max-w-[680px] flex-1 overflow-hidden p-0">
            <div
              className="flex items-center gap-2 border-b border-[var(--border)] px-[18px] py-3"
              style={{ background: 'var(--bg-raised-2)' }}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#FF6A3D' }} />
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: '#4FE3C1', opacity: 0.6 }}
              />
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: 'var(--muted)', opacity: 0.4 }}
              />
              <span className="ml-2.5 text-xs" style={{ color: 'var(--muted)' }}>
                src/auth/session.ts
              </span>
            </div>
            <div className="px-[22px] py-5 text-[13.5px]" style={{ lineHeight: 1.85 }}>
              <div style={{ color: 'var(--muted)' }}>
                41&nbsp;&nbsp;export function validateToken(token) {'{'}
              </div>
              <div style={{ background: 'rgba(255,106,61,0.10)', color: '#FFB49B' }}>
                42&nbsp; -&nbsp;const scope = DEFAULT_SCOPE;
              </div>
              <div style={{ background: 'rgba(79,227,193,0.10)', color: '#BFF3E6' }}>
                42&nbsp; +&nbsp;const scope = requiredScope ?? DEFAULT_SCOPE;
              </div>
              <div style={{ color: 'var(--muted)' }}>43&nbsp;&nbsp;return scopes.has(scope);</div>
              <div style={{ color: 'var(--muted)' }}>44&nbsp;&nbsp;{'}'}</div>
            </div>
            <div
              className="mx-[18px] mb-[18px] flex gap-3 rounded-xl border p-4"
              style={{ background: 'var(--bg-raised-2)', borderColor: 'var(--border)' }}
            >
              <span
                className="h-fit flex-none rounded-md px-2 py-0.5 text-[10.5px] font-bold tracking-wide"
                style={{
                  color: '#FFB49B',
                  background: 'rgba(255,106,61,0.14)',
                  border: '1px solid rgba(255,106,61,0.3)',
                }}
              >
                HIGH
              </span>
              <div className="text-[13px]" style={{ lineHeight: 1.55, color: 'var(--ink)' }}>
                <strong>coderexic</strong>{' '}
                <span style={{ color: 'var(--muted)' }}>&middot; reviewed 2 related files</span>
                <br />
                <span style={{ color: 'var(--muted)' }}>
                  apps/admin/users.ts:88 still calls <code>validateToken(token)</code> with the old
                  signature &mdash; <code>requiredScope</code> will be <code>undefined</code> there,
                  silently widening access.
                </span>
              </div>
            </div>
          </div>
          <div
            className="card font-mono-landing hide-mobile flex flex-1 flex-col gap-3.5 self-stretch p-[22px] text-[12.5px]"
            style={{ color: 'var(--muted)' }}
          >
            <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              this run
            </div>
            <div className="flex justify-between">
              <span>files changed</span>
              <span style={{ color: 'var(--ink)' }}>4</span>
            </div>
            <div className="flex justify-between">
              <span>related files pulled in</span>
              <span style={{ color: 'var(--teal)' }}>2</span>
            </div>
            <div className="flex justify-between">
              <span>findings</span>
              <span style={{ color: 'var(--ember-soft)' }}>1 high</span>
            </div>
            <div className="flex justify-between">
              <span>mode</span>
              <span style={{ color: 'var(--ink)' }}>agent loop</span>
            </div>
            <div className="my-1 h-px" style={{ background: 'var(--border)' }} />
            <div style={{ color: 'var(--muted)' }}>
              diff-only review would
              <br />
              have missed this.
              <span className="caret" />
            </div>
          </div>
        </div>
      </div>

      <Marquee items={LANGUAGES} />

      {/* STATS */}
      <div className="mx-auto flex max-w-[1200px] flex-wrap gap-5 px-7 pb-5 pt-14">
        {[
          { value: '18', suffix: '/22', label: 'roadmap phases shipped', color: 'var(--ember)' },
          { value: '685', label: 'tests passing (unit + integration)', color: 'var(--teal)' },
          { value: '7', label: 'languages in the dependency graph', color: 'var(--ink)' },
          { value: '4', label: 'model providers, bring your own key', color: 'var(--ink)' },
        ].map((s, i) => (
          <div
            key={s.label}
            className={`card reveal reveal-d${i} min-w-[220px] flex-1 px-6 py-[26px]`}
          >
            <div className="font-bold" style={{ fontSize: 'clamp(30px,3vw,40px)', color: s.color }}>
              {s.value}
              {s.suffix && (
                <span className="text-xl" style={{ color: 'var(--muted)' }}>
                  {s.suffix}
                </span>
              )}
            </div>
            <div
              className="font-mono-landing mt-1.5 text-[12.5px]"
              style={{ color: 'var(--muted)' }}
            >
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* PROBLEM */}
      <div className="mx-auto max-w-[1200px] px-7 pb-10 pt-28">
        <div className="stack-mobile flex flex-wrap gap-14">
          <div className="reveal min-w-[380px] flex-1">
            <div
              className="font-mono-landing text-[12.5px] uppercase tracking-wide"
              style={{ color: 'var(--ember)' }}
            >
              the blind spot
            </div>
            <h2
              className="mt-4 font-bold"
              style={{
                fontSize: 'clamp(28px,3.4vw,42px)',
                lineHeight: 1.12,
                letterSpacing: '-0.02em',
              }}
            >
              A diff-only review can&rsquo;t see what it can&rsquo;t see.
            </h2>
          </div>
          <div className="reveal reveal-d1 min-w-[380px] flex-1">
            <p className="text-[17px]" style={{ lineHeight: 1.75, color: 'var(--muted)' }}>
              A function edited in isolation might break a caller three files away, silently change
              an auth check, or violate a convention only visible in a sibling file. Coderexic gives
              the model a map of the repository &mdash; what a file imports, what imports it back
              &mdash; and lets it decide what else to look at, instead of guessing from the diff
              alone.
            </p>
          </div>
        </div>
      </div>

      {/* HOW IT WORKS */}
      <div id="how" className="mx-auto max-w-[1200px] px-7 pb-10 pt-24">
        <div
          className="font-mono-landing reveal text-[12.5px] uppercase tracking-wide"
          style={{ color: 'var(--teal)' }}
        >
          how it works
        </div>
        <h2
          className="reveal mb-12 mt-4 max-w-[680px] font-bold"
          style={{ fontSize: 'clamp(28px,3.4vw,42px)', letterSpacing: '-0.02em' }}
        >
          From a pushed commit to a validated review, in six steps.
        </h2>

        <div className="flex flex-wrap gap-4">
          {STEPS.map((step, i) => (
            <div
              key={step.n}
              className={`step card reveal reveal-d${i % 4} min-w-[280px] flex-1 px-[22px] py-[26px]`}
            >
              <div
                className="step-num flex h-[38px] w-[38px] items-center justify-center rounded-full border font-mono-landing text-sm"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                {step.n}
              </div>
              <div className="mt-4 text-base font-semibold">{step.title}</div>
              <div className="mt-2 text-sm" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>
                {step.body}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* FEATURES */}
      <div id="features" className="mx-auto max-w-[1200px] px-7 pb-10 pt-24">
        <div
          className="font-mono-landing reveal text-[12.5px] uppercase tracking-wide"
          style={{ color: 'var(--ember)' }}
        >
          everything, shipped
        </div>
        <h2
          className="reveal mb-12 mt-4 max-w-[680px] font-bold"
          style={{ fontSize: 'clamp(28px,3.4vw,42px)', letterSpacing: '-0.02em' }}
        >
          Eleven phases of actual engineering, not a prompt wrapper.
        </h2>

        <div className="grid grid-cols-2 gap-[18px] md:grid-cols-6">
          {HERO_FEATURES.map((f, i) => (
            <div key={f.title} className={`card reveal reveal-d${i} col-span-2 p-8 md:col-span-3`}>
              <div
                className="font-mono-landing flex h-10 w-10 items-center justify-center rounded-[11px] text-lg"
                style={{ background: f.markBg, color: f.markColor }}
              >
                {f.mark}
              </div>
              <div className="mt-[18px] text-[19px] font-bold">{f.title}</div>
              <div
                className="mt-2.5 text-[14.5px]"
                style={{ color: 'var(--muted)', lineHeight: 1.6 }}
              >
                {f.body}
              </div>
            </div>
          ))}

          {FEATURE_TILES.map((t, i) => (
            <div key={t.title} className={`card reveal reveal-d${i % 4} col-span-2 p-[26px]`}>
              <div className="text-base font-semibold">{t.title}</div>
              <div
                className="mt-2 text-[13.5px]"
                style={{ color: 'var(--muted)', lineHeight: 1.55 }}
              >
                {t.body}
              </div>
            </div>
          ))}

          <div className="card reveal col-span-2 flex flex-wrap items-center gap-5 px-8 py-7 md:col-span-6">
            <div
              className="flex h-10 w-10 flex-none items-center justify-center rounded-[11px]"
              style={{ background: 'rgba(245,243,236,0.08)', color: 'var(--teal)' }}
            >
              <ShieldIcon />
            </div>
            <div className="min-w-[320px] flex-1">
              <div className="text-[17px] font-bold">Security-hardened, not assumed</div>
              <div
                className="mt-1.5 text-[13.5px]"
                style={{ color: 'var(--muted)', lineHeight: 1.55 }}
              >
                Signature-verified webhooks, path-traversal and prompt-injection guards, per-turn
                tool-call caps, and repo-isolation tests against the exact cross-tenant attack an
                IDOR guard exists to stop &mdash; audited in Phase 16, not assumed safe.
              </div>
            </div>
          </div>
        </div>
      </div>

      <Marquee items={PROVIDERS} reverse />

      {/* FINAL CTA */}
      <div className="mx-auto max-w-[1200px] px-7 py-32">
        <div className="card reveal relative overflow-hidden px-6 py-16 text-center md:px-[70px] md:py-[90px]">
          <div
            className="glow pointer-events-none absolute -top-20 left-1/2 h-[260px] w-[460px] -translate-x-1/2"
            style={{
              background: 'radial-gradient(ellipse, rgba(255,106,61,0.22), transparent 70%)',
            }}
          />
          <div className="relative">
            <img
              src="/icon.png"
              alt=""
              width={56}
              height={56}
              className="mx-auto mb-6 block rounded-2xl"
            />
            <h2
              className="font-bold"
              style={{
                fontSize: 'clamp(32px,5vw,58px)',
                lineHeight: 1.04,
                letterSpacing: '-0.03em',
              }}
            >
              Let&rsquo;s start now.
            </h2>
            <p
              className="mx-auto mt-5 max-w-[520px] text-[17px]"
              style={{ color: 'var(--muted)', lineHeight: 1.6 }}
            >
              Open source, self-hostable, and built to give an AI reviewer the same map of your repo
              a senior engineer already carries in their head.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3.5">
              <a
                href="/api/auth/signin/github"
                className="btn-primary inline-flex items-center gap-2.5 rounded-xl px-8 py-[17px] text-[17px] font-bold no-underline"
              >
                Let&rsquo;s start now
                <ArrowIcon />
              </a>
              <a
                href="https://github.com/PranavTJ-05/coderexic"
                className="btn-ghost rounded-xl border px-8 py-[17px] text-[17px] font-semibold no-underline"
                style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
              >
                View on GitHub
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <div className="border-t border-[var(--border)] px-7 py-11">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-5">
          <div className="flex items-center gap-2.5">
            <img src="/icon.png" alt="" width={24} height={24} className="block rounded-[7px]" />
            <span className="font-mono-landing text-[13px]" style={{ color: 'var(--muted)' }}>
              coderexic &mdash; the apex predator of pull request review
            </span>
          </div>
          <div
            className="font-mono-landing flex gap-6 text-[13px]"
            style={{ color: 'var(--muted)' }}
          >
            <a href="https://github.com/PranavTJ-05/coderexic" className="nav-link no-underline">
              github
            </a>
            <a
              href="https://github.com/PranavTJ-05/coderexic/blob/main/ROADMAP.md"
              className="nav-link no-underline"
            >
              roadmap
            </a>
            <a
              href="https://github.com/PranavTJ-05/coderexic/blob/main/PRODUCT_SPEC.md"
              className="nav-link no-underline"
            >
              product spec
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
