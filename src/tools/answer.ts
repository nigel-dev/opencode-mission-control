import { z } from 'zod';
import { getJobByName } from '../lib/job-state';
import {
  findPendingQuestionByJobName,
  answerPendingQuestion,
  getPendingQuestionsForJob,
} from '../lib/question-relay';
import { loadConfig } from '../lib/config';

export const mc_answer = {
  name: 'mc_answer',
  description:
    'Answer a pending question from a background job. When a serve-mode job\'s agent asks a question via mcp_question, it gets relayed to this session. Use this tool to respond and unblock the agent.',
  input: z.object({
    name: z.string().describe('Job name that asked the question'),
    response: z.string().describe('Your answer to the question. For option-based questions, provide the option label(s). For open-ended questions, provide your response text.'),
  }).strict(),
  async execute(args: { name: string; response: string }) {
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found.`);
    }

    if (job.status !== 'running') {
      throw new Error(`Job "${args.name}" is not running (status: ${job.status}).`);
    }

    if (!job.remoteSessionID || !job.port) {
      throw new Error(`Job "${args.name}" is not a serve-mode job or missing session info.`);
    }

    const pending = findPendingQuestionByJobName(args.name);
    if (!pending) {
      const allForJob = getPendingQuestionsForJob(job.id);
      if (allForJob.length === 0) {
        throw new Error(`No pending question found for job "${args.name}". The question may have already been answered or timed out.`);
      }
    }

    const config = await loadConfig();
    const question = pending ?? {
      jobId: job.id,
      jobName: job.name,
      taskSummary: '',
      partId: 'direct',
      callID: 'direct',
      remoteSessionID: job.remoteSessionID,
      port: job.port,
      question: '',
      options: [],
      detectedAt: Date.now(),
    };

    await answerPendingQuestion(question, args.response, question.serverPassword ?? config.serverPassword);

    return { content: `Answer sent to job "${args.name}": "${args.response}"` };
  },
};
