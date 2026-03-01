const log = require("./logger").child({ module: "scheduler" });

const jobs = [];
let running = false;

function schedule(name, intervalMs, fn) {
  jobs.push({ name, intervalMs, fn, timer: null, lastRun: 0, running: false });
}

function startAll() {
  if (running) return;
  running = true;
  for (const job of jobs) {
    log.info({ job: job.name, intervalMin: Math.round(job.intervalMs / 60000) }, "Scheduled job registered");
    job.timer = setInterval(async () => {
      if (job.running) return;
      job.running = true;
      const start = Date.now();
      try {
        await job.fn();
        job.lastRun = Date.now();
        log.debug({ job: job.name, durationMs: Date.now() - start }, "Job completed");
      } catch (e) {
        log.error({ err: e, job: job.name }, "Job failed");
      } finally {
        job.running = false;
      }
    }, job.intervalMs);
  }
}

function stopAll() {
  running = false;
  for (const job of jobs) {
    if (job.timer) clearInterval(job.timer);
    job.timer = null;
  }
}

function getJobStats() {
  return jobs.map(j => ({
    name: j.name,
    intervalMin: Math.round(j.intervalMs / 60000),
    lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
    running: j.running,
  }));
}

module.exports = { schedule, startAll, stopAll, getJobStats };
