// Token bucket: `burst` tokens, refilled at `ratePerSec`. take() spends one or says no.
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private ratePerSec: number, private burst: number, private now: () => number = Date.now) {
    this.tokens = burst;
    this.last = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
