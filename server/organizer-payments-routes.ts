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

// ============================================================
// ORGANIZER PAYOUT ONBOARDING (Phase 2)
// ============================================================
// Paystack Subaccounts today; Stripe Connect Express follows the same shape
// once those keys are added. Nothing here touches the checkout/charge flow
// yet — this only lets an organizer register where their money should go.

export function registerOrganizerPaymentsRoutes(app: Express): void {
  app.get("/api/organizer/payments/status", requireOrganizer, async (req: Request, res: Response) => {
    try {
      const [stripeAccount, paystackAccount] = await Promise.all([
        storage.getOrganizerPaymentAccount(req.user!.id, "stripe"),
        storage.getOrganizerPaymentAccount(req.user!.id, "paystack"),
      ]);

      res.json({
        stripe: stripeAccount
          ? { detailsSubmitted: stripeAccount.detailsSubmitted, payoutsEnabled: stripeAccount.payoutsEnabled }
          : null,
        paystack: paystackAccount
          ? { detailsSubmitted: paystackAccount.detailsSubmitted, payoutsEnabled: paystackAccount.payoutsEnabled }
          : null,
      });
    } catch (error) {
      console.error("[OrganizerPayments] status error:", error);
      res.status(500).json({ message: "Failed to load payout status" });
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
