//! A download speed limit, shared by every worker and adjustable while running.
//!
//! The point is the "while running" part. A limit you can only set before
//! starting is useless in the situation that calls for one - the download is
//! already going and something else on the machine now needs the connection.
//! So the limit is an atomic that any thread can rewrite, and the workers pick
//! up the new value on their next chunk.
//!
//! It is a token bucket. Tokens accrue at the limit and each chunk spends what
//! it weighs; a worker that cannot pay waits. Crucially the balance is allowed
//! to go negative, which is what makes it correct with eight workers: each one
//! borrows what it needs, sleeps off exactly its own share of the debt, and the
//! total never exceeds the rate. Refusing to lend instead would have them all
//! wake together, re-check, and thunder.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How much unspent allowance can accumulate, in seconds of it.
///
/// This is what lets a download that has been idle for a moment burst back to
/// speed instead of easing in. One second is enough to feel immediate without
/// letting a long pause bank a spike that overshoots the limit visibly.
const BURST_SECONDS: f64 = 1.0;

pub struct RateLimiter {
    /// Bytes per second. Zero means no limit, which is the default and costs
    /// nothing to check.
    limit: AtomicU64,
    bucket: Mutex<Bucket>,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self {
            limit: AtomicU64::new(0),
            bucket: Mutex::new(Bucket {
                tokens: 0.0,
                last: Instant::now(),
            }),
        }
    }
}

impl RateLimiter {
    /// Set the ceiling in bytes per second, or 0 to remove it.
    pub fn set(&self, bytes_per_second: u64) {
        let previous = self.limit.swap(bytes_per_second, Ordering::Relaxed);
        if previous == 0 && bytes_per_second > 0 {
            // Coming from unlimited, the bucket holds a stale timestamp from
            // whenever it was last used. Without resetting, the first chunk
            // would be credited with every second since then and sail through.
            if let Ok(mut bucket) = self.bucket.lock() {
                bucket.tokens = bytes_per_second as f64 * BURST_SECONDS;
                bucket.last = Instant::now();
            }
        }
    }

    /// Wait until `bytes` may be spent.
    pub async fn take(&self, bytes: u64) {
        let limit = self.limit.load(Ordering::Relaxed);
        if limit == 0 {
            return;
        }

        let wait = {
            let Ok(mut bucket) = self.bucket.lock() else {
                return; // A poisoned lock must not stall the download.
            };
            let now = Instant::now();
            let elapsed = now.duration_since(bucket.last).as_secs_f64();
            bucket.last = now;

            let rate = limit as f64;
            bucket.tokens = (bucket.tokens + elapsed * rate).min(rate * BURST_SECONDS);

            let owed = bytes as f64 - bucket.tokens;
            // Spend regardless, going into debt if need be, so the wait each
            // worker computes is its own and the arithmetic stays honest no
            // matter how large a chunk arrives.
            bucket.tokens -= bytes as f64;
            if owed > 0.0 {
                owed / rate
            } else {
                0.0
            }
        };

        if wait > 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(wait)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_limit_means_no_waiting() {
        let limiter = RateLimiter::default();
        let started = Instant::now();
        for _ in 0..50 {
            limiter.take(1_000_000).await;
        }
        assert!(started.elapsed() < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn spending_the_burst_is_free_and_the_rest_is_paced() {
        // 1 MB/s with a one-second burst: the first megabyte is immediate,
        // and the next costs about a second.
        let limiter = RateLimiter::default();
        limiter.set(1_000_000);

        let started = Instant::now();
        limiter.take(1_000_000).await;
        assert!(started.elapsed() < Duration::from_millis(100), "burst should be free");

        let started = Instant::now();
        limiter.take(1_000_000).await;
        let waited = started.elapsed();
        assert!(waited > Duration::from_millis(700), "waited only {waited:?}");
        assert!(waited < Duration::from_millis(1600), "waited {waited:?}");
    }

    /// The case the whole module exists for: eight workers sharing one ceiling.
    ///
    /// Sixteen chunks of 250 KB is 4 MB. At 2 MB/s the burst covers the first
    /// 2 MB - one second of allowance - and the remaining 2 MB is paid for at
    /// the limit, so the whole thing should take about a second. If the workers
    /// each got their own bucket it would finish in a fraction of that.
    #[tokio::test]
    async fn concurrent_workers_share_one_ceiling() {
        let limiter = std::sync::Arc::new(RateLimiter::default());
        limiter.set(2_000_000);

        let started = Instant::now();
        let mut workers = Vec::new();
        for _ in 0..8 {
            let limiter = limiter.clone();
            workers.push(tokio::spawn(async move {
                for _ in 0..2 {
                    limiter.take(250_000).await;
                }
            }));
        }
        for worker in workers {
            worker.await.unwrap();
        }

        let waited = started.elapsed();
        assert!(waited > Duration::from_millis(800), "too fast: {waited:?}");
        assert!(waited < Duration::from_millis(1600), "too slow: {waited:?}");
    }

    /// Switching from unlimited must not hand the first chunk a windfall of
    /// tokens for all the time the limiter was idle.
    #[tokio::test]
    async fn turning_a_limit_on_does_not_credit_idle_time() {
        let limiter = RateLimiter::default();
        limiter.take(10).await; // Stamps the bucket, then sits.
        tokio::time::sleep(Duration::from_millis(300)).await;
        limiter.set(1_000_000);

        limiter.take(1_000_000).await; // Spends exactly the burst.
        let started = Instant::now();
        limiter.take(500_000).await;
        assert!(
            started.elapsed() > Duration::from_millis(300),
            "idle time was credited: {:?}",
            started.elapsed()
        );
    }
}
