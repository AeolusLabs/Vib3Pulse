import { useAgeReview } from "@/hooks/useAgeReview";
import { COPY, VERIFY_HREF } from "@/lib/ageReview";

/** "Verify your age" pointer for blocked states. Hidden while the feature is off, so nothing changes until AGE_REVIEW is on. */
export default function VerifyAgeLink({ className = "" }: { className?: string }) {
  const { me } = useAgeReview();
  if (!me || me.state === "verified" || me.state === "not_offered") return null;
  return (
    <a
      href={VERIFY_HREF}
      className={`inline-flex min-h-[44px] items-center text-sm font-medium text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${className}`}
      data-testid="link-verify-age"
    >{COPY.verifyLink}</a>
  );
}
