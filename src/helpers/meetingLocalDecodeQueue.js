// Stop must wait for a running decode, then consume audio that arrived while
// it was busy. Timer ticks may coalesce; the final drain may not be skipped.
function createMeetingLocalDecodeQueue(decode) {
  let active = null;
  return {
    async settle() {
      await active;
    },
    async run({ drain = false } = {}) {
      if (active) {
        if (!drain) return;
        await active;
      }
      const job = Promise.resolve().then(decode);
      active = job;
      try {
        await job;
      } finally {
        if (active === job) active = null;
      }
    },
  };
}
module.exports = { createMeetingLocalDecodeQueue };
