import { join } from 'path';
import { getDataDir } from './paths';

export type ReportStatus = 'working' | 'blocked' | 'needs_review' | 'completed' | 'progress';

export interface AgentReport {
  jobId: string;
  jobName: string;
  status: ReportStatus;
  message: string;
  progress?: number;
  timestamp: string;
}

async function getReportsDir(): Promise<string> {
  const dataDir = await getDataDir();
  const reportsDir = join(dataDir, '..', 'reports');
  const fs = await import('fs');
  fs.mkdirSync(reportsDir, { recursive: true });
  return reportsDir;
}

function getReportFilePath(reportsDir: string, jobId: string): string {
  return join(reportsDir, `${jobId}.json`);
}

export async function writeReport(report: AgentReport): Promise<void> {
  const reportsDir = await getReportsDir();
  const filePath = getReportFilePath(reportsDir, report.jobId);
  const tempPath = `${filePath}.tmp`;
  const data = JSON.stringify(report, null, 2);
  await Bun.write(tempPath, data);
  const fs = await import('fs');
  fs.renameSync(tempPath, filePath);
}

export async function readReport(jobId: string): Promise<AgentReport | null> {
  const reportsDir = await getReportsDir();
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
    return null;
  }
}

export async function readAllReports(): Promise<AgentReport[]> {
  const reportsDir = await getReportsDir();
  const fs = await import('fs');

  let entries: string[];
  try {
    entries = fs.readdirSync(reportsDir);
  } catch {
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
  const fs = await import('fs');

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
