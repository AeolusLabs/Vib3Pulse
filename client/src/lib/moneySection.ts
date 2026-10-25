// The Money section of the create wizard and the Controls sheet: Paid room and Spray switches plus one readiness checklist.
// Pure: no React, no network. The server (canSellTickets / canEnableSpray) is the gate; this only explains it up front.

export interface MoneyReadiness { adult: boolean; idVerified: boolean; payoutAccount: boolean }
export interface MoneyFlags { paidRooms: boolean; spray: boolean }

export type MoneyItemId = "adult" | "idVerified" | "payoutAccount" | "adultRoom" | "platform";
export interface MoneyItem { id: MoneyItemId; label: string; met: boolean; why: string | null; fix: { href: string; label: string } | null }
export interface MoneySwitch { available: boolean; reason: string | null }
export interface MoneyView {
  /** False while both platform flags are off: nothing at all is drawn. */
  visible: boolean;
  /** Set for a room that is not 18+/21+ (or a minors' room): the whole section is locked with this line. */
  lockedReason: string | null;
  items: MoneyItem[];
  paid: MoneySwitch;
  spray: MoneySwitch;
}

export const MONEY_COPY = {
  title: "Money",
  intro: "Sell tickets or take spray in an adult room.",
  paidLabel: "Paid room",
  paidHelp: "Guests buy a ticket to get in. You set the price next.",
  sprayLabel: "Spray",
  sprayHelp: "Guests can tip you while you are live.",
  sprayNote: "Spray is non-refundable for people who tip.",
  notSwitchedOn: "Not switched on yet",
  lockedAge: "Change the room to 18+ to sell tickets or take spray",
  checklistTitle: "What you need first",
  met: "Done",
  unmet: "Needed",
  paidFixedInRoom: "The ticket price is set when the room is created.",
  confirmOffTitle: "Turn spray off?",
  confirmOffBody: "People can't tip once this is off.",
  confirmOffGo: "Turn off",
  confirmOffStay: "Keep it on",
  saveFailed: "Couldn't change spray. Try again.",
} as const;

const SETTINGS = "/account/settings";
const PAYOUTS = "/rooms/payouts";

export const isAdultAge = (ageLimit: string) => ageLimit === "18+" || ageLimit === "21+";

/** `readiness` is GET /api/rooms/config hostMoneyReadiness; missing means nothing is known to be met. */
export function moneyView(v: { flags: MoneyFlags | null | undefined; readiness: MoneyReadiness | null | undefined; ageLimit: string; minorsRoom?: boolean }): MoneyView {
  const flags = v.flags ?? { paidRooms: false, spray: false };
  const r = v.readiness ?? { adult: false, idVerified: false, payoutAccount: false };
  const visible = flags.paidRooms || flags.spray;
  const adultRoom = isAdultAge(v.ageLimit) && v.minorsRoom !== true;
  const lockedReason = visible && !adultRoom ? MONEY_COPY.lockedAge : null;
  const off = [!flags.paidRooms && "Paid rooms", !flags.spray && "Spray"].filter(Boolean) as string[];
  const items: MoneyItem[] = [
    { id: "adult", label: "You are 18 or over", met: r.adult, why: r.adult ? null : "Add a date of birth that shows you are an adult.", fix: r.adult ? null : { href: SETTINGS, label: "Open account settings" } },
    { id: "idVerified", label: "Your ID is verified", met: r.idVerified, why: r.idVerified ? null : "Only ID-verified adults can take money.", fix: r.idVerified ? null : { href: SETTINGS, label: "Verify your ID in account settings" } },
    { id: "payoutAccount", label: "A payout account is added", met: r.payoutAccount, why: r.payoutAccount ? null : "Add a bank account in your own name so we can pay you.", fix: r.payoutAccount ? null : { href: PAYOUTS, label: "Add a payout account" } },
    { id: "adultRoom", label: "The room is 18+ or 21+", met: adultRoom, why: adultRoom ? null : MONEY_COPY.lockedAge, fix: null },
    { id: "platform", label: "Switched on by Vib3Pulse", met: off.length === 0, why: off.length === 0 ? null : `${off.join(" and ")} ${off.length > 1 ? "are" : "is"} not switched on yet.`, fix: null },
  ];
  const ready = lockedReason === null && r.adult && r.idVerified && r.payoutAccount;
  const firstUnmet = lockedReason ?? (!r.adult ? items[0].why : !r.idVerified ? items[1].why : !r.payoutAccount ? items[2].why : null);
  const sw = (flagOn: boolean): MoneySwitch =>
    !flagOn ? { available: false, reason: MONEY_COPY.notSwitchedOn } : ready ? { available: true, reason: null } : { available: false, reason: firstUnmet };
  return { visible, lockedReason, items, paid: sw(flags.paidRooms), spray: sw(flags.spray) };
}

/** What the server's refusal of a create or a PATCH means for the Money section (null when the code is not one of these). */
const REFUSAL: Record<string, string> = {
  FEATURE_OFF: "Not switched on yet.",
  HOST_NOT_ADULT: "You need to be 18 or over to turn this on.",
  HOST_NOT_VERIFIED: "Verify your ID to turn this on.",
  NO_PAYOUT_ACCOUNT: "Add a payout account to turn this on.",
  ROOM_NOT_ADULT: MONEY_COPY.lockedAge,
};
export const moneyRefusal = (code: string | undefined): string | null => (code && REFUSAL[code]) || null;

/** Spray-only shape of the create payload field: sent only when switched on and the platform flag is on. */
export const sprayPayload = (on: boolean | undefined, sprayFlag: boolean): { sprayEnabled: true } | Record<string, never> =>
  on === true && sprayFlag ? { sprayEnabled: true } : {};
