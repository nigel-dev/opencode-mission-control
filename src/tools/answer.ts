import { z } from 'zod';
import { getJobByName } from '../lib/job-state';
import { getPendingQuestionsForJob } from '../lib/question-relay';
import { promptJobSession } from '../lib/job-runtime';
import { writeReport } from '../lib/reports';

export const mc_answer = {
  name: 'mc_answer',
  description:
    'Send an answer or further instructions to a running background job. Use this when a job reports it is blocked or needs input: the message is delivered to the job\'s session and resumes it.',
  input: z.object({
    name: z.string().describe('Job name to answer'),
    response: z.string().describe('Your answer or instructions for the job\'s agent.'),
  }).strict(),
  async execute(args: { name: string; response: string }) {
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found.`);
    }

    if (job.status !== 'running') {
      throw new Error(`Job "${args.name}" is not running (status: ${job.status}).`);
    }

    if (!job.sessionID) {
      throw new Error(`Job "${args.name}" has no session to answer.`);
    }

    if (getPendingQuestionsForJob(job.id).length > 0) {
      throw new Error(
        `Job "${args.name}" is waiting on an interactive question form, which can only be answered in its own session. Open it with mc_attach(name: "${args.name}").`,
      );
    }

    // Deliver the answer first. Only once the session has it may the
    // "blocked" report be superseded: if the report went first and the prompt
    // then failed (or a monitor pass ran in between), the job would be idle
    // without a blocked report and be taken for finished.
    await promptJobSession(job.sessionID, args.response);

    await writeReport({
      jobId: job.id,
      jobName: job.name,
      status: 'working',
      message: 'Answer received',
      timestamp: new Date().toISOString(),
    });

    return { content: `Answer sent to job "${args.name}": "${args.response}"` };
  },
};
