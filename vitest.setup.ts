import { vi } from 'vitest';

vi.mock('bun', () => ({
  spawn: vi.fn(),
}));
