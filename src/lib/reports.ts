import * as fs from 'fs';
import { join } from 'path';
import { getDataDir } from './paths';
import { atomicWrite } from './utils';

export type ReportStatus = 'working' | 'blocked' | 'needs_review' | 'completed' | 'progress';

export interface AgentReport {
  jobId: string;
  jobName: string;
  status: ReportStatus;
  message: string;
  progress?: number;
  timestamp: string;
}

async function getReportsDir(cwd?: string): Promise<string> {
  const dataDir = await getDataDir(cwd);
  const reportsDir = join(dataDir, '..', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  return reportsDir;
}

function getReportFilePath(reportsDir: string, jobId: string): string {
  return join(reportsDir, `${jobId}.json`);
}

export async function writeReport(report: AgentReport, cwd?: string): Promise<void> {
  const reportsDir = await getReportsDir(cwd);
  const filePath = getReportFilePath(reportsDir, report.jobId);
  // A unique temp file per write: the job (mc_report) and the command center
  // (mc_answer) can write the same job's report at the same time.
  await atomicWrite(filePath, JSON.stringify(report, null, 2));
}

export async function readReport(jobId: string, cwd?: string): Promise<AgentReport | null> {
  const reportsDir = await getReportsDir(cwd);
  const filePath = getReportFilePath(reportsDir, jobId);
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return null;
  }

  try {
    const content = await file.text();
    return JSON.parse(content) as AgentReport;
  } catch {
    // An unreadable report counts as no report: the agent's next mc_report
    // replaces it, and the session's own outcome still finishes the job.
    return null;
  }
}

export async function readAllReports(): Promise<AgentReport[]> {
  const reportsDir = await getReportsDir();

  let entries: string[];
  try {
    entries = fs.readdirSync(reportsDir);
  } catch (error) {
    console.warn(`[Mission Control] Could not list reports in ${reportsDir}:`, error);
    return [];
  }

  const reports: AgentReport[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.tmp')) {
      continue;
    }

    const filePath = join(reportsDir, entry);
    try {
      const file = Bun.file(filePath);
      const content = await file.text();
      const report = JSON.parse(content) as AgentReport;
      reports.push(report);
    } catch {
      // Skip malformed report files
    }
  }

  return reports;
}

export async function removeReport(jobId: string): Promise<void> {
  const reportsDir = await getReportsDir();
  const filePath = getReportFilePath(reportsDir, jobId);

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return; // File doesn't exist, nothing to remove
    }
    throw error;
  }
}
