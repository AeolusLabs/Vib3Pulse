import { useMemo, type CSSProperties } from "react";

// App screens drawn from the real components (TicketPass, PollMessage) so the landing page can show a ticket
// and a group-chat poll without a screenshot. Static sample content only; nothing here reads user data.

function rnd(seed: number) {
  let s = seed * 9301 + 49297;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}
const isEye = (x: number, y: number) => (x < 4 && y < 4) || (x > 10 && y < 4) || (x < 4 && y > 10);
const eyeOn = (x: number, y: number) => {
  const lx = x > 10 ? x - 11 : x, ly = y > 10 ? y - 11 : y;
  return lx === 0 || lx === 3 || ly === 0 || ly === 3 || (lx >= 1 && lx <= 2 && ly >= 1 && ly <= 2);
};

/** A decorative QR-style grid (not scannable, by design). */
export function Qr({ seed = 5 }: { seed?: number }) {
  const cells = useMemo(() => {
    const r = rnd(seed), out: boolean[] = [];
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) out.push(isEye(x, y) ? eyeOn(x, y) : r() > 0.5);
    return out;
  }, [seed]);
  return <div className="qr" aria-hidden="true">{cells.map((on, i) => <i key={i} className={on ? undefined : "o"} />)}</div>;
}

/** Barcode strip for the ticket stubs. */
export function Bars({ n = 36, seed = 7 }: { n?: number; seed?: number }) {
  const w = useMemo(() => { const r = rnd(seed); return Array.from({ length: n }, () => 1 + Math.floor(r() * 4)); }, [n, seed]);
  return <div className="bars" aria-hidden="true">{w.map((x, i) => <i key={i} style={{ width: x }} />)}</div>;
}

function BottomNav({ active }: { active: "Tickets" | "Messages" }) {
  return (
    <div className="nav5">
      {["Feed", "Discover", "Map", "Tickets", "Messages"].map((l) => (l === active ? <b key={l}>{l}</b> : <span key={l}>{l}</span>))}
    </div>
  );
}

export function TicketScreen({ label }: { label?: string }) {
  return (
    <div className="appscr" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <div className="ttl">Tickets<small>1 ticket</small></div>
      <article className="pass">
        <div className="t">
          <div className="r1"><b>Vib3Pulse</b><span>Event ticket</span></div>
          <h4>Friday Pre-Drinks</h4>
          <p className="pl">Sample venue</p>
          <dl>
            <div><dt>Date</dt><dd>Fri 6 Nov</dd></div>
            <div><dt>Doors</dt><dd>8:00 PM</dd></div>
            <div><dt>Type</dt><dd>General</dd></div>
            <div><dt>Holder</dt><dd>Ada</dd></div>
            <div><dt>Paid</dt><dd>₦5,000</dd></div>
          </dl>
        </div>
        <div className="perf" />
        <div className="code"><Qr seed={5} /><span className="sc">VP7K·29MQ</span><span className="ok">✓ Valid · not scanned yet</span></div>
      </article>
      <p className="hint">Show this at the door. Staff scan it.</p>
      <BottomNav active="Tickets" />
    </div>
  );
}

export function ChatScreen({ label }: { label?: string }) {
  return (
    <div className="appscr" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <div className="gh"><span className="bk">‹</span><span className="av l">FC</span><div><b>Friday crew</b><small>6 members</small></div></div>
      <div className="feed">
        <div className="m"><span className="av b">T</span><div className="bub">Where are we pre-drinking?</div></div>
        <div className="poll">
          <div className="ic">▮ Poll</div>
          <h5>Where are we pre-drinking Friday?</h5>
          <div className="opt v"><div className="h"><span>✓ The rooftop</span><em>57%</em></div><div className="pb"><i style={{ "--w": "57%" } as CSSProperties} /></div><div className="vt"><span className="av">A</span><span className="av b">T</span><span className="av c">K</span><span className="av d">Z</span> 4 votes</div></div>
          <div className="opt"><div className="h"><span>Ade's place</span><em>29%</em></div><div className="pb"><i style={{ "--w": "29%" } as CSSProperties} /></div><div className="vt"><span className="av c">M</span><span className="av b">S</span> 2 votes</div></div>
          <div className="opt"><div className="h"><span>Beach lounge</span><em>14%</em></div><div className="pb"><i style={{ "--w": "14%" } as CSSProperties} /></div><div className="vt"><span className="av d">J</span> 1 vote</div></div>
          <div className="ft"><span>7 votes · Ends in 5 hours</span><span>6 members</span></div>
        </div>
        <div className="m me"><div className="bub">Rooftop, I'm in.</div></div>
        <div className="m"><span className="av c">K</span><div className="bub">Booking tickets now.</div></div>
      </div>
      <div className="inp"><span>Message the crew</span><i /></div>
    </div>
  );
}
