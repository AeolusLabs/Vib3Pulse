// "Play": the one sheet a person uses to get their screen into the match. Not yet a player: pick a side and ask (a host or
// co-host is put straight in). A player: share a game window, stream from OBS (only when the server has ingest on), or, later,
// the phone app. It says plainly to share the game, not the whole screen, and that only game sound goes out.
import { useEffect, useRef, useState } from "react";
import { SIDES, type GameView, type Side } from "@shared/gameScreen";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import { GAME_PROFILES, GAME_PROFILE_HINT, GAME_PROFILE_LABEL, type GameProfile } from "@/lib/bandwidth";
import { SIDE_NAME } from "@/lib/gameScreen";
import "./game.css";

export interface GoLiveGameSheetProps {
  open: boolean;
  onOpenChange(o: boolean): void;
  game: GameView;
  /** The side you are playing on, or null if you aren't in the match yet. */
  mySide: Side | null;
  /** The side you asked for and are waiting on, or null. */
  askedSide: Side | null;
  /** A host or co-host is put in directly; everyone else asks. Only changes the wording. */
  isMod: boolean;
  /** Config says OBS ingest exists. Without it the OBS option isn't drawn at all. */
  ingest: boolean;
  /** Fetches your own stream address and key (server decides; null on a refusal). Never kept after the sheet closes. */
  onGetIngress?: () => Promise<{ url: string; streamKey: string } | null>;
  /** This browser can share a screen (getDisplayMedia exists). */
  canCapture: boolean;
  sharing: boolean;
  shareError: string | null;
  initialProfile: GameProfile;
  nameOf(userId: string): string;
  onJoin(side: Side): void;
  onWithdraw(): void;
  onShare(profile: GameProfile): Promise<void>;
  /** Stop sharing and leave the match. */
  onStop(): void;
  returnFocusTo?: () => HTMLElement | null;
}

const copy = async (text: string): Promise<boolean> => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };

