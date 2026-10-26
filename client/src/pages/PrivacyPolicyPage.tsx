import { Fragment, useEffect, useState } from "react";
import { Link } from "wouter";
import { PRIVACY_POLICY, policyBadge, visibleSections } from "@shared/privacyPolicy";
import { ArrowLeftIcon } from "@/components/ui/icons";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400 rounded-sm";
const MAIL = /(info@aeoluslabsltd\.com)/;

/** Turns the contact address inside copy into a mailto link; everything else stays plain text. */
function Text({ children }: { children: string }) {
  return (
    <>
      {children.split(MAIL).map((part, i) =>
        MAIL.test(part) ? (
          <a key={i} href={`mailto:${part}`} className={`text-violet-400 underline underline-offset-2 hover:text-violet-300 ${FOCUS}`}>{part}</a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export default function PrivacyPolicyPage() {
  const { version, lastUpdated, status, contactEmail } = PRIVACY_POLICY;
  const badge = policyBadge(status);
  // The age review text appears only once the feature is live. Loading or any failure counts as off, so the policy never promises a feature that is not there.
  const [ageReviewOn, setAgeReviewOn] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/age-review/enabled", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) setAgeReviewOn(j?.enabled === true); })
      .catch(() => { if (live) setAgeReviewOn(false); });
    return () => { live = false; };
  }, []);
  const sections = visibleSections(PRIVACY_POLICY, ageReviewOn);

  // Public page with anchor links: honour #section on first load, since sections render after hydration.
  useEffect(() => {
    document.title = "Privacy policy | Vib3Pulse";
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [ageReviewOn]);

  return (
    <div className="min-h-screen overflow-x-clip bg-[#090909] font-sans text-white/80" data-testid="page-privacy">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5 sm:px-6">
        <Link href="/" className={`inline-flex min-h-[44px] items-center gap-2 text-sm text-white/60 transition-colors hover:text-white ${FOCUS}`}>
          <ArrowLeftIcon className="h-4 w-4" aria-hidden />Vib3Pulse
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-24 pt-6 sm:px-6 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-14">
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <nav aria-label="On this page" className="mb-10 lg:mb-0">
            <p className="mb-2 text-[0.65rem] font-medium uppercase tracking-[0.28em] text-white/40">On this page</p>
            <ol className="space-y-0.5">
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className={`flex min-h-[44px] items-center text-sm text-white/60 transition-colors hover:text-white lg:min-h-[32px] ${FOCUS}`}>{s.title}</a>
                </li>
              ))}
            </ol>
          </nav>
        </aside>

        <article className="min-w-0">
          <div className="mb-12">
            {badge && (
              <p className="mb-4 inline-block rounded-full border border-white/20 px-3 py-1.5 text-[0.65rem] font-medium uppercase tracking-[0.2em] text-white/80" data-testid="privacy-draft-badge" role="note">{badge}</p>
            )}
            <h1 className="font-serif text-5xl leading-[0.95] tracking-tight text-white sm:text-6xl [overflow-wrap:anywhere]">Privacy policy</h1>
            <p className="mt-5 text-sm text-white/50" data-testid="privacy-version">
              Version {version}. Last updated <time dateTime={lastUpdated}>{lastUpdated}</time>.{" "}
              <a href={`mailto:${contactEmail}`} className={`text-violet-400 underline underline-offset-2 hover:text-violet-300 ${FOCUS}`}>{contactEmail}</a>
            </p>
          </div>

          <div className="space-y-14">
            {sections.map((s) => (
              <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} className="scroll-mt-8">
                <h2 id={`${s.id}-h`} className="mb-4 font-serif text-3xl leading-tight tracking-tight text-white">{s.title}</h2>
                <div className="max-w-[68ch] space-y-4 text-base leading-relaxed">
                  {s.paragraphs.map((p, i) => <p key={i}><Text>{p}</Text></p>)}
                  {s.bullets && (
                    <ul className="list-disc space-y-2 pl-5 marker:text-white/30">
                      {s.bullets.map((b, i) => <li key={i} className="pl-1"><Text>{b}</Text></li>)}
                    </ul>
                  )}
                  {s.afterBullets?.map((p, i) => <p key={`a${i}`}><Text>{p}</Text></p>)}
                </div>
              </section>
            ))}
          </div>
        </article>
      </main>
    </div>
  );
}
