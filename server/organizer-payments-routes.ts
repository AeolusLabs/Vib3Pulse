import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "./storage.js";
import { requireOrganizer } from "./middleware.js";
import { sensitiveOperationLimiter } from "./security.js";
import {
  listPaystackBanks,
  resolvePaystackBankAccount,
  createPaystackSubaccount,
} from "./payments/paystack.js";
import {
  createStripeConnectAccount,
  createStripeAccountLink,
  getStripeConnectStatus,
} from "./payments/stripe.js";

// ============================================================
// ORGANIZER PAYOUT ONBOARDING (Phase 2, Stripe added Phase 4)
// ============================================================
// Paystack Subaccounts and Stripe Connect Express, same onboarding shape.
// Nothing here touches the checkout/charge flow — this only lets an
// organizer register where their money should go and see its real status;
// see the scope note on the Stripe Connect functions in payments/stripe.ts.

function baseUrlFor(req: Request): string {
  return process.env.APP_URL || `${req.protocol}://${req.headers.host}`;
}

export function registerOrganizerPaymentsRoutes(app: Express): void {
  app.get("/api/organizer/payments/status", requireOrganizer, async (req: Request, res: Response) => {
    try {
      const [stripeAccount, paystackAccount] = await Promise.all([
        storage.getOrganizerPaymentAccount(req.user!.id, "stripe"),
        storage.getOrganizerPaymentAccount(req.user!.id, "paystack"),
      ]);

      // Stripe doesn't push onboarding completion to us synchronously (no
      // webhook wired up for account.updated) — refresh live from the API on
      // every status check instead, and persist it so the rest of the app
      // (e.g. the payout guardrail in payment-routes.ts, once charge-splitting
      // lands) reads a value that's at most one page-load stale.
      let stripeStatus: { detailsSubmitted: boolean; payoutsEnabled: boolean; payoutSchedule?: string } | null = null;
      if (stripeAccount?.stripeAccountId) {
        try {
          const live = await getStripeConnectStatus(stripeAccount.stripeAccountId);
          await storage.upsertOrganizerPaymentAccount({
            userId: req.user!.id,
            provider: "stripe",
            stripeAccountId: stripeAccount.stripeAccountId,
            detailsSubmitted: live.detailsSubmitted,
            payoutsEnabled: live.payoutsEnabled,
          });
          stripeStatus = {
            detailsSubmitted: live.detailsSubmitted,
            payoutsEnabled: live.payoutsEnabled,
            payoutSchedule: live.payoutScheduleInterval
              ? live.payoutScheduleInterval === "manual"
                ? "Manual — you trigger payouts yourself from Stripe"
                : live.payoutScheduleDelayDays
                  ? `Every ${live.payoutScheduleInterval === "daily" ? "day" : live.payoutScheduleInterval}, ${live.payoutScheduleDelayDays}-day rolling delay`
                  : `Every ${live.payoutScheduleInterval === "daily" ? "day" : live.payoutScheduleInterval}`
              : undefined,
          };
        } catch (err) {
          console.error("[OrganizerPayments] Stripe status refresh failed, falling back to last-known:", err);
          stripeStatus = { detailsSubmitted: stripeAccount.detailsSubmitted, payoutsEnabled: stripeAccount.payoutsEnabled };
        }
      }

      res.json({
        stripe: stripeStatus,
        paystack: paystackAccount
          ? {
              detailsSubmitted: paystackAccount.detailsSubmitted,
              payoutsEnabled: paystackAccount.payoutsEnabled,
              payoutSchedule: "Settles automatically to your bank — Paystack's standard schedule (typically within 24 hours of a sale)",
            }
          : null,
      });
    } catch (error) {
      console.error("[OrganizerPayments] status error:", error);
      res.status(500).json({ message: "Failed to load payout status" });
    }
  });

  // Kicks off (or resumes) Stripe Connect Express onboarding and returns the
  // Stripe-hosted onboarding URL to redirect the organizer to.
  app.post("/api/organizer/payments/stripe/onboard", requireOrganizer, sensitiveOperationLimiter, async (req: Request, res: Response) => {
    try {
      let account = await storage.getOrganizerPaymentAccount(req.user!.id, "stripe");

      if (!account?.stripeAccountId) {
        const { accountId } = await createStripeConnectAccount(req.user!.email);
        account = await storage.upsertOrganizerPaymentAccount({
          userId: req.user!.id,
          provider: "stripe",
          stripeAccountId: accountId,
          detailsSubmitted: false,
          payoutsEnabled: false,
        });
      }

      const base = baseUrlFor(req);
      const { url } = await createStripeAccountLink(
        account.stripeAccountId!,
        `${base}/organizer/payouts?stripe=refresh`,
        `${base}/organizer/payouts?stripe=return`,
      );

      res.json({ url });
    } catch (error) {
      console.error("[OrganizerPayments] Stripe onboarding error:", error);
      res.status(500).json({ message: "Could not start Stripe onboarding — please try again." });
    }
  });

  // Payout history — both providers, most recent first.
  app.get("/api/organizer/payments/transactions", requireOrganizer, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const offset = Number(req.query.offset) || 0;
      const transactions = await storage.getOrganizerTransactions(req.user!.id, limit, offset);
      res.json({ transactions });
    } catch (error) {
      console.error("[OrganizerPayments] transactions error:", error);
      res.status(500).json({ message: "Failed to load payout history" });
    }
  });

  app.get("/api/organizer/payments/paystack/banks", requireOrganizer, async (req: Request, res: Response) => {
    try {
      const banks = await listPaystackBanks();
      res.json({ banks });
    } catch (error) {
      console.error("[OrganizerPayments] list banks error:", error);
      res.status(500).json({ message: "Failed to load bank list" });
    }
  });

  app.post("/api/organizer/payments/paystack/resolve-account", requireOrganizer, sensitiveOperationLimiter, async (req: Request, res: Response) => {
    try {
      const { accountNumber, bankCode } = z.object({
        accountNumber: z.string().min(5).max(20),
        bankCode: z.string().min(1),
      }).parse(req.body);

      const resolved = await resolvePaystackBankAccount(accountNumber, bankCode);
      res.json(resolved);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "accountNumber and bankCode are required" });
      }
      console.error("[OrganizerPayments] resolve account error:", error);
      res.status(400).json({ message: "Could not verify that account — double check the account number and bank." });
    }
  });

  app.post("/api/organizer/payments/paystack/onboard", requireOrganizer, sensitiveOperationLimiter, async (req: Request, res: Response) => {
    try {
      const { accountNumber, bankCode, businessName } = z.object({
        accountNumber: z.string().min(5).max(20),
        bankCode: z.string().min(1),
        businessName: z.string().min(1).max(255),
      }).parse(req.body);

      // Re-resolve server-side — never trust a client-supplied account name.
      const resolved = await resolvePaystackBankAccount(accountNumber, bankCode);

      const commissionBps = await storage.getPlatformCommissionBps();
      const { subaccountCode } = await createPaystackSubaccount({
        businessName,
        bankCode,
        accountNumber,
        percentageCharge: commissionBps / 100,
      });

      const account = await storage.upsertOrganizerPaymentAccount({
        userId: req.user!.id,
        provider: "paystack",
        paystackSubaccountCode: subaccountCode,
        detailsSubmitted: true,
        // Paystack subaccounts are usable immediately — no review step like
        // Stripe Connect Express, so payouts are enabled as soon as it's created.
        payoutsEnabled: true,
      });

      res.json({
        message: "Payout account connected",
        accountName: resolved.accountName,
        payoutsEnabled: account.payoutsEnabled,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "accountNumber, bankCode, and businessName are required" });
      }
      console.error("[OrganizerPayments] onboarding error:", error);
      res.status(400).json({ message: "Could not connect your payout account — check your bank details and try again." });
    }
  });
}
