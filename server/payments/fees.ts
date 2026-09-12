// Platform commission calculation — the one place fee math happens, used
// identically regardless of who bears the fee. See shared/schema.ts
// events.feePassthroughToBuyer for what the two modes mean.

export interface FeeSplitParams {
  baseAmount: number; // smallest currency unit (pence / kobo)
  commissionBps: number; // 1000 = 10%
  passthroughToBuyer: boolean;
}

export interface FeeSplitResult {
  buyerCharge: number; // what the buyer is actually charged
  platformFee: number; // the platform's cut
  organizerNet: number; // what the organizer is owed
}

export function computeFeeSplit({ baseAmount, commissionBps, passthroughToBuyer }: FeeSplitParams): FeeSplitResult {
  const platformFee = Math.round((baseAmount * commissionBps) / 10000);

  if (passthroughToBuyer) {
    // Buyer pays the listed price plus the fee; organizer nets the full listed price.
    return { buyerCharge: baseAmount + platformFee, platformFee, organizerNet: baseAmount };
  }

  // Buyer pays exactly the listed price; the fee comes out of the organizer's share.
  return { buyerCharge: baseAmount, platformFee, organizerNet: baseAmount - platformFee };
}