function ObsPanel({ onGet }: { onGet?: () => Promise<{ url: string; streamKey: string } | null> }) {
  const [info, setInfo] = useState<{ url: string; streamKey: string } | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<"url" | "key" | null>(null);
  const [manual, setManual] = useState(false); // the clipboard refused: the field is selected for the person to copy by hand
  const urlEl = useRef<HTMLInputElement>(null);
  const keyEl = useRef<HTMLInputElement>(null);
  useEffect(() => () => { setInfo(null); }, []); // the key is not kept past this panel
  const get = async () => {
    if (!onGet || busy) return;
    setBusy(true); setErr(null);
    const r = await onGet();
    setBusy(false);
    if (r) setInfo(r); else setErr("Couldn't get your stream key. Try again.");
  };
  const doCopy = async (what: "url" | "key") => {
    if (!info) return;
    const ok = await copy(what === "url" ? info.url : info.streamKey);
    setCopied(ok ? what : null);
    setManual(!ok);
    if (!ok) { // select-to-copy fallback; a masked key has to be shown to be selected
      if (what === "key") setShown(true);
      setTimeout(() => { const el = what === "url" ? urlEl.current : keyEl.current; el?.focus(); el?.select(); }, 0);
    }
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <div className="space-y-3 rounded-2xl border p-3" data-testid="game-obs">
      <p className="text-sm text-muted-foreground">Paste into OBS: Settings, Stream. Keep the key to yourself: anyone with it can stream as you.</p>
      {!info ? (
        <Button className="min-h-[44px] rounded-full" variant="outline" disabled={!onGet || busy} onClick={() => void get()} data-testid="game-obs-get">{busy ? "Getting your key…" : "Show my stream key"}</Button>
      ) : (
        <div className="space-y-2">
          <div>
            <label htmlFor="obs-url" className="text-xs font-medium text-muted-foreground">Server address</label>
            <div className="flex gap-2"><input id="obs-url" ref={urlEl} readOnly value={info.url} className="h-11 min-w-0 flex-1 rounded-xl border bg-muted px-3 text-[16px]" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" className="min-h-[44px] rounded-full" onClick={() => void doCopy("url")}>{copied === "url" ? "Copied" : "Copy"}</Button></div>
          </div>
          <div>
            <label htmlFor="obs-key" className="text-xs font-medium text-muted-foreground">Stream key</label>
            <div className="flex gap-2"><input id="obs-key" ref={keyEl} readOnly type={shown ? "text" : "password"} value={info.streamKey} autoComplete="off" className="h-11 min-w-0 flex-1 rounded-xl border bg-muted px-3 text-[16px]" />
              <Button type="button" variant="outline" className="min-h-[44px] rounded-full" aria-pressed={shown} onClick={() => setShown((v) => !v)}>{shown ? "Hide" : "Show"}</Button>
              <Button type="button" variant="outline" className="min-h-[44px] rounded-full" onClick={() => void doCopy("key")}>{copied === "key" ? "Copied" : "Copy"}</Button></div>
          </div>
        </div>
      )}
      {manual && <p role="status" className="text-sm text-muted-foreground">Couldn't copy. Select the text and copy it yourself.</p>}
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

export default function GoLiveGameSheet({ open, onOpenChange, game, mySide, askedSide, isMod, ingest, onGetIngress, canCapture, sharing, shareError, initialProfile, nameOf, onJoin, onWithdraw, onShare, onStop, returnFocusTo }: GoLiveGameSheetProps) {
  const [profile, setProfile] = useState<GameProfile>(initialProfile);
  const [obs, setObs] = useState(false);
  const [starting, setStarting] = useState(false);
  useEffect(() => { if (!open) setObs(false); }, [open]);

  const share = async () => { setStarting(true); await onShare(profile); setStarting(false); };
  const title = mySide ? "Put your screen in the match" : askedSide ? "Waiting for the host" : "Play in this match";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <RoomSheetContent side="bottom" returnFocusTo={returnFocusTo} className="max-h-[88dvh] overflow-y-auto rounded-t-3xl pb-[calc(20px+env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg" data-testid="game-golive-sheet">
        <SheetHeader className="pr-10 text-left">
          <SheetTitle className="font-sans text-lg font-semibold">{title}</SheetTitle>
          <SheetDescription>
            {mySide ? `You're on ${SIDE_NAME[mySide]}. Pick how your game reaches the room.` : askedSide ? `You asked for ${SIDE_NAME[askedSide]}. The host will let you in.` : isMod ? "Pick your side. You go straight in." : "Pick a side. The host lets you in."}
          </SheetDescription>
        </SheetHeader>

        {!mySide && !askedSide && (
          <div className="mt-4 grid grid-cols-2 gap-3" role="group" aria-label="Pick a side">
            {SIDES.map((side) => {
              const full = game.teams[side].length >= game.format;
              return (
                <button key={side} type="button" disabled={full} onClick={() => onJoin(side)} data-testid={`game-join-${side}`}
                  className="flex min-h-[88px] flex-col items-start justify-between gap-2 rounded-2xl border border-border bg-card p-3 text-left disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-safe:transition-transform motion-safe:active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:border-primary">
                  <span className="flex items-center gap-2"><span className="gs-side" data-side={side} aria-hidden>{side}</span><b className="text-base">{SIDE_NAME[side]}</b></span>
                  <span className="text-xs text-muted-foreground">{full ? "Full" : `${game.teams[side].length} of ${game.format} places taken`}{game.teams[side].length > 0 ? `. ${game.teams[side].slice(0, 2).map(nameOf).join(", ")}` : ""}</span>
                </button>
              );
            })}
          </div>
        )}

        {!mySide && askedSide && (
          <div className="mt-4">
            <Button className="min-h-[44px] rounded-full" variant="outline" onClick={onWithdraw} data-testid="game-withdraw">Withdraw my request</Button>
          </div>
        )}

        {mySide && (
          <div className="mt-4 space-y-4">
            <ul className="space-y-1 text-sm text-muted-foreground" aria-label="Before you start">
              <li>Share the game, not your whole screen. Pick the game window.</li>
              <li>Only the game's sound is shared. Your microphone and team voice chat stay out of the room.</li>
            </ul>

            {sharing ? (
              <div className="space-y-3" data-testid="game-sharing">
                <p role="status" className="rounded-xl border bg-muted px-3 py-2 text-sm font-medium">You're sharing. Everyone in the room can see your game.</p>
                <Button className="min-h-[44px] rounded-full" variant="outline" onClick={onStop} data-testid="game-stop">Stop sharing and leave the match</Button>
              </div>
            ) : (
              <>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Quality</legend>
                  <div className="gs-views" role="group" aria-label="Quality">
                    {GAME_PROFILES.map((p) => (
                      <button key={p} type="button" className="gs-view" aria-pressed={profile === p} onClick={() => setProfile(p)} data-testid={`game-profile-${p}`}>{GAME_PROFILE_LABEL[p]}</button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground" aria-live="polite">{GAME_PROFILE_HINT[profile]}</p>
                </fieldset>

                <div className="space-y-2">
                  <Button className="min-h-[56px] w-full justify-start rounded-2xl text-left" disabled={!canCapture || starting} onClick={() => void share()} data-testid="game-share-window">
                    {starting ? "Waiting for you to pick a window…" : "Share a game window"}
                  </Button>
                  {!canCapture && <p className="text-xs text-muted-foreground">This browser can't share a screen. Use a computer, or stream with OBS.</p>}
                  {shareError && <p role="alert" className="text-sm text-destructive" data-testid="game-share-error">{shareError}</p>}

                  {ingest && (
                    <>
                      <Button className="min-h-[56px] w-full justify-start rounded-2xl text-left" variant="outline" aria-expanded={obs} onClick={() => setObs((v) => !v)} data-testid="game-obs-toggle">Stream with OBS</Button>
                      {obs && <ObsPanel onGet={onGetIngress} />}
                    </>
                  )}

                  <Button className="min-h-[56px] w-full justify-start rounded-2xl text-left" variant="outline" disabled aria-describedby="game-phone-why" data-testid="game-phone">Phone</Button>
                  <p id="game-phone-why" className="text-xs text-muted-foreground">Phone capture arrives with the Vib3 app.</p>
                </div>

                <Button className="min-h-[44px] rounded-full" variant="ghost" onClick={onStop} data-testid="game-leave">Leave the match</Button>
              </>
            )}
          </div>
        )}
      </RoomSheetContent>
    </Sheet>
  );
}
