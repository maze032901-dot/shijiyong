/**
 * A captured job has already been acknowledged to the cloud. A local evidence
 * or publishing error must be recorded for that job without stopping later jobs.
 */
export async function drainAvailableJobs({ nextJob, afterJob, onJobError }) {
  while (true) {
    const outcome = await nextJob();
    if (outcome.kind === 'idle') return;
    try {
      await afterJob(outcome);
    } catch (error) {
      await onJobError(outcome, error);
    }
  }
}
